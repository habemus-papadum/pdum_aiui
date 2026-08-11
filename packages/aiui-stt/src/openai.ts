/**
 * openai.ts — the ALTERNATE engine: OpenAI `transcription`-type realtime
 * sessions, the browser-side port of the channel's `realtime.ts` (GA wire
 * shape, live-verified there; the browser deltas are auth and address).
 *
 * Browser auth (verified 2026-08-07, recorded in the aiui-cf-creds
 * proposal): an `ek_` client secret presented as the
 * `openai-insecure-api-key.<ek_>` WebSocket SUBPROTOCOL — browsers cannot
 * set headers — alongside the standard `"realtime"` protocol entry. The
 * connect URL is BARE `wss://api.openai.com/v1/realtime`: a
 * transcription-type secret carries its session config from mint time, and
 * the session type rides the secret, not the URL. The config baked at mint
 * is a DEFAULT, not a sandbox, so this engine still asserts its full config
 * with one `session.update` on open — PCM format, `turn_detection: null`
 * (the client commits; PTT owns the boundary), token logprobs on — and
 * verifies the `session.updated` echo rather than trusting silence.
 *
 * Wire facts preserved from the channel port (see its header post-mortems):
 * deltas are INCREMENTAL (`delta` appended into a per-item cumulative);
 * `item_id` correlates a committed segment's events, with pre-commit deltas
 * binding to the segment streaming right now; `…transcription.failed` is a
 * real event that must resolve its segment loudly; unknown item ids with
 * every candidate bound are reported as orphan results, never dropped.
 *
 * The credential seam is the oracle's {@link KeySource}, reused verbatim —
 * one `ek_` opens multiple sessions until TTL, so a caching source is
 * correct and reconnects inside the TTL skip the mint.
 */

import type { KeySource } from "@habemus-papadum/aiui-oracle";
import {
  browserSocketFactory,
  closeSuffix,
  createDrainController,
  createReadyGate,
  reportSessionFailure,
  type SttSocketFactory,
  toBase64,
} from "./support";
import type { SttCallbacks, SttCapabilities, SttConnection, SttTransport, SttWord } from "./types";

/**
 * The bare GA realtime endpoint. NOT the channel's `?intent=transcription`
 * form — that belongs to parent-key auth; a transcription-type `ek_` carries
 * the session type itself (probe-verified, aiui-cf-creds proposal).
 */
export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** The default transcription model — the channel's proven default. */
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

/** The wire's PCM rate (both directions of this package standardize on it). */
export const OPENAI_SAMPLE_RATE = 24000;

export const OPENAI_CAPABILITIES: SttCapabilities = {
  wordTimestamps: false, // no timestamps on this wire
  wordLogprobs: true, // token logprobs folded to words
  languageHint: false,
  keyterms: false,
  vendorVad: false, // turn_detection: null — the client commits
};

/**
 * Fold OpenAI's TOKEN-level transcription logprobs into WORD-level
 * {@link SttWord}s (no timestamps on this wire). A word's confidence is its
 * WORST token (min logprob) — one unsure token is what makes a word worth
 * re-speaking; averaging would hide it. Tolerant by design: malformed input
 * → undefined, and any drift between token concatenation and the final text
 * degrades to no words rather than mislabeling them.
 *
 * (Ported verbatim from the channel — the ~40-line copy the aiui-stt
 * proposal's open question 3 predicted would be cheaper than a shared
 * package. Divergence is guarded by both packages' tests.)
 */
