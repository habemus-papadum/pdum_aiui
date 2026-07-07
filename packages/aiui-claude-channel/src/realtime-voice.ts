/**
 * The flagship conversational voice seam — a per-thread `gpt-realtime-2` session
 * over the GA realtime WebSocket. The talking sibling of {@link ./realtime}'s
 * transcription session: same PCM-append / manual-commit shape, but the upstream
 * model **answers aloud** and can be interrupted (model-tiers.md T3).
 *
 * ### The design in one paragraph
 *
 * The session reuses the existing STT lowering for the prompt and adds voice as a
 * layer on top, so it degrades gracefully and the trace stays honest. **Input
 * transcription stays ON** — `conversation.item.input_audio_transcription.completed`
 * gives the *user's* transcript, which feeds `composeIntent` exactly as in
 * `standard`/`rapid`; the lowered prompt (the IR) never depends on the voice model
 * choosing to emit anything, and text remains the single source of truth. The
 * model's **spoken output** arrives as `response.output_audio.delta` (base64 PCM),
 * buffered per response and handed back (WAV-wrapped so a page `<audio>` can play
 * it) as one clip; its **spoken transcript** (`response.output_audio_transcript.*`)
 * is surfaced so the trace records what the human was told.
 *
 * ### Verified GA surface (developers.openai.com, July 2026 — ⚠ re-verify)
 *
 *  - **Endpoint:** `wss://api.openai.com/v1/realtime` (no `?intent=transcription`).
 *  - **Auth:** `Authorization: Bearer <key>` only.
 *  - **Configure:** one `session.update` with a nested realtime session — model,
 *    short instructions (persona; billed as input tokens every turn),
 *    `output_modalities: ["audio"]`, `audio.input` = pcm/24k + `transcription`
 *    (input transcription ON) + `turn_detection: null` (PTT is the boundary),
 *    `audio.output` = pcm/24k + `voice`, `tools: []` (none in v1).
 *  - **Ready:** `session.updated`.
 *  - **Client → server:** `input_audio_buffer.append` (base64 PCM16),
 *    `input_audio_buffer.commit`, `response.create` (after a commit — "your turn"),
 *    `response.cancel` (barge-in).
 *  - **Server → client:** `conversation.item.input_audio_transcription.delta` /
 *    `.completed` (the user transcript), `response.created`,
 *    `response.output_audio.delta` / `.done` (model speech, base64 PCM),
 *    `response.output_audio_transcript.delta` / `.done` (what it said),
 *    `response.done`.
 *
 * The upstream socket is injectable ({@link RealtimeSocketFactory}) so the unit
 * tests drive a scripted fake session with no network and no key.
 *
 * **Cost guard.** A conversational realtime turn re-bills its context every
 * response, a documented cost trap; so a per-thread **response cap**
 * ({@link RealtimeVoiceSessionOptions.maxResponses}, default
 * {@link DEFAULT_MAX_RESPONSES}) suppresses further `response.create`s once hit —
 * the STT lowering keeps working (the IR is captured), the model just stops
 * speaking, loudly noted. See docs/guide/intent-overlay.md §Tiers.
 */
import { type CallCost, priceCall, usageFromRealtimeResponse } from "./cost";
import {
  openaiRealtimeSocketFactory,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
} from "./realtime";

/** The GA realtime endpoint for a conversational (speech-to-speech) session. */
export const OPENAI_REALTIME_VOICE_URL = "wss://api.openai.com/v1/realtime";

/** The flagship conversational voice model. */
export const DEFAULT_REALTIME_VOICE_MODEL = "gpt-realtime-2";

/** The input-transcription model used inside the voice session (feeds the IR). */
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** The session's PCM rate (in and out). */
export const REALTIME_VOICE_RATE = 24000;

/** Conservative per-thread cap on how many spoken responses the model may make. */
export const DEFAULT_MAX_RESPONSES = 8;

/**
 * A short persona: kept terse because it is billed as input tokens every turn.
 * Honest about the situation — the human is dictating an instruction for a
 * coding agent; this model is only the spoken courtesy layer (the composition
 * runs elsewhere, over the transcripts), so it must never restate the dictation.
 */
export const DEFAULT_VOICE_INSTRUCTIONS =
  "A developer is dictating an instruction for a coding agent while working in their app; you " +
  "are the spoken sidekick. The dictation is transcribed and composed separately — never " +
  "repeat, rephrase, or narrate it. Acknowledge and answer questions in one short spoken sentence.";

/** One user (input) transcript result — mirrors {@link ./realtime}.RealtimeResult. */
export interface VoiceUserResult {
  text: string;
  /** Wall-clock from the segment's commit (talk-end) to its transcript. */
  latencyMs: number;
  model: string;
}

