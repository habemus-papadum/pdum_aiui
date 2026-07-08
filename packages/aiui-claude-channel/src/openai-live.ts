/**
 * The realtime submode's **degraded engine** — an OpenAI `gpt-realtime-2` session
 * behind the {@link ./live-session}.LiveSession seam.
 *
 * Where {@link ./gemini-live} is the reference (video, one streaming image path,
 * session resumption), OpenAI realtime runs the same submode without video and
 * with images injected as **turn-boundary items**, not a stream (§2/§8 of
 * transcription-and-realtime-submodes.md). It is structurally the flagship voice
 * session ({@link ./realtime-voice}) — same PCM-append / manual-commit shape, same
 * WAV-wrapped reply clips — with three additions the submode needs and flagship
 * lacks: the `submit_intent` tool (so the *model* composes), `input_image`
 * injection, and the tool-call drain. It is a **separate** engine, not an edit to
 * realtime-voice.ts: flagship (voice veneer over transcription mode) must keep
 * working untouched.
 *
 * ### Wire surface (GA realtime; verified shape mirrors realtime-voice.ts)
 *
 *  - **Endpoint:** `wss://api.openai.com/v1/realtime?model=…` (bearer auth).
 *  - **Configure:** one `session.update` — `type: "realtime"`, model, the composer
 *    persona, `output_modalities: ["audio"]`, `audio.input` = pcm/24k +
 *    transcription + `turn_detection: null` (manual, PTT is the boundary),
 *    `audio.output` = pcm/24k + voice, and `tools: [submit_intent]`.
 *  - **A talk window:** {@link activityStart} is a no-op (OpenAI opens the buffer on
 *    the first append); {@link activityEnd} = `input_audio_buffer.commit` +
 *    `response.create`.
 *  - **Images:** `conversation.item.create` with an `input_text` label part and an
 *    `input_image` data-URL part (finding 8) — items never auto-trigger a response.
 *  - **Silent context (selections):** an `input_text` item alone — no
 *    `response.create`, so nothing is spoken back.
 *  - **The nudge:** an `input_text` item + `response.create`.
 *  - **The call:** a `function_call` item in `response.done.response.output`; its
 *    `arguments` (a JSON string) parse to `{ segments }`. `respond` writes a
 *    `function_call_output` item — terminal for our flow (we close right after).
 *  - **Back:** `conversation.item.input_audio_transcription.completed` (the user
 *    transcript), `response.output_audio.delta`/`.done` (reply audio),
 *    `response.output_audio_transcript.done` (reply transcript), `response.done`
 *    (usage + the tool call).
 *
 * The upstream socket is injectable so the tests drive a scripted fake with no
 * network and no key (the house pattern).
 */
import { priceCall, usageFromRealtimeResponse } from "./cost";
import {
  LIVE_COMPOSER_INSTRUCTIONS,
  LIVE_NUDGE_TEXT,
  type LiveCapabilities,
  type LiveSession,
  type LiveSessionCallbacks,
  type SubmitIntentCall,
} from "./live-session";
import {
  closeSuffix,
  openaiRealtimeSocketFactory,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
} from "./realtime";
import {
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_VOICE_URL,
  pcm16ToWav,
  REALTIME_VOICE_RATE,
} from "./realtime-voice";

/** The flagship conversational model, degraded to the realtime submode's composer. */
export const DEFAULT_OPENAI_LIVE_MODEL = "gpt-realtime-2";

/** The `submit_intent` tool as GA realtime declares it (standard JSON Schema). */
const SUBMIT_INTENT_TOOL = {
  type: "function",
  name: "submit_intent",
  description: "Deliver the composed request to the coding agent as interleaved segments.",
  parameters: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            image: { type: "string" },
            selection: { type: "string" },
          },
        },
      },
    },
    required: ["segments"],
  },
} as const;

/** OpenAI's capability grade: no video, images inject as turn-boundary items. */
const OPENAI_CAPABILITIES: LiveCapabilities = { video: false, imageInjection: "turn-item" };