export function wordsFromTokenLogprobs(text: string, raw: unknown): SttWord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const tokens: Array<{ token: string; logprob: number }> = [];
  for (const entry of raw) {
    const t = (entry ?? {}) as { token?: unknown; logprob?: unknown };
    if (typeof t.token !== "string" || typeof t.logprob !== "number") {
      return undefined;
    }
    tokens.push({ token: t.token, logprob: t.logprob });
  }
  const words: SttWord[] = [];
  let wordText = "";
  let worst = Number.POSITIVE_INFINITY;
  const flush = (): void => {
    const trimmed = wordText.trim();
    if (trimmed !== "") {
      words.push({ text: trimmed, logprob: worst });
    }
    wordText = "";
    worst = Number.POSITIVE_INFINITY;
  };
  for (const { token, logprob } of tokens) {
    // A token may span a word boundary (" readings"): split on whitespace,
    // flushing the word in progress at each gap.
    const parts = token.split(/(\s+)/);
    for (const part of parts) {
      if (part === "") {
        continue;
      }
      if (/^\s+$/.test(part)) {
        flush();
      } else {
        wordText += part;
        worst = Math.min(worst, logprob);
      }
    }
  }
  flush();
  // Sanity: the folded words must reassemble the transcript, or the labeling
  // would lie — degrade to no words instead.
  const rebuilt = words.map((w) => w.text).join(" ");
  const normalized = text.trim().split(/\s+/).join(" ");
  return rebuilt === normalized ? words : undefined;
}

/**
 * Diff the `session.update` we sent against the echoed `session.updated`.
 * OpenAI rejects unknown params — but happily accepts a known one and
 * applies a different value, and `turn_detection: null` (the entire
 * manual-commit premise) is exactly the thing worth proving.
 */
export function checkOpenaiConfigEcho(
  requested: { model: string; turnDetection: null },
  echo: unknown,
): Array<{ param: string; requested: unknown; echoed: unknown }> {
  const input = (echo as { audio?: { input?: Record<string, unknown> } } | undefined)?.audio?.input;
  if (input === undefined) {
    return [];
  }
  const out: Array<{ param: string; requested: unknown; echoed: unknown }> = [];
  if (input.turn_detection != null) {
    out.push({
      param: "turn_detection",
      requested: requested.turnDetection,
      echoed: input.turn_detection,
    });
  }
  const model = (input.transcription as { model?: unknown } | undefined)?.model;
  if (model !== undefined && model !== requested.model) {
    out.push({ param: "transcription.model", requested: requested.model, echoed: model });
  }
  return out;
}

export interface OpenaiTranscriptionTransportOptions {
  /** The oracle's credential seam, reused verbatim (chain/caching compose). */
  keySource: KeySource;
  /** Default {@link DEFAULT_OPENAI_TRANSCRIPTION_MODEL}. */
  transcriptionModel?: string;
  /** The latency/accuracy knob — a `gpt-realtime-whisper`-ONLY param (other
   * models over this wire reject it); omitted when unset. */
  delay?: string;
  /** Override the endpoint (tests). */
  url?: string;
  /** Injected socket (tests); defaults to the platform WebSocket. */
  socketFactory?: SttSocketFactory;
  /** Injected clock (tests). */
  now?: () => number;
}

/** Build the wire session config — both the mint's baked default and the
 * `session.update` this engine asserts on open. */
export function openaiTranscriptionSession(config: {
  model: string;
  delay?: string;
}): Record<string, unknown> {
  const transcription: Record<string, unknown> = { model: config.model };
  if (
    config.model === "gpt-realtime-whisper" &&
    typeof config.delay === "string" &&
    config.delay !== ""
  ) {
    transcription.delay = config.delay;
  }
  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
        transcription,
        turn_detection: null,
      },
    },
    // Token-level confidence on every completed transcript (folded to word
    // level by {@link wordsFromTokenLogprobs}).
    include: ["item.input_audio_transcription.logprobs"],
  };
}

/**
 * The alternate engine. Each open mints/reuses an `ek_` through the injected
 * {@link KeySource} (which sees the wire session config, so the secret's
 * baked default matches what the engine asserts) and connects with the
 * browser subprotocol presentation.
 */
export function openaiTranscriptionTransport(
  options: OpenaiTranscriptionTransportOptions,
): SttTransport {
  return {
    name: "openai-transcription",
    capabilities: OPENAI_CAPABILITIES,
    async open(callbacks) {
      const model = options.transcriptionModel ?? DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
      const session = openaiTranscriptionSession({
        model,
        ...(options.delay !== undefined ? { delay: options.delay } : {}),
      });
      const credential = await options.keySource.credential(session);
      return openOpenaiConnection(
        {
          url: options.url ?? OPENAI_REALTIME_URL,
          protocols: ["realtime", `openai-insecure-api-key.${credential.ek}`],
          model,
          session,
          socketFactory: options.socketFactory ?? browserSocketFactory,
          now: options.now ?? Date.now,
        },
        callbacks,
      );
    },
  };
}

