/**
 * The `intent-v1` turn context: the single shared, MUTABLE state a lowering turn
 * accumulates, plus the helper surface every wing (STT, linter, fin) reads and
 * writes through it.
 *
 * This object is the split's one genuinely-new abstraction. The processor and its
 * handler modules used to close over a common set of `let`s; they now read that
 * state through {@link IntentTurn} instead. Two invariants make the indirection
 * load-bearing rather than cosmetic:
 *
 *  - `events` is REASSIGNED wholesale (`applyShotPaths` maps it; `reset` drops
 *    it), so it must always be read through the object — never destructured or
 *    captured by value, or a handler freezes on a stale array.
 *  - `realtime` and `sidecar` are reassignable slots (opened after construction,
 *    the sidecar swapped live by a mid-thread control chunk), read through the
 *    object for the same reason.
 *
 * The speculative-compose cache (`mutationSeq`/`composedSeq`/`lastComposed`) is a
 * latency shim, never a source of truth: `recompose` produces exactly what a
 * fresh `composeIntent(events)` would, and speculation only ever populates the
 * cache and the trace — never a send, a push, or a paid re-run.
 */
import {
  type ComposedIntent,
  type ComposeOptions,
  composeIntent,
  type IntentEvent,
} from "@habemus-papadum/aiui-lowering-pipeline";
import {
  type ComposedSpeculativeData,
  type SpeechData,
  stageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import { pushError, type ThreadContext } from "./channel";
import type { CallCost } from "./cost";
import type { LoweredMessage, SpeechMessage } from "./intent-messages";
import type { ResolvedIntent } from "./intent-resolve";
import { ordinalOf } from "./intent-stream-util";
import type { LinterSidecar } from "./linter-sidecar";
import type { RealtimeSession } from "./realtime";
import type { TraceHandle } from "./trace";

export interface IntentTurn {
  /**
   * The turn's single accumulated stream, in arrival order — client events
   * interleaved with server-produced ones (transcripts, completed corrections)
   * exactly where they were produced. This *is* the merge the fin lowering runs.
   * REASSIGNED wholesale by {@link IntentTurn.applyShotPaths} and
   * {@link IntentTurn.reset}; always read it through the object.
   */
  events: IntentEvent[];
  /**
   * Absolute path of each shot's saved blob. Populated on the shot's arrival
   * (its bytes are saved then, not at fin) and wired into the matching shot
   * event so fin does no disk I/O.
   */
  shotPaths: Map<string, string>;
  /**
   * Accumulated PCM frames per streaming segment — saved as one blob at commit so
   * the debugger has the audio (the realtime analogue of the REST seg blob).
   */
  audioFrames: Map<number, { chunks: Uint8Array[]; bytes: number; lastSeq: number }>;
  /** Bumps on every change to `events` (an append or a shot-path wiring). */
  mutationSeq: number;
  /** The `mutationSeq` the cache was last snapshotted at (−1 = never). */
  composedSeq: number;
  /** The cached speculative fold; reused at fin when the log is unchanged since. */
  lastComposed: ComposedIntent | undefined;
  /** Monotonic id for TTS-ack clips pushed to the client (`ack_0`, `ack_1`, …). */
  ackSeq: number;
  /**
   * The per-thread realtime session. Segments stream PCM into it during talk and
   * commit at talk-end. Reassignable slot, opened after construction.
   */
  realtime: RealtimeSession | undefined;
  /**
   * The prompt-linter sidecar. Reassignable slot: a mid-thread control chunk can
   * start / stop / swap it live.
   */
  sidecar: LinterSidecar | undefined;

  /** Append one event to the stream and bump the mutation counter. */
  appendEvent(event: IntentEvent): void;
  /** Wire every known shot path into the current events (idempotent). */
  applyShotPaths(): void;
  /**
   * Speculative fold of the merged stream so far. Pure and side-effect-free
   * beyond the cache + a trace stage (the invariant: speculation never sends,
   * pushes, or spends). fin reuses this when the log is unchanged since.
   */
  recompose(): void;
  /** Recompose only if the log changed since the last cache — the arrival seam. */
  recomposeIfStale(): void;
  /** Push a batch of server-produced events for the client to merge. */
  push(produced: IntentEvent[]): void;
  /**
   * Account one model call: a `cost:` trace stage (what/usage/usd — the trace
   * viewer renders these as 💰 cards) plus the manifest's running roll-up.
   * Unpriced calls (a model missing from the catalog) still record usage; only
   * a priced call moves the roll-up. Post-end callers (the summary gloss) get
   * the roll-up but no stage — `record` is closed by then, by design.
   */
  recordCost(what: string, cost: CallCost | undefined): void;
  /** Push a base64 audio clip for the client to play (TTS ack / model reply). */
  pushSpeech(id: string, mime: string, bytes: Uint8Array, label?: string): void;
  /**
   * Finalize a segment we could not transcribe: echo an empty `transcript-final`
   * (so the client's preview resolves instead of waiting for an echo that will
   * never come) plus a `note` the widget shows in its status — and push the
   * same text as a generic error (see {@link pushError}) so the failure is
   * visible even with the panel closed (the note only reaches the footer
   * status line). Degradation is loud and specific — never a silent drop,
   * never a silent switch to mock.
   */
  finalizeSilentSegment(
    id: string,
    noteText: string,
    error?: { source: string; detail?: string },
  ): void;
  /**
   * Drop the in-memory speculative state (the {@link StreamProcessor.onClose}
   * teardown of an abandoned turn). Does not touch `realtime`/`sidecar` — the
   * caller closes those.
   */
  reset(): void;
}

/**
 * Build the turn context for one processor. Captures the thread context, the
 * trace handle, the resolved hello config, and the compose options; the returned
 * object owns the mutable turn state and the helper surface over it.
 */
export function createIntentTurn(
  ctx: ThreadContext,
  trace: TraceHandle | undefined,
  intent: ResolvedIntent,
  composeOptions: ComposeOptions,
): IntentTurn {
  const turn: IntentTurn = {
    events: [],
    shotPaths: new Map<string, string>(),
    audioFrames: new Map<number, { chunks: Uint8Array[]; bytes: number; lastSeq: number }>(),
    mutationSeq: 0,
    composedSeq: -1,
    lastComposed: undefined,
    ackSeq: 0,
    realtime: undefined,
    sidecar: undefined,

    appendEvent: (event) => {
      turn.events.push(event);
      turn.mutationSeq += 1;
    },

    applyShotPaths: () => {
      if (turn.shotPaths.size === 0) {
        return;
      }
      let changed = false;
      turn.events = turn.events.map((event) => {
        if (
          event.type === "shot" &&
          turn.shotPaths.has(event.marker) &&
          event.path !== turn.shotPaths.get(event.marker)
        ) {
          changed = true;
          return { ...event, path: turn.shotPaths.get(event.marker) };
        }
        return event;
      });
      if (changed) {
        turn.mutationSeq += 1;
      }
    },

    recompose: () => {
      turn.lastComposed = composeIntent(turn.events, "replace", composeOptions);
      turn.composedSeq = turn.mutationSeq;
      trace?.record({
        kind: "ir",
        label: stageLabel.composedSpeculative(),
        // The speculative prompt is the BODY only (no context preamble yet), so
        // its spans are composeIntent's body spans as-is — the hero renders them
        // over the body while the turn is still in flight.
        data: {
          transcript: turn.lastComposed.transcript,
          prompt: turn.lastComposed.prompt,
          spans: turn.lastComposed.spans,
        } satisfies ComposedSpeculativeData,
      });
    },

    recomposeIfStale: () => {
      if (turn.composedSeq !== turn.mutationSeq) {
        turn.recompose();
      }
    },

    push: (produced) => {
      ctx.push?.({
        kind: "lowered",
        threadId: ctx.threadId,
        events: produced,
      } satisfies LoweredMessage);
    },

    recordCost: (what, cost) => {
      if (!cost) {
        return;
      }
      trace?.record({ kind: "info", label: stageLabel.cost(what), data: cost });
      if (cost.usd !== undefined) {
        trace?.addCost(cost.usd);
      }
    },

    pushSpeech: (id, mime, bytes, label) => {
      ctx.push?.({
        kind: "speech",
        threadId: ctx.threadId,
        id,
        mime,
        data: Buffer.from(bytes).toString("base64"),
        ...(label !== undefined ? { label } : {}),
      } satisfies SpeechMessage);
      trace?.record({
        kind: "info",
        label: stageLabel.speech(id),
        data: {
          mime,
          bytes: bytes.length,
          ...(label !== undefined ? { text: label } : {}),
        } satisfies SpeechData,
      });
    },

    finalizeSilentSegment: (id, noteText, error = { source: "transcription" }) => {
      const empty: IntentEvent = {
        at: Date.now(),
        type: "transcript-final",
        segment: ordinalOf(id),
        text: "",
        latencyMs: 0,
        model: intent.model,
      };
      turn.appendEvent(empty);
      turn.push([empty, { at: Date.now(), type: "note", text: noteText }]);
      pushError(ctx, {
        source: error.source,
        message: noteText,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
      });
    },

    reset: () => {
      turn.events = [];
      turn.shotPaths.clear();
      turn.lastComposed = undefined;
      turn.audioFrames.clear();
    },
  };
  return turn;
}
