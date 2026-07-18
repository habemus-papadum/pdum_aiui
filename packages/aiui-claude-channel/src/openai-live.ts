/**
 * The prompt linter's **degraded engine** — an OpenAI `gpt-realtime-2` session
 * behind the {@link ./live-session}.LiveSession seam.
 *
 * Where {@link ./gemini-live} is the reference (video, one streaming image path,
 * session resumption), OpenAI realtime runs the same linter without video and
 * with images injected as **turn-boundary items**, not a stream (§2/§8 of
 * archive/transcription-and-realtime-submodes.md). It is structurally the retired
 * flagship voice session (git history: realtime-voice.ts) — same PCM-append /
 * manual-commit shape, same WAV-wrapped reply clips — plus the two additions
 * the linter needs: the `read_file` tool and `input_image` injection.
 *
 * ### Wire surface (GA realtime; shape live-verified in the retired realtime-voice.ts)
 *
 *  - **Endpoint:** `wss://api.openai.com/v1/realtime?model=…` (bearer auth).
 *  - **Configure:** one `session.update` — `type: "realtime"`, model, the linter
 *    persona, `output_modalities: ["audio"]`, `audio.input` = pcm/24k +
 *    transcription + `turn_detection: null` (manual, PTT is the boundary),
 *    `audio.output` = pcm/24k + voice, and `tools: [read_file]`.
 *  - **A talk window:** {@link activityStart} is a no-op (OpenAI opens the buffer on
 *    the first append); {@link activityEnd} = `input_audio_buffer.commit` +
 *    `response.create`.
 *  - **Images:** `conversation.item.create` with an `input_text` label part and an
 *    `input_image` data-URL part (finding 8) — items never auto-trigger a response.
 *  - **Silent context (selections):** an `input_text` item alone — no
 *    `response.create`, so nothing is spoken back.
 *  - **The call:** a `function_call` item in `response.done.response.output`,
 *    routed through `onToolCall`; `respond` writes a `function_call_output`
 *    item then `response.create` (the resume rule — a written tool result
 *    never re-triggers the response on its own).
 *  - **Back:** `conversation.item.input_audio_transcription.completed` (the user
 *    transcript), `response.output_audio.delta`/`.done` (reply audio),
 *    `response.output_audio_transcript.done` (reply transcript), `response.done`
 *    (usage + the tool call).
 *
 * The upstream socket is injectable so the tests drive a scripted fake with no
 * network and no key (the house pattern).
 */
import { priceCall, usageFromRealtimeResponse } from "./cost";
import { READ_FILE_TOOL_OPENAI } from "./linter-tools";
import {
  LINTER_INSTRUCTIONS,
  type LinterToolCall,
  type LiveCapabilities,
  type LiveSession,
  type LiveSessionCallbacks,
} from "./live-session";
import { fromBase64, OPENAI_REALTIME_VOICE_URL, REALTIME_VOICE_RATE, toBase64 } from "./pcm";
import {
  closeSuffix,
  openaiRealtimeSocketFactory,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
} from "./realtime";
import { createReadyGate, createReplyClip, makeOnceCall, type ReplyClip } from "./session-core";

/** The flagship conversational model, running here as the degraded linter engine. */
export const DEFAULT_OPENAI_LIVE_MODEL = "gpt-realtime-2";

/**
 * OpenAI's capability grade. "video" means the engine ACCEPTS ambient frames
 * — they inject as unlabeled turn-boundary `input_image` items, not a
 * stream, so the injection grade stays honest.
 */
const OPENAI_CAPABILITIES: LiveCapabilities = { video: true, imageInjection: "turn-item" };

/**
 * The manual-commit floor: OpenAI rejects `input_audio_buffer.commit` under
 * ~100 ms of buffered audio ("buffer too small"), which kills the session's
 * turn. Under the floor the window's audio is CLEARED instead of committed —
 * an accidental tap is not a lint opportunity.
 */
export const OPENAI_MIN_COMMIT_MS = 100;
/** PCM16 mono at 24 kHz: bytes per millisecond (24000 * 2 / 1000). */
const PCM_BYTES_PER_MS = 48;

export interface OpenAiLiveSessionOptions {
  apiKey: string;
  /** Resolves the conversational model (e.g. `gpt-realtime-2`) at open time. */
  model: () => string;
  /** Resolves the output voice id (undefined → the model default). */
  voice?: () => string | undefined;
  /**
   * The linter persona (short — billed every turn). Default:
   * {@link LINTER_INSTRUCTIONS}, the shared authoritative text.
   */
  instructions?: string;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory (via realtime.ts). */
  socketFactory?: RealtimeSocketFactory;
}