function openOpenaiConnection(
  config: {
    url: string;
    protocols: string[];
    model: string;
    session: Record<string, unknown>;
    socketFactory: SttSocketFactory;
    now: () => number;
  },
  callbacks: SttCallbacks,
): SttConnection {
  const { now } = config;
  const gate = createReadyGate((text) => socket.send(text));

  // Committed segments awaiting a `…completed`, in commit order.
  const pending: number[] = [];
  // Committed segments not yet bound to an upstream item_id, in commit order.
  const awaitingItem: number[] = [];
  // The segment whose audio is streaming right now — where a pre-commit
  // delta's unseen item_id binds.
  let streamingSegment: number | undefined;
  // Segments already bound to an item_id (until their `…completed`).
  const boundSegments = new Set<number>();
  const commitAt = new Map<number, number>();
  const itemToSegment = new Map<string, number>();
  const cumulativeByItem = new Map<string, string>();
  // Items whose segment was discarded: late events for them must drop.
  const discardedItems = new Set<string>();
  const drainCtl = createDrainController(() => [...pending]);

  const sendAudioMessage = (message: object): void => gate.send(JSON.stringify(message));

  /**
   * Bind an unseen upstream item to its segment: the oldest still-unbound
   * committed segment first (items are created in buffer = commit order),
   * else the segment streaming right now (the GA models emit partials while
   * audio is still appending — the entire point of the streaming tier).
   */
  const segmentForItem = (itemId: string): number | undefined => {
    if (discardedItems.has(itemId)) {
      return undefined;
    }
    const existing = itemToSegment.get(itemId);
    if (existing !== undefined) {
      return existing;
    }
    const segment = awaitingItem.shift() ?? (gate.isDead() ? undefined : streamingSegment);
    if (segment === undefined || boundSegments.has(segment)) {
      return undefined;
    }
    itemToSegment.set(itemId, segment);
    boundSegments.add(segment);
    return segment;
  };

  const completeSegment = (
    segment: number,
    itemId: string,
    result: { text: string; latencyMs: number; model: string; words?: SttWord[] },
  ): void => {
    const index = pending.indexOf(segment);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    commitAt.delete(segment);
    itemToSegment.delete(itemId);
    cumulativeByItem.delete(itemId);
    boundSegments.delete(segment);
    callbacks.onFinal(segment, result);
    drainCtl.settleIfIdle();
  };

  /** Session-wide fault: settle every outstanding segment loudly, then idle. */
  const fail = (message: string): void => {
    gate.markDead();
    const outstanding = pending.splice(0);
    awaitingItem.length = 0;
    for (const segment of outstanding) {
      commitAt.delete(segment);
    }
    reportSessionFailure(callbacks.onError, message, outstanding);
    drainCtl.settleIfIdle();
  };

  const handleMessage = (text: string): void => {
    let message: { type?: string; item_id?: string; delta?: string; transcript?: string } & {
      error?: { message?: string };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return; // a malformed upstream frame — ignore rather than crash
    }
    switch (message.type) {
      case "session.created": {
        // The secret's baked default, applied. Informational — readiness is
        // the `session.updated` that answers OUR assert.
        return;
      }
      case "session.updated": {
        const session = (message as { session?: unknown }).session;
        if (session && typeof session === "object") {
          callbacks.onDiagnostic?.({
            kind: "config-echo",
            config: session as Record<string, unknown>,
          });
          const mismatches = checkOpenaiConfigEcho(
            { model: config.model, turnDetection: null },
            session,
          );
          for (const m of mismatches) {
            callbacks.onDiagnostic?.({ kind: "config-mismatch", ...m });
          }
        }
        gate.markReady();
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = message.item_id ?? "";
        // Accumulate BEFORE the binding check: an unbindable delta must still
        // contribute its text, or the first bindable one starts truncated.
        const cumulative = (cumulativeByItem.get(itemId) ?? "") + (message.delta ?? "");
        cumulativeByItem.set(itemId, cumulative);
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          return;
        }
        callbacks.onDelta(segment, cumulative);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        if (segment === undefined) {
          callbacks.onDiagnostic?.({
            kind: "orphan-result",
            messageType: message.type,
            chars: (message.transcript ?? "").length,
          });
          return;
        }
        const started = commitAt.get(segment) ?? now();
        const transcript = message.transcript ?? cumulativeByItem.get(itemId) ?? "";
        const words = wordsFromTokenLogprobs(
          transcript,
          (message as { logprobs?: unknown }).logprobs,
        );
        completeSegment(segment, itemId, {
          text: transcript,
          latencyMs: Math.max(0, now() - started),
          model: config.model,
          ...(words !== undefined ? { words } : {}),
        });
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        // The segment's audio was received but transcription failed —
        // unhandled it would sit in `pending` until the drain timeout,
        // indistinguishable from silence. Attribute it to its segment.
        const itemId = message.item_id ?? "";
        const segment = segmentForItem(itemId);
        const reason = message.error?.message ?? "transcription failed";
        if (segment === undefined) {
          callbacks.onError(reason);
          return;
        }
        const index = pending.indexOf(segment);
        if (index >= 0) {
          pending.splice(index, 1);
        }
        commitAt.delete(segment);
        itemToSegment.delete(itemId);
        cumulativeByItem.delete(itemId);
        boundSegments.delete(segment);
        callbacks.onError(reason, segment);
        drainCtl.settleIfIdle();
        return;
      }
      case "error": {
        fail(message.error?.message ?? "realtime session error");
        return;
      }
      default:
        // Everything not understood is reported — the habit that would have
        // caught Scribe's self-commits.
        callbacks.onDiagnostic?.({
          kind: "unhandled",
          messageType: message.type ?? "(none)",
          raw: text.slice(0, 500),
        });
        return;
    }
  };

  const socket = config.socketFactory(config.url, config.protocols, {
    onOpen: () => {
      // Assert the full config over the secret's baked default; readiness is
      // the echoed `session.updated`.
      socket.send(JSON.stringify({ type: "session.update", session: config.session }));
    },
    onMessage: handleMessage,
    onError: (message) => fail(message),
    onClose: (code, reason) => {
      if (!gate.isDead()) {
        fail(`realtime session closed${closeSuffix(code, reason)}`);
      }
    },
  });

  return {
    appendAudio(segment, bytes) {
      if (gate.isDead()) {
        return;
      }
      // The ordinal isn't carried upstream (the buffer is implicit) — it
      // marks this segment as the streaming one for pre-commit binding.
      streamingSegment = segment;
      sendAudioMessage({ type: "input_audio_buffer.append", audio: toBase64(bytes) });
    },
    commit(segment) {
      if (gate.isDead()) {
        callbacks.onError("realtime session unavailable", segment);
        return;
      }
      if (streamingSegment === segment) {
        streamingSegment = undefined;
      }
      commitAt.set(segment, now());
      pending.push(segment);
      if (!boundSegments.has(segment)) {
        awaitingItem.push(segment); // pre-commit deltas may have bound it already
      }
      sendAudioMessage({ type: "input_audio_buffer.commit" });
    },
    discard(segment) {
      // OpenAI HAS a buffer-clear — the wire-level asymmetry vs Scribe: the
      // stray frames are wiped so they can't prepend to the next segment.
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
      if (!gate.isDead()) {
        sendAudioMessage({ type: "input_audio_buffer.clear" });
      }
    },
    drain(timeoutMs) {
      return drainCtl.drain(timeoutMs);
    },
    close() {
      gate.markDead();
      try {
        socket.close();
      } catch {
        // best-effort — the socket may already be closing
      }
      drainCtl.releaseAll();
    },
  };
}