/** One buffered clip of model speech, ready to push as a `speech` message. */
export interface VoiceAudioClip {
  /** WAV-wrapped PCM16 (so a page `<audio>` can play it directly). */
  bytes: Uint8Array;
  mime: string;
  /** The upstream response id this clip belongs to (for correlation/trace). */
  responseId: string;
}

/** What a voice session reports back, keyed by our own segment ordinal. */
export interface RealtimeVoiceCallbacks {
  /** A partial USER transcript for `segment` — cumulative text (feeds the preview). */
  onUserDelta(segment: number, cumulativeText: string): void;
  /** The final USER transcript for `segment` — feeds `composeIntent` (the IR). */
  onUserFinal(segment: number, result: VoiceUserResult): void;
  /** One buffered clip of the MODEL's spoken reply (→ a `speech` message). */
  onAudio(clip: VoiceAudioClip): void;
  /** The MODEL's spoken-reply transcript (what the human was told) — logged, not the IR. */
  onReplyTranscript(text: string, responseId: string): void;
  /**
   * What one response cost. A conversational realtime turn re-bills its whole
   * context per response — the documented cost trap the response cap guards —
   * so accounting is per `response.done`, priced against the session's model.
   * Optional: older callers (and most tests) simply don't observe spend.
   */
  onUsage?(cost: CallCost, responseId: string): void;
  /**
   * A failure. `segment` names the committed segment it belongs to (so the caller
   * can finalize just that one loudly); undefined for a session-wide fault or a
   * non-segment notice (e.g. the cost cap).
   */
  onError(message: string, segment?: number): void;
}