export interface OpenAiLiveSessionOptions {
  apiKey: string;
  /** Resolves the conversational model (e.g. `gpt-realtime-2`) at open time. */
  model: () => string;
  /** Resolves the output voice id (undefined → the model default). */
  voice?: () => string | undefined;
  /** Resolves the input-transcription model (feeds the chronicle). */
  transcriptionModel?: () => string;
  /**
   * The composer persona (short — billed every turn). Default:
   * {@link LIVE_COMPOSER_INSTRUCTIONS}, the shared authoritative text.
   */
  instructions?: string;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory (via realtime.ts). */
  socketFactory?: RealtimeSocketFactory;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

/**
 * Open an OpenAI realtime session under the {@link LiveSession} seam. Eagerly
 * connects (the handshake overlaps the arm→talk gap); audio queued before
 * `session.updated` is flushed once ready. Structurally mirrors
 * {@link ./realtime-voice}.openRealtimeVoiceSession's lifecycle.
 */
export function openOpenAiLiveSession(
  options: OpenAiLiveSessionOptions,
  callbacks: LiveSessionCallbacks,
): LiveSession {
  // The real socket factory is realtime.ts's bearer-authed `ws` (same auth, same
  // wiring as flagship); a test injects a scripted fake instead.
  const factory = options.socketFactory ?? openaiRealtimeSocketFactory;
  const modelName = options.model();
  const baseUrl = options.url ?? OPENAI_REALTIME_VOICE_URL;
  const url = baseUrl.includes("?")
    ? `${baseUrl}&model=${encodeURIComponent(modelName)}`
    : `${baseUrl}?model=${encodeURIComponent(modelName)}`;

  let ready = false;
  let dead = false;
  const outbox: string[] = [];

  // Reply state, keyed by the upstream response id.
  const audioByResponse = new Map<string, Uint8Array[]>();
  const transcriptByResponse = new Map<string, string>();

  // The tool-call drain (same buffering contract as gemini-live).
  let bufferedCall: SubmitIntentCall | null = null;
  let drainResolver: ((call: SubmitIntentCall | null) => void) | null = null;

  const settleDrain = (call: SubmitIntentCall | null): void => {
    if (drainResolver) {
      const resolve = drainResolver;
      drainResolver = null;
      resolve(call);
    } else {
      bufferedCall = call;
    }
  };

  const sendReady = (message: object): void => {
    const text = JSON.stringify(message);
    if (ready && !dead) {
      socket.send(text);
    } else if (!dead) {
      outbox.push(text);
    }
  };

  const fail = (message: string, data?: unknown): void => {
    if (dead) {
      return;
    }
    dead = true;
    callbacks.onError(message, data);
    settleDrain(null);
  };

  /** A finished response's buffered audio (WAV-wrapped) + its transcript. */
  const flushResponse = (responseId: string): void => {
    const chunks = audioByResponse.get(responseId);
    audioByResponse.delete(responseId);
    if (chunks && chunks.length > 0) {
      callbacks.onReplyAudio(pcm16ToWav(concatChunks(chunks), REALTIME_VOICE_RATE), "audio/wav");
    }
    const transcript = transcriptByResponse.get(responseId);
    transcriptByResponse.delete(responseId);
    if (transcript && transcript.trim() !== "") {
      callbacks.onReplyTranscript(transcript.trim());
    }
  };

  const buildToolCall = (item: {
    call_id?: string;
    name?: string;
    arguments?: unknown;
  }): SubmitIntentCall => {
    let parsed: { segments?: unknown } = {};
    if (typeof item.arguments === "string") {
      try {
        parsed = JSON.parse(item.arguments);
      } catch {
        parsed = {};
      }
    }
    const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const segments = rawSegments.map((s) => {
      const seg = (s ?? {}) as { text?: unknown; image?: unknown; selection?: unknown };
      return {
        ...(typeof seg.text === "string" ? { text: seg.text } : {}),
        ...(typeof seg.image === "string" ? { image: seg.image } : {}),
        ...(typeof seg.selection === "string" ? { selection: seg.selection } : {}),
      };
    });
    let responded = false;
    return {
      segments,
      respond: (ok: boolean) => {
        if (responded || dead) {
          return;
        }
        responded = true;
        // Write the tool result — terminal for our flow (we close right after),
        // so no `response.create` chases it.
        sendReady({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: item.call_id,
            output: JSON.stringify({ ok }),
          },
        });
      },
    };
  };