/**
 * Open an OpenAI realtime session under the {@link LiveSession} seam. Eagerly
 * connects (the handshake overlaps the arm→talk gap); audio queued before
 * `session.updated` is flushed once ready. Structurally mirrors
 * the retired flagship voice session's lifecycle (git history: realtime-voice.ts).
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

  const gate = createReadyGate((text) => socket.send(text));
  /** Bytes appended since the last commit/clear — the commit-floor meter. */
  let windowBytes = 0;

  // Reply clips keyed by the upstream response id (which may be the empty string).
  const clips = new Map<string, ReplyClip>();
  const clipFor = (id: string): ReplyClip => {
    let clip = clips.get(id);
    if (clip === undefined) {
      clip = createReplyClip(
        { onAudio: callbacks.onReplyAudio, onTranscript: callbacks.onReplyTranscript },
        REALTIME_VOICE_RATE,
      );
      clips.set(id, clip);
    }
    return clip;
  };

  const sendReady = (message: object): void => gate.send(JSON.stringify(message));

  const fail = (message: string, data?: unknown): void => {
    if (gate.isDead()) {
      return;
    }
    gate.markDead();
    callbacks.onError(message, data);
  };

  /** A finished response's buffered audio (WAV-wrapped) + its transcript. */
  const flushResponse = (responseId: string): void => {
    const clip = clips.get(responseId);
    clips.delete(responseId);
    clip?.flush();
  };

  /** A linter-mode function call: respond writes the output THEN resumes. */
  const buildLinterCall = (item: {
    call_id?: string;
    name?: string;
    arguments?: unknown;
  }): LinterToolCall => {
    let parsed: Record<string, unknown> = {};
    if (typeof item.arguments === "string") {
      try {
        parsed = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    return makeOnceCall(
      item.name ?? "",
      parsed,
      () => gate.isDead(),
      (result) => {
        sendReady({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: item.call_id,
            output: result,
          },
        });
        // THE RESUME RULE: a written tool result never re-triggers the
        // response on its own — the model only reads it and speaks once a
        // fresh response is created.
        sendReady({ type: "response.create" });
      },
    );
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
        gate.markReady();
        return;
      }
      case "response.output_audio.delta": {
        const id = message.response_id ?? "";
        if (typeof message.delta === "string" && message.delta !== "") {
          clipFor(id).pushAudio(fromBase64(message.delta));
        }
        return;
      }
      case "response.output_audio_transcript.delta": {
        const id = message.response_id ?? "";
        clipFor(id).appendTranscript(message.delta ?? "");
        return;
      }
      case "response.output_audio_transcript.done": {
        const id = message.response_id ?? "";
        if (typeof message.transcript === "string") {
          clipFor(id).setTranscript(message.transcript);
        }
        return;
      }
      case "response.done": {
        const id = message.response?.id ?? message.response_id ?? "";
        const usage = usageFromRealtimeResponse(message.response?.usage);
        if (usage) {
          callbacks.onUsage(priceCall("openai", options.model(), usage));
        }
        // A tool call arrives as a function_call item in the output.
        const output = Array.isArray(message.response?.output) ? message.response?.output : [];
        for (const raw of output) {
          const item = (raw ?? {}) as {
            type?: string;
            name?: string;
            call_id?: string;
            arguments?: unknown;
          };
          // Tool calls (read_file) route through the generic callback.
          if (item.type === "function_call" && callbacks.onToolCall) {
            callbacks.onToolCall(buildLinterCall(item));
            break;
          }
        }
        flushResponse(id);
        return;
      }
      case "error": {
        // A cancel with nothing in flight is a NO-OP, not a fault: the
        // sidecar barge-ins on every talk-start (usually there is no reply
        // to cancel), and OpenAI answers the miss with this error event.
        // Surfacing it would toast the user once per utterance.
        const err = message.error as { code?: string; message?: string } | undefined;
        if (
          err?.code === "response_cancel_not_active" ||
          /no active response/i.test(err?.message ?? "")
        ) {
          return;
        }
        // The full error object (type/code/param) rides as structured data so
        // the client's details expander shows what OpenAI actually returned.
        fail(err?.message ?? "openai live session error", message.error);
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
      // The session declares read_file and NO vendor input transcription —
      // the STT session owns the chronicle, and the sidecar injects
      // `[transcript seg_N: …]` items instead (double-transcribing the same
      // audio would double the cost for a worse record).
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: options.model(),
            instructions: options.instructions ?? LINTER_INSTRUCTIONS,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: REALTIME_VOICE_RATE },
                turn_detection: null,
              },
              output,
            },
            tools: [READ_FILE_TOOL_OPENAI],
          },
        }),
      );
    },
    onMessage: handleMessage,
    onError: (message: string, data?: unknown) => fail(message, data),
    onClose: (code?: number, reason?: string) => {
      if (!gate.isDead()) {
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
      if (gate.isDead()) {
        return;
      }
      windowBytes += pcm24k.length;
      sendReady({ type: "input_audio_buffer.append", audio: toBase64(pcm24k) });
    },
    activityEnd() {
      if (gate.isDead()) {
        return;
      }
      // The commit floor: a tapped-and-released window under ~100 ms cannot
      // be committed ("buffer too small" kills the turn) — clear it instead;
      // no response is solicited for an accidental tap.
      if (windowBytes < OPENAI_MIN_COMMIT_MS * PCM_BYTES_PER_MS) {
        windowBytes = 0;
        sendReady({ type: "input_audio_buffer.clear" });
        return;
      }
      windowBytes = 0;
      sendReady({ type: "input_audio_buffer.commit" });
      sendReady({ type: "response.create" });
    },
    injectLabeledImage(label, bytes, mime) {
      if (gate.isDead()) {
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
    injectContextText(text) {
      if (gate.isDead()) {
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
    cancelActiveResponse() {
      if (gate.isDead()) {
        return;
      }
      sendReady({ type: "response.cancel" });
    },
    close() {
      gate.markDead();
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
    },
  };
}
