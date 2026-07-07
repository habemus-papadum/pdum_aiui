/**
 * The realtime submode's **reference engine** — a raw-WebSocket Gemini Live
 * session behind the {@link ./live-session}.LiveSession seam.
 *
 * This is the engine the realtime submode is optimized for: the model hears the
 * mic continuously, sees labeled shots and ~1 fps ambient video, answers aloud,
 * can be interrupted, and — the point — **composes the prompt itself** via a
 * `submit_intent` function call. The RT0 spike proved the whole path end-to-end
 * (archive/gemini-live-spike.mjs); this is that spike, refactored under the seam
 * with the house injectable-socket pattern so the tests drive a scripted fake.
 *
 * ### Wire surface (v1beta BidiGenerateContent; findings from the spike)
 *
 *  - **Raw WebSocket, not `@google/genai`** — SDK 2.10.0's wire transformer
 *    silently drops `realtimeInputConfig` from the setup frame, which makes manual
 *    VAD impossible (activity signals then die with `1007`). Raw frames work and
 *    match how the channel already speaks to OpenAI realtime.
 *  - **Endpoint:** `wss://…/v1beta.GenerativeService.BidiGenerateContent?key=KEY`.
 *  - **Setup:** model, AUDIO modality, input+output transcription, **manual VAD**
 *    (`realtimeInputConfig.automaticActivityDetection.disabled: true`), the
 *    `submit_intent` tool, `sessionResumption: {}` + a sliding-window context
 *    compression so a long session doesn't blow the 15-min/2-min caps. Answered
 *    by `{setupComplete:{}}`.
 *  - **Audio in:** client PCM is 24 kHz; Gemini natively wants 16 kHz but accepts
 *    any declared rate (capabilities doc: "any rate accepted — declare it in the
 *    blob MIME"), so we send `audio/pcm;rate=24000` and let the API resample —
 *    verified live, so no channel-side resampler is needed (one capture path, no
 *    quality loss from a naive linear pass).
 *  - **THE WINDOW RULE (spike finding 3, undocumented):** a manual activity window
 *    must OPEN WITH AUDIO — a text label or video frame sent inside a window
 *    before any audio hard-closes with 1007. {@link WindowOrderingGuard} enforces
 *    the ordering; outside windows (and inside, after audio) everything is safe.
 *  - **Labeled images:** `{realtimeInput:{text:"[image shot_3]"}}` then
 *    `{realtimeInput:{video:{data,mimeType}}}`; ambient video frames are the same
 *    `realtimeInput.video` unlabeled. Element/cell metadata is NEVER sent — the
 *    channel keeps it keyed by label and re-attaches it when resolving the call.
 *  - **Silent context (selections):** `{clientContent:{turns:[…],turnComplete:false}}`
 *    — the incremental-context append, which does not solicit a reply. A bare
 *    `realtimeInput.text` (the nudge's form) is answered immediately under manual
 *    VAD (spike finding 4), so it cannot carry selection labels.
 *  - **Back:** `serverContent.{inputTranscription,outputTranscription,modelTurn}`,
 *    `toolCall`→`toolResponse`, `serverContent.interrupted`, `usageMetadata`,
 *    `goAway`.
 */

import WebSocket from "ws";
import { priceCall, usageFromGeminiLive } from "./cost";
import {
  LIVE_COMPOSER_INSTRUCTIONS,
  LIVE_NUDGE_TEXT,
  type LiveCapabilities,
  type LiveSession,
  type LiveSessionCallbacks,
  type SubmitIntentCall,
} from "./live-session";
import type { RealtimeSocketFactory, RealtimeSocketHandlers } from "./realtime";
import { pcm16ToWav } from "./realtime-voice";

/** The v1beta bidirectional-generate endpoint (key rides the query string). */
export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** The reference model — video-capable, manual-VAD verified (spike). */
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

/** Gemini emits 24 kHz PCM16; the same rate the client captures — one WAV wrap. */
const GEMINI_OUTPUT_RATE = 24000;

/**
 * The declared input-audio MIME. Client capture is 24 kHz; Gemini accepts any
 * declared rate and resamples (verified live), so we hand its own rate straight
 * through — no channel-side resampler.
 */