  const handleMessage = (text: string): void => {
    let message: {
      type?: string;
      item_id?: string;
      response_id?: string;
      delta?: string;
      transcript?: string;
      response?: { id?: string; usage?: unknown; output?: unknown[] };
    } & { error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message.type) {
      case "session.updated": {
        ready = true;
        for (const queued of outbox.splice(0)) {
          socket.send(queued);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = message.transcript ?? "";
        if (transcript.trim() !== "") {
          callbacks.onUserTranscript(transcript.trim());
        }
        return;
      }
      case "response.output_audio.delta": {
        const id = message.response_id ?? "";
        const chunks = audioByResponse.get(id) ?? [];
        if (typeof message.delta === "string" && message.delta !== "") {
          chunks.push(fromBase64(message.delta));
        }
        audioByResponse.set(id, chunks);
        return;
      }
      case "response.output_audio_transcript.delta": {
        const id = message.response_id ?? "";
        transcriptByResponse.set(id, (transcriptByResponse.get(id) ?? "") + (message.delta ?? ""));
        return;
      }
      case "response.output_audio_transcript.done": {
        const id = message.response_id ?? "";
        if (typeof message.transcript === "string") {
          transcriptByResponse.set(id, message.transcript);
        }
        return;
      }
      case "response.done": {
        const id = message.response?.id ?? message.response_id ?? "";
        const usage = usageFromRealtimeResponse(message.response?.usage);
        if (usage) {
          callbacks.onUsage(priceCall("openai", options.model(), usage));
        }
        // The model's composition arrives as a function_call item in the output.
        const output = Array.isArray(message.response?.output) ? message.response?.output : [];
        for (const raw of output) {
          const item = (raw ?? {}) as {
            type?: string;
            name?: string;
            call_id?: string;
            arguments?: unknown;
          };
          if (item.type === "function_call" && item.name === "submit_intent") {
            settleDrain(buildToolCall(item));
            break;
          }
        }
        flushResponse(id);
        return;
      }
      case "error": {
        // The full error object (type/code/param) rides as structured data so
        // the client's details expander shows what OpenAI actually returned.
        fail(message.error?.message ?? "openai live session error", message.error);
        return;
      }
      default:
        return;
    }
  };

  const socket = factory(url, options.apiKey, {
    onOpen: () => {
      const voice = options.voice?.();
      const output: Record<string, unknown> = {
        format: { type: "audio/pcm", rate: REALTIME_VOICE_RATE },
      };
      if (typeof voice === "string" && voice !== "") {
        output.voice = voice;
      }
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: options.model(),
            instructions: options.instructions ?? LIVE_COMPOSER_INSTRUCTIONS,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: REALTIME_VOICE_RATE },
                transcription: {
                  model: options.transcriptionModel?.() ?? DEFAULT_VOICE_TRANSCRIPTION_MODEL,
                },
                turn_detection: null,
              },
              output,
            },
            tools: [SUBMIT_INTENT_TOOL],
          },
        }),
      );
    },
    onMessage: handleMessage,
    onError: (message: string, data?: unknown) => fail(message, data),
    onClose: (code?: number, reason?: string) => {
      if (!dead) {
        fail(
          `openai live session closed${closeSuffix(code, reason)}`,
          code !== undefined || (reason !== undefined && reason !== "")
            ? { closeCode: code, closeReason: reason }
            : undefined,
        );
      }
    },
  } satisfies RealtimeSocketHandlers);

  return {
    capabilities: OPENAI_CAPABILITIES,
    activityStart() {
      // No-op: OpenAI opens the input buffer implicitly on the first append.
    },
    appendAudio(pcm24k) {
      if (dead) {
        return;
      }
      sendReady({ type: "input_audio_buffer.append", audio: toBase64(pcm24k) });
    },
    activityEnd() {
      if (dead) {
        return;
      }
      sendReady({ type: "input_audio_buffer.commit" });
      sendReady({ type: "response.create" });
    },
    injectLabeledImage(label, bytes, mime) {
      if (dead) {
        return;
      }
      // A turn-boundary item pairing the label with the image; no response.create
      // (items never auto-trigger a response — finding 8).
      sendReady({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: `[image ${label}]` },
            { type: "input_image", image_url: `data:${mime};base64,${toBase64(bytes)}` },
          ],
        },
      });
    },
    appendVideoFrame() {
      // No-op: this vendor has no video (capabilities.video === false). The
      // processor traces the drop; the engine simply ignores the frame.
    },
    injectContextText(text) {
      if (dead) {
        return;
      }
      // SILENT context: a bare text item with NO `response.create` chasing it —
      // items never auto-trigger a response (finding 8), so this adds to the
      // conversation without making the model speak.
      sendReady({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
    },
    nudgeSubmit() {
      if (dead) {
        return;
      }
      sendReady({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: LIVE_NUDGE_TEXT }],
        },
      });
      sendReady({ type: "response.create" });
    },
    drainToolCall(timeoutMs) {
      if (bufferedCall !== null) {
        const call = bufferedCall;
        bufferedCall = null;
        return Promise.resolve(call);
      }
      if (dead) {
        return Promise.resolve(null);
      }
      return new Promise<SubmitIntentCall | null>((resolve) => {
        let settled = false;
        const finish = (call: SubmitIntentCall | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          drainResolver = null;
          resolve(call);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        drainResolver = finish;
      });
    },
    close() {
      dead = true;
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      settleDrain(null);
    },
  };
}