export interface RealtimeVoiceSessionOptions {
  apiKey: string;
  /** Resolves the conversational model (e.g. `gpt-realtime-2`). */
  model: () => string;
  /** Resolves the output voice id (undefined → the model default). */
  voice?: () => string | undefined;
  /** Resolves the input-transcription model (feeds the IR). */
  transcriptionModel?: () => string;
  /** The persona/instructions (short — billed every turn). */
  instructions?: string;
  /** Per-thread spoken-response cap (default {@link DEFAULT_MAX_RESPONSES}). */
  maxResponses?: number;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected upstream socket (tests); defaults to the real `ws` factory. */
  socketFactory?: RealtimeSocketFactory;
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A live per-thread conversational voice session. Audio streams in by segment
 * ordinal; the user transcript (for the IR), the model's spoken clips, and its
 * reply transcript come back through {@link RealtimeVoiceCallbacks}.
 */
export interface RealtimeVoiceSession {
  /** Append one PCM16 frame of `segment` (base64-encoded, forwarded upstream). */
  appendAudio(segment: number, bytes: Uint8Array): void;
  /**
   * Commit `segment` (talk-end): its buffer is transcribed as the user's turn,
   * and — unless the per-thread response cap is hit — the model is asked to reply
   * (`response.create`). The IR-feeding transcription runs regardless of the cap.
   */
  commit(segment: number): void;
  /**
   * Drop `segment` without transcribing it — an accidental tap whose buffer is
   * under the upstream's 100 ms commit minimum. Clears the upstream input
   * buffer and unbinds anything a pre-commit delta may have bound to it; no
   * `response.create` (a tap should not make the model speak).
   */
  discard(segment: number): void;
  /**
   * Barge-in: cancel any in-flight model response (the human started talking over
   * it). No-op when nothing is speaking.
   */
  cancelActiveResponse(): void;
  /**
   * Resolve once every committed-but-not-transcribed segment has produced its
   * USER transcript, or `timeoutMs` elapses. Returns the ordinals still
   * outstanding at timeout (so the caller can finalize them loudly). Used at
   * `fin`, where the compose needs the user transcripts still in flight. Model
   * replies (audio/transcript) are *not* awaited — they are a courtesy layer.
   */
  drain(timeoutMs: number): Promise<number[]>;
  /** Close the upstream socket (idempotent). */
  close(): void;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/**
 * Wrap raw little-endian PCM16 mono samples in a minimal 44-byte WAV header so a
 * browser `<audio>` element can play the clip (raw PCM has no container). The
 * model streams `audio/pcm`; the page needs `audio/wav`.
 */
export function pcm16ToWav(pcm: Uint8Array, rate = REALTIME_VOICE_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  const byteRate = rate * 2; // mono, 16-bit
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Concatenate the buffered PCM chunks of one response into a single buffer. */
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
 * Open a conversational voice session. Eagerly connects (opened at thread-open so
 * the handshake overlaps the arm→talk gap); audio queued before `session.updated`
 * is flushed once ready. Mirrors {@link ./realtime}.openRealtimeSession's socket
 * lifecycle, extended with model-reply handling and the response cap.
 */
export function openRealtimeVoiceSession(
  options: RealtimeVoiceSessionOptions,
  callbacks: RealtimeVoiceCallbacks,
): RealtimeVoiceSession {
  const now = options.now ?? Date.now;
  const factory = options.socketFactory ?? openaiRealtimeSocketFactory;
  const maxResponses = options.maxResponses ?? DEFAULT_MAX_RESPONSES;
  // The GA **conversational** endpoint requires the model as a URL query param
  // (`?model=…`) — unlike the transcription endpoint (`?intent=transcription`),
  // which takes the model in `session.update` (verified live 2026-07-05: a bare
  // URL 400s "You must provide a model parameter"). We still send it in
  // `session.update` too (harmless, and keeps the session self-describing).
  const modelName = options.model();
  const baseUrl = options.url ?? OPENAI_REALTIME_VOICE_URL;
  const url = baseUrl.includes("?")
    ? `${baseUrl}&model=${encodeURIComponent(modelName)}`
    : `${baseUrl}?model=${encodeURIComponent(modelName)}`;

  let ready = false;
  let dead = false;
  const outbox: string[] = [];

  // ── user transcription state (mirrors realtime.ts) ──────────────────────────
  const pending: number[] = []; // committed, awaiting their user transcript
  const awaitingItem: number[] = []; // committed, not yet bound to an item_id
  // The segment whose audio is streaming right now (appending, not yet
  // committed) — where a pre-commit delta's unseen item_id binds.
  let streamingSegment: number | undefined;
  // Segments already bound to an item_id (until their transcript completes).
  const boundSegments = new Set<number>();
  const commitAt = new Map<number, number>();
  const itemToSegment = new Map<string, number>();
  const cumulativeByItem = new Map<string, string>();
  // Items whose segment was discarded (a Space tap): late upstream events for
  // them must drop, never re-bind to whatever segment streams next.
  const discardedItems = new Set<string>();
  const drainWaiters: Array<() => void> = [];

  // ── model-reply state ───────────────────────────────────────────────────────
  let responseCount = 0;
  const audioByResponse = new Map<string, Uint8Array[]>();
  const transcriptByResponse = new Map<string, string>();
  const activeResponses = new Set<string>();
  let capNoted = false;

  const settleDrainIfIdle = (): void => {
    if (pending.length === 0) {
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
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

  /**
   * Bind an unseen upstream item to its segment: the oldest still-unbound
   * committed segment first (items are created in buffer = commit order), and
   * with none committed, the segment streaming audio right now — input
   * transcription partials arrive while audio is still appending, before any
   * commit (see realtime.ts, whose binding this mirrors).
   */
  const segmentForItem = (itemId: string): number | undefined => {
    if (discardedItems.has(itemId)) {
      return undefined;
    }
    const existing = itemToSegment.get(itemId);
    if (existing !== undefined) {
      return existing;
    }
    const segment = awaitingItem.shift() ?? (dead ? undefined : streamingSegment);
    if (segment === undefined || boundSegments.has(segment)) {
      return undefined;
    }
    itemToSegment.set(itemId, segment);
    boundSegments.add(segment);
    return segment;
  };

  const completeUserSegment = (segment: number, itemId: string, result: VoiceUserResult): void => {
    const index = pending.indexOf(segment);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    commitAt.delete(segment);
    itemToSegment.delete(itemId);
    cumulativeByItem.delete(itemId);
    boundSegments.delete(segment);
    callbacks.onUserFinal(segment, result);
    settleDrainIfIdle();
  };

  /** Flush a finished response's buffered audio (WAV-wrapped) + its transcript. */
  const flushResponse = (responseId: string): void => {
    activeResponses.delete(responseId);
    const chunks = audioByResponse.get(responseId);
    audioByResponse.delete(responseId);
    if (chunks && chunks.length > 0) {
      callbacks.onAudio({
        bytes: pcm16ToWav(concatChunks(chunks)),
        mime: "audio/wav",
        responseId,
      });
    }
    const transcript = transcriptByResponse.get(responseId);
    transcriptByResponse.delete(responseId);
    if (transcript && transcript.trim() !== "") {
      callbacks.onReplyTranscript(transcript, responseId);
    }
  };

  /** Session-wide fault: finalize every outstanding user segment loudly, then idle. */
  const fail = (message: string): void => {
    dead = true;
    const outstanding = pending.splice(0);
    awaitingItem.length = 0;
    for (const segment of outstanding) {
      commitAt.delete(segment);
      callbacks.onError(message, segment);
    }
    if (outstanding.length === 0) {
      callbacks.onError(message);
    }
    settleDrainIfIdle();
  };

  const handleMessage = (text: string): void => {
    let message: {
      type?: string;
      item_id?: string;
      response_id?: string;
      delta?: string;
      transcript?: string;
      response?: { id?: string };
    } & { error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return; // a malformed upstream frame — ignore rather than crash the thread
    }
    switch (message.type) {
      case "session.updated": {
        ready = true;
        for (const queued of outbox.splice(0)) {
          socket.send(queued);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = message.item_id ?? "";
        // Accumulate BEFORE the binding check: a delta with no segment to bind
        // to must still contribute its text, or the first bindable delta (and
        // the completed's fallback text) would start from a truncated tail.
        const cumulative = (cumulativeByItem.get(itemId) ?? "") + (message.delta ?? "");
        cumulativeByItem.set(itemId, cumulative);
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        callbacks.onUserDelta(segment, cumulative);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        const started = commitAt.get(segment) ?? now();
        completeUserSegment(segment, itemId, {
          text: message.transcript ?? cumulativeByItem.get(itemId) ?? "",
          latencyMs: Math.max(0, now() - started),
          model: options.transcriptionModel?.() ?? DEFAULT_VOICE_TRANSCRIPTION_MODEL,
        });
        return;
      }
      case "response.created": {
        const id = message.response?.id ?? message.response_id ?? "";
        if (id !== "") {
          activeResponses.add(id);
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
        const usage = usageFromRealtimeResponse(
          (message.response as { usage?: unknown } | undefined)?.usage,
        );
        if (usage) {
          callbacks.onUsage?.(priceCall("openai", options.model(), usage), id);
        }
        flushResponse(id);
        return;
      }
      case "error": {
        fail(message.error?.message ?? "realtime voice session error");
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
      const session: Record<string, unknown> = {
        type: "realtime",
        model: options.model(),
        instructions: options.instructions ?? DEFAULT_VOICE_INSTRUCTIONS,
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
        tools: [],
      };
      socket.send(JSON.stringify({ type: "session.update", session }));
    },
    onMessage: handleMessage,
    onError: (message: string) => fail(message),
    onClose: () => {
      if (!dead) {
        fail("realtime voice session closed");
      }
    },
  } satisfies RealtimeSocketHandlers);

  return {
    appendAudio(segment, bytes) {
      if (dead) {
        return;
      }
      // Marks this segment as the streaming one, where a pre-commit input
      // transcription delta's unseen item_id binds.
      streamingSegment = segment;
      sendReady({ type: "input_audio_buffer.append", audio: toBase64(bytes) });
    },
    commit(segment) {
      if (dead) {
        callbacks.onError("realtime voice session unavailable", segment);
        return;
      }
      if (streamingSegment === segment) {
        streamingSegment = undefined; // committed — no longer the pre-commit bind target
      }
      commitAt.set(segment, now());
      pending.push(segment);
      if (!boundSegments.has(segment)) {
        awaitingItem.push(segment); // pre-commit deltas may have bound it already
      }
      sendReady({ type: "input_audio_buffer.commit" });
      // Ask the model to reply — unless the per-thread cap is hit. The user
      // transcript (the IR) is captured regardless of the cap; only the model's
      // speaking is suppressed, and loudly noted once.
      if (responseCount < maxResponses) {
        responseCount += 1;
        sendReady({ type: "response.create" });
      } else if (!capNoted) {
        capNoted = true;
        callbacks.onError(
          `flagship response cap reached (${maxResponses} spoken replies this turn) — ` +
            "the model will stop answering aloud; dictation still lowers to the session",
        );
      }
    },
    discard(segment) {
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      boundSegments.delete(segment);
      for (const [itemId, bound] of itemToSegment) {
        if (bound === segment) {
          itemToSegment.delete(itemId);
          cumulativeByItem.delete(itemId);
          discardedItems.add(itemId);
        }
      }
      if (!dead) {
        sendReady({ type: "input_audio_buffer.clear" });
      }
    },
    cancelActiveResponse() {
      if (dead || activeResponses.size === 0) {
        return;
      }
      sendReady({ type: "response.cancel" });
      // The upstream will emit response.done for the cancelled response; drop the
      // buffered audio now so a barge-in doesn't replay a half-spoken reply.
      for (const id of activeResponses) {
        audioByResponse.delete(id);
        transcriptByResponse.delete(id);
      }
      activeResponses.clear();
    },
    drain(timeoutMs) {
      if (pending.length === 0) {
        return Promise.resolve([]);
      }
      return new Promise<number[]>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve([...pending]);
        };
        const timer = setTimeout(finish, timeoutMs);
        drainWaiters.push(finish);
      });
    },
    close() {
      dead = true;
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    },
  };
}