const GEMINI_INPUT_AUDIO_MIME = "audio/pcm;rate=24000";

/** The `submit_intent` function declaration (the spike's exact schema). */
const SUBMIT_INTENT_DECLARATION = {
  name: "submit_intent",
  description: "Deliver the composed request to the coding agent as interleaved segments.",
  parameters: {
    type: "OBJECT",
    properties: {
      segments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING" },
            image: { type: "STRING" },
            selection: { type: "STRING" },
          },
        },
      },
    },
    required: ["segments"],
  },
} as const;

/** One outbound realtime frame (audio/text/video/activity signals, or a tool response). */
type OutboundFrame = Record<string, unknown>;

/** How the window rule classifies an outbound frame (see {@link WindowOrderingGuard}). */
export type LiveFrameKind = "activityStart" | "audio" | "activityEnd" | "other";

/**
 * The manual-activity window ordering guard (spike finding 3, undocumented): a
 * Gemini manual window must OPEN WITH AUDIO — a text label or video frame sent
 * inside a window before any audio hard-closes the socket with 1007. So while a
 * window is open but no audio has flowed yet, "other" frames (labels, video,
 * text) are QUEUED; the first audio chunk flushes them in order. Outside a window,
 * and inside a window after audio, everything passes straight through. Pure and
 * exported so the ordering is unit-tested without a socket.
 *
 * {@link admit} returns the frames to actually send now, in order, for one inbound
 * frame of `kind` — usually `[frame]`, but `[]` while queuing and
 * `[audio, ...flushed]` on the first audio in a window.
 */
export class WindowOrderingGuard<T> {
  private windowOpen = false;
  private audioFlowed = false;
  private readonly queued: T[] = [];

  admit(kind: LiveFrameKind, frame: T): T[] {
    switch (kind) {
      case "activityStart":
        this.windowOpen = true;
        this.audioFlowed = false;
        return [frame];
      case "audio":
        if (this.windowOpen && !this.audioFlowed) {
          this.audioFlowed = true;
          return [frame, ...this.queued.splice(0)];
        }
        return [frame];
      case "activityEnd":
        this.windowOpen = false;
        this.audioFlowed = false;
        // A window that closed before any audio never got to flush its queued
        // labels/frames in-window; they are safe out-of-window, so flush now.
        return [frame, ...this.queued.splice(0)];
      case "other":
        if (this.windowOpen && !this.audioFlowed) {
          this.queued.push(frame);
          return [];
        }
        return [frame];
    }
  }
}

export interface GeminiLiveSessionOptions {
  apiKey: string;
  /** Resolves the model id (bare, e.g. `gemini-3.1-flash-live-preview`) at open time. */
  model: () => string;
  /**
   * The composer persona (short — billed every turn). Default:
   * {@link LIVE_COMPOSER_INSTRUCTIONS}, the shared authoritative text.
   */
  instructions?: string;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory. */
  socketFactory?: RealtimeSocketFactory;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** Concatenate buffered PCM chunks of one turn into one buffer (WAV-wrapped by the caller). */
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
 * The real upstream factory: a `ws` WebSocket to the Gemini Live endpoint with
 * the API key on the query string (unlike OpenAI's bearer header). Server-side
 * only — the channel always runs under Node.
 */
export const geminiLiveSocketFactory: RealtimeSocketFactory = (url, apiKey, handlers) => {
  const full = url.includes("?") ? `${url}&key=${apiKey}` : `${url}?key=${apiKey}`;
  const ws = new WebSocket(full);
  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data: unknown) => handlers.onMessage(String(data)));
  ws.on("error", (err: Error) => handlers.onError(err.message));
  ws.on("close", () => handlers.onClose());
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(),
  };
};

/** Gemini's capability grade: video-capable, images ride the realtime stream. */
const GEMINI_CAPABILITIES: LiveCapabilities = { video: true, imageInjection: "stream" };

/**
 * Open a Gemini Live conversational session under the {@link LiveSession} seam.
 * Eagerly connects (opened at thread-open so the handshake overlaps the arm→talk
 * gap); frames produced before `setupComplete` queue and flush once ready.
 */
export function openGeminiLiveSession(
  options: GeminiLiveSessionOptions,
  callbacks: LiveSessionCallbacks,
): LiveSession {
  const factory = options.socketFactory ?? geminiLiveSocketFactory;
  const url = options.url ?? GEMINI_LIVE_URL;

  let ready = false;
  let dead = false;
  const outbox: string[] = [];
  const guard = new WindowOrderingGuard<OutboundFrame>();

  // Per-turn accumulation. Gemini has no response ids; a turn is bounded by
  // `serverContent.turnComplete`, so we buffer until it and flush one clip /
  // one user transcript / one reply transcript per turn.
  let pendingUserText = "";
  let pendingReplyText = "";
  let replyAudio: Uint8Array[] = [];

  // The tool-call drain: a call that lands before `drainToolCall` is awaited is
  // buffered here so a fast model never races the drain.
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

  // Send once ready; the setup handshake that produces readiness bypasses the
  // queue (it goes out in `onOpen`). Everything the guard admits flows here.
  const sendReady = (frame: OutboundFrame): void => {
    const text = JSON.stringify(frame);
    if (ready && !dead) {
      socket.send(text);
    } else if (!dead) {
      outbox.push(text);
    }
  };

  /** Route one classified frame through the window guard, then the ready queue. */
  const emit = (kind: LiveFrameKind, frame: OutboundFrame): void => {
    for (const admitted of guard.admit(kind, frame)) {
      sendReady(admitted);
    }
  };

  const flushTurn = (): void => {
    const user = pendingUserText.trim();
    pendingUserText = "";
    if (user !== "") {
      callbacks.onUserTranscript(user);
    }
    if (replyAudio.length > 0) {
      callbacks.onReplyAudio(pcm16ToWav(concatChunks(replyAudio), GEMINI_OUTPUT_RATE), "audio/wav");
      replyAudio = [];
    }
    const reply = pendingReplyText.trim();
    pendingReplyText = "";
    if (reply !== "") {
      callbacks.onReplyTranscript(reply);
    }
  };

  /** A hard fault: flush whatever the user already said (chronicle), then idle. */
  const fail = (message: string): void => {
    if (dead) {
      return;
    }
    dead = true;
    const user = pendingUserText.trim();
    pendingUserText = "";
    if (user !== "") {
      callbacks.onUserTranscript(user);
    }
    callbacks.onError(message);
    settleDrain(null);
  };

  const buildToolCall = (fc: { id?: string; name?: string; args?: unknown }): SubmitIntentCall => {
    const args = (fc.args ?? {}) as { segments?: unknown };
    const rawSegments = Array.isArray(args.segments) ? args.segments : [];
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
        sendReady({
          toolResponse: {
            functionResponses: [{ id: fc.id, name: fc.name ?? "submit_intent", response: { ok } }],
          },
        });
      },
    };
  };

  const handleMessage = (text: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return; // a malformed upstream frame — ignore rather than crash the thread
    }
    if (message.setupComplete !== undefined) {
      ready = true;
      for (const queued of outbox.splice(0)) {
        socket.send(queued);
      }
      return;
    }
    const serverContent = message.serverContent as
      | {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
          interrupted?: boolean;
          turnComplete?: boolean;
        }
      | undefined;
    if (serverContent !== undefined) {
      if (typeof serverContent.inputTranscription?.text === "string") {
        pendingUserText += serverContent.inputTranscription.text;
      }
      if (typeof serverContent.outputTranscription?.text === "string") {
        pendingReplyText += serverContent.outputTranscription.text;
      }
      for (const part of serverContent.modelTurn?.parts ?? []) {
        if (typeof part.inlineData?.data === "string") {
          replyAudio.push(fromBase64(part.inlineData.data));
        }
      }
      if (serverContent.interrupted === true) {
        // Barge-in: discard the half-spoken reply so it is not replayed.
        replyAudio = [];
        pendingReplyText = "";
        callbacks.onInterrupted();
      }
      if (serverContent.turnComplete === true) {
        flushTurn();
      }
    }
    const toolCall = message.toolCall as
      | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
      | undefined;
    if (toolCall !== undefined) {
      const fc = (toolCall.functionCalls ?? []).find((c) => c.name === "submit_intent");
      if (fc !== undefined) {
        settleDrain(buildToolCall(fc));
      }
    }
    if (message.usageMetadata !== undefined) {
      const usage = usageFromGeminiLive(message.usageMetadata);
      if (usage) {
        callbacks.onUsage(priceCall("google", options.model(), usage));
      }
    }
    const goAway = message.goAway as { timeLeft?: unknown } | undefined;
    if (goAway !== undefined && callbacks.onGoAway) {
      callbacks.onGoAway(parseTimeLeftMs(goAway.timeLeft));
    }
    // `sessionResumptionUpdate` handles are deliberately ignored: setup requests
    // resumption (so the server keeps the session resumable and warns via GoAway),
    // but reconnect-on-GoAway is RT2 residue — GoAway is surfaced; re-opening the
    // socket with the handle is future work.
  };

  const socket = factory(url, options.apiKey, {
    onOpen: () => {
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${options.model()}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: {
              parts: [{ text: options.instructions ?? LIVE_COMPOSER_INSTRUCTIONS }],
            },
            tools: [{ functionDeclarations: [SUBMIT_INTENT_DECLARATION] }],
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {},
            contextWindowCompression: { slidingWindow: {} },
          },
        }),
      );
    },
    onMessage: handleMessage,
    onError: (message: string) => fail(message),
    onClose: () => {
      if (!dead) {
        fail("gemini live session closed");
      }
    },
  } satisfies RealtimeSocketHandlers);

  return {
    capabilities: GEMINI_CAPABILITIES,
    activityStart() {
      if (dead) {
        return;
      }
      emit("activityStart", { realtimeInput: { activityStart: {} } });
    },
    appendAudio(pcm24k) {
      if (dead) {
        return;
      }
      emit("audio", {
        realtimeInput: { audio: { data: toBase64(pcm24k), mimeType: GEMINI_INPUT_AUDIO_MIME } },
      });
    },
    activityEnd() {
      if (dead) {
        return;
      }
      emit("activityEnd", { realtimeInput: { activityEnd: {} } });
    },
    injectLabeledImage(label, bytes, mime) {
      if (dead) {
        return;
      }
      // The label MUST precede its frame (spike finding 5); both are "other"
      // frames, so the guard queues them together inside an audio-less window.
      emit("other", { realtimeInput: { text: `[image ${label}]` } });
      emit("other", { realtimeInput: { video: { data: toBase64(bytes), mimeType: mime } } });
    },
    appendVideoFrame(bytes, mime) {
      if (dead) {
        return;
      }
      emit("other", { realtimeInput: { video: { data: toBase64(bytes), mimeType: mime } } });
    },
    injectContextText(text) {
      if (dead) {
        return;
      }
      // SILENT context: `clientContent` with `turnComplete: false` appends to
      // the conversation without soliciting a reply — the Live API's documented
      // incremental-context form. (`realtimeInput.text` is NOT usable here: under
      // manual VAD a bare text turn is answered immediately — spike finding 4 —
      // and a selection change must never make the model start talking.) Routed
      // through the window guard as "other": the spike only verified the
      // audio-first window rule for realtimeInput frames, so we conservatively
      // keep clientContent out of an audio-less window too.
      emit("other", {
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false },
      });
    },
    nudgeSubmit() {
      if (dead) {
        return;
      }
      emit("other", { realtimeInput: { text: LIVE_NUDGE_TEXT } });
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

/**
 * Parse a Gemini `GoAway.timeLeft` into milliseconds. It arrives as a duration
 * string (`"9.5s"`) or a `{seconds, nanos}` object; tolerate both, and an
 * unknown shape maps to 0 (act now). Pure/exported for the unit test.
 */
export function parseTimeLeftMs(timeLeft: unknown): number {
  if (typeof timeLeft === "string") {
    const match = /^([\d.]+)s$/.exec(timeLeft.trim());
    return match ? Math.round(Number(match[1]) * 1000) : 0;
  }
  if (timeLeft !== null && typeof timeLeft === "object") {
    const t = timeLeft as { seconds?: unknown; nanos?: unknown };
    const seconds = typeof t.seconds === "number" ? t.seconds : Number(t.seconds ?? 0) || 0;
    const nanos = typeof t.nanos === "number" ? t.nanos : 0;
    return Math.round(seconds * 1000 + nanos / 1e6);
  }
  return 0;
}
