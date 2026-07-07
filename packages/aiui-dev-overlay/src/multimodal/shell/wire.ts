/**
 * The multimodal modality's **thread socket half** — framework-free plumbing
 * extracted from modality.ts (proposal B2.4), which composes it and remains
 * the only caller.
 *
 * One socket per thread, opened on thread-open. Outbound, the engine's event
 * log rides `chunk{kind:"events"}` JSON frames batched on a short debounce;
 * shot PNGs and whole audio segments ride `chunk{kind:"attachment"}` frames;
 * streamed PCM and sampled video frames ride `audio`/`video` chunks. Inbound,
 * the server's lowered echoes (`transcript-final`s, completed `correction`s,
 * pushed `speech` clips) merge into the engine stream as if local — guarded by
 * the `merging` reentrancy flag so a merge never re-streams itself. The
 * correction micro-pipeline (mock local / channel round-trip with its waiters
 * and timeout) lives here too, because its channel leg IS a wire round-trip.
 *
 * Owns its state (socket promise, outbox, debounce timer, pending correction
 * waiters); talks to the engine and the host context only through
 * {@link WireDeps}.
 */

import type { OverlayErrorInput } from "../../errors";
import type { IntentThread, OpenThreadOptions } from "../../intent";
import {
  type CorrectionTarget,
  composeIntent,
  type Engine,
  type IntentEvent,
  type IntentPipelineConfig,
} from "../../intent-pipeline";
import type { ThreadSocketState } from "../../overlay-tools";
import type { Ack, VideoChunk } from "../../protocol";
import { REALTIME_PCM_MIME } from "../audio";
import { type CorrectionDiff, mockCorrector } from "../correct";
import type { SpeechClip } from "../speech";
import { VIDEO_FRAME_MIME } from "../video";

/** How long to accumulate engine events before flushing an events chunk. */
const EVENTS_DEBOUNCE_MS = 60;
/** How long to wait for a correction echo before falling back to plain replace. */
const CORRECTION_TIMEOUT_MS = 8000;

interface PendingDiff {
  resolve: (diff: CorrectionDiff) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What the wire needs from its composer (modality.ts). */
export interface WireDeps {
  engine: Engine;
  /**
   * The live effective config. It is mutated **in place** by the modality's
   * `applyEffective`, so it must be read through this thunk at use time —
   * never destructured or copied at construction.
   */
  config: () => IntentPipelineConfig;
  /** `ctx.openThread` — a fresh connection + thread in this modality's format. */
  openThread: (options: OpenThreadOptions) => Promise<IntentThread>;
  /** `ctx.setStatus` — the panel-footer status line. */
  setStatus: (text: string) => void;
  /** `ctx.reportError` — the dismissible, deduping toast. */
  reportError: (error: OverlayErrorInput) => void;
  /** `ctx.clearSelection` — a selection is per-submission; the send consumes it. */
  clearSelection: () => void;
  /**
   * Play a server-pushed `speech` clip (the SpeechPlayer's enqueue). The
   * player is created after this module in the composer; pushes only arrive
   * post-mount, so a deferred thunk is safe.
   */
  enqueueSpeech: (clip: SpeechClip) => void;
}

/** The wire surface modality.ts (and, through it, talk/capture) drives. */
export interface Wire {
  /**
   * Feed one engine event through the wire: thread-open opens the socket, and
   * everything is queued on the debounce while a socket exists (and we are not
   * merging a server echo back in — that would re-stream it).
   */
  onEngineEvent(event: IntentEvent): void;
  /** The thread socket's lifecycle, surfaced in the overlay's report(). */
  socketState(): ThreadSocketState;
  /** The open thread, or undefined when none/opening failed (degraded mode). */
  getThread(): Promise<IntentThread | undefined>;
  /** Flush the outbox now, past the debounce (talk-end wants promptness). */
  flushOutbox(known?: IntentThread): Promise<void>;
  /** Upload a raw-binary attachment (a shot PNG / a whole audio segment). */
  uploadAttachment(id: string, mime: string, bytes: Uint8Array): Promise<void>;
  /** One captured PCM frame → an `audio` chunk on `seg_N`, in seq order. */
  uploadAudio(segment: number, seq: number, bytes: Uint8Array): Promise<void>;
  /** One sampled screen frame → a `video` chunk on `vid_N`, in seq order. */
  uploadVideo(share: number, seq: number, bytes: Uint8Array): Promise<void>;
  /** The correction micro-pipeline — assign to `engine.correctionPipeline`. */
  correctionPipeline(target: CorrectionTarget, instruction: string, via: "speech" | "typed"): void;
  /** The send path: flush, consume the selection, `fin`, surface the ack. */
  finalizeThread(): Promise<void>;
  /** Close the socket without `fin` (a cancel) and reset the wire state. */
  cancelThread(): Promise<void>;
  /** Unmount: cancel whatever thread is open. */
  dispose(): void;
}

export function createWire(deps: WireDeps): Wire {
  const { engine, config, setStatus, reportError, clearSelection, enqueueSpeech } = deps;

  // ── the wire: one socket per thread, opened on thread-open ───────────────
  let threadPromise: Promise<IntentThread> | undefined;
  // The thread socket's lifecycle, surfaced in the overlay's report().
  let threadState: ThreadSocketState = "none";
  const outbox: IntentEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let merging = false;
  const pendingDiffs: PendingDiff[] = [];

  const rememberError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`send unavailable: ${message}`);
  };

  /**
   * Surface a rejected frame — the server answered `ok:false` (thread
   * closed, decode failure, a processor throw, "connection closed" after a
   * drop). These acks used to be awaited and then dropped on the floor: the
   * turn kept composing while nothing was actually reaching the channel.
   * One toast per distinct error — the host dedupes, so a dead thread
   * rejecting every streamed PCM frame is one toast with a climbing ×N.
   */
  const reportBadAck = (what: string, ack: Ack): void => {
    if (ack.ok) {
      return;
    }
    reportError({
      source: "channel",
      message: `${what} rejected: ${ack.error ?? "unknown error"}`,
    });
  };

  const getThread = async (): Promise<IntentThread | undefined> => {
    if (!threadPromise) {
      return undefined;
    }
    try {
      return await threadPromise;
    } catch {
      return undefined;
    }
  };

  function openThreadSocket(): void {
    if (threadPromise) {
      return;
    }
    threadState = "connecting";
    // The effective config rides the hello (opaque `intent` meta) so the
    // trace records the whole configuration the events came from.
    threadPromise = deps
      .openThread({ intent: config() as unknown as Record<string, unknown> })
      .then((thread) => {
        threadState = "open";
        thread.onServerMessage((msg) => handleServerMessage(msg));
        return thread;
      });
    // Swallow the rejection here so it never surfaces as unhandled; callers
    // observe it via getThread() returning undefined.
    threadPromise.catch((error) => {
      threadState = "failed";
      rememberError(error);
    });
  }

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushOutbox();
    }, EVENTS_DEBOUNCE_MS);
  };

  const onEngineEvent = (event: IntentEvent): void => {
    if (event.type === "thread-open") {
      openThreadSocket();
    }
    if (threadPromise && !merging) {
      outbox.push(event);
      scheduleFlush();
    }
  };

  async function flushOutbox(known?: IntentThread): Promise<void> {
    const thread = known ?? (await getThread());
    if (!thread) {
      // No channel — composing continues locally; drop the un-sendable batch.
      outbox.length = 0;
      return;
    }
    if (outbox.length === 0) {
      return;
    }
    const batch = outbox.splice(0);
    try {
      reportBadAck(
        "event batch",
        await thread.sendChunk({ kind: "events" }, { events: batch }, false),
      );
    } catch (error) {
      rememberError(error);
    }
  }

  async function uploadAttachment(id: string, mime: string, bytes: Uint8Array): Promise<void> {
    const thread = await getThread();
    if (!thread) {
      return; // degraded: the shot/segment event still describes itself, no bytes
    }
    // Flush the correlated event first so the server has it when the bytes land.
    await flushOutbox(thread);
    try {
      reportBadAck(
        `attachment ${id}`,
        await thread.sendAttachment({ kind: "attachment", id, mime }, bytes, false),
      );
    } catch (error) {
      rememberError(error);
    }
  }

  async function uploadAudio(segment: number, seq: number, bytes: Uint8Array): Promise<void> {
    const thread = await getThread();
    if (!thread) {
      return; // degraded: no channel — realtimeTalkEnd reports it to the user
    }
    try {
      reportBadAck(
        "audio frame",
        await thread.sendAudio(
          { kind: "audio", id: `seg_${segment}`, seq, mime: REALTIME_PCM_MIME },
          bytes,
          false,
        ),
      );
    } catch (error) {
      rememberError(error);
    }
  }

  /** One sampled frame → a `video` chunk on the given share, in seq order. */
  async function uploadVideo(share: number, seq: number, bytes: Uint8Array): Promise<void> {
    const thread = await getThread();
    if (!thread) {
      return; // degraded: no channel — the share simply doesn't stream
    }
    const chunk: VideoChunk = {
      kind: "video",
      id: `vid_${share}`,
      seq,
      mime: VIDEO_FRAME_MIME,
    };
    try {
      reportBadAck("video frame", await thread.sendVideo(chunk, bytes, false));
    } catch (error) {
      rememberError(error);
    }
  }

  async function finalizeThread(): Promise<void> {
    const thread = await getThread();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!thread) {
      resetThread();
      // The socket never opened (or failed at thread-open — the host
      // toasted the cause then). The user just hit SEND, so re-surface the
      // consequence now: the toast dedupe folds a repeat into ×N.
      setStatus("composed locally — no channel connected to send to");
      reportError({
        source: "connection",
        message: "not sent — no channel connected (the turn was composed locally only)",
      });
      return;
    }
    await flushOutbox(thread);
    // The selection rode the stream as this turn's `app-selection` event
    // (no more send-time `context` chunk); a selection is per-submission,
    // so consume it now that the turn is committing.
    clearSelection();
    try {
      const ack = await thread.finish();
      if (ack.ok) {
        setStatus("sent ✓ — check the session (🔍 shows the lowering trace)");
      } else {
        setStatus(`send failed: ${ack.error ?? "unknown error"}`);
        reportBadAck("send (fin)", ack);
      }
    } catch (error) {
      // A fin that THROWS (vs. an ok:false ack) was the one send failure
      // that only reached the panel-footer status line — invisible with
      // the panel closed, i.e. exactly when the multimodal turn is used.
      rememberError(error);
      reportError({
        source: "channel",
        message: `send failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    resetThread();
  }

  async function cancelThread(): Promise<void> {
    const thread = threadPromise ? await getThread() : undefined;
    thread?.close();
    resetThread();
  }

  function resetThread(): void {
    threadPromise = undefined;
    threadState = "none";
    outbox.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const pending of pendingDiffs.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("thread ended before the correction echo arrived"));
    }
  }

  // ── server → client: merge lowered echoes as if they happened locally ────
  function handleServerMessage(msg: { kind: string; [key: string]: unknown }): void {
    if (msg.kind === "lowered" && Array.isArray(msg.events)) {
      mergeLowered(msg.events as IntentEvent[]);
    } else if (
      msg.kind === "speech" &&
      typeof msg.mime === "string" &&
      typeof msg.data === "string"
    ) {
      // A spoken clip (a premium ack / a flagship reply). Play it unless the
      // client muted audio-back (audioBack:"off"); read live so a config
      // switch takes effect immediately.
      if (config().audioBack !== "off") {
        enqueueSpeech({
          id: typeof msg.id === "string" ? msg.id : "speech",
          mime: msg.mime,
          data: msg.data,
          ...(typeof msg.label === "string" ? { label: msg.label } : {}),
        });
      }
    } else if (msg.kind === "lowered-prompt") {
      // Deliberately ignored: the overlay doesn't surface the final lowered
      // prompt (yet) — the workbench consumes this push server-side. See
      // LoweredPromptMessage in protocol.ts.
    }
  }

  function mergeLowered(events: IntentEvent[]): void {
    merging = true;
    try {
      for (const event of events) {
        if (event.type === "transcript-delta") {
          engine.transcriptDelta(event.segment, event.text);
        } else if (event.type === "transcript-final") {
          // Fills the preview for an uploaded segment; if a correction target
          // is still lassoed, the engine chains it into a correction.
          engine.transcriptFinal(event.segment, event.text, event.latencyMs, event.model);
        } else if (event.type === "correction") {
          resolveCorrectionEcho(event);
        } else if (event.type === "note") {
          setStatus(event.text);
        }
      }
    } finally {
      merging = false;
    }
  }

  function resolveCorrectionEcho(echo: Extract<IntentEvent, { type: "correction" }>): void {
    const waiter = pendingDiffs.shift();
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    if (echo.patch) {
      waiter.resolve({
        patch: echo.patch,
        model: echo.model ?? config().correctionModel,
        latencyMs: echo.latencyMs ?? 0,
      });
    } else {
      // No patch → the pipeline's plain-replacement fallback (never vanish).
      waiter.reject(new Error("correction echo had no patch"));
    }
  }

  const noteCorrectionFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    // A silent log entry (push, not emit) — never streamed nor rendered.
    engine.events.push({
      at: Date.now(),
      type: "note",
      text: `correction pipeline failed (${config().corrector}): ${message} — applied as plain replacement`,
    });
    // ...and a user-facing status, so the fallback to plain replacement is
    // never silent about why the model correction didn't land. The toast
    // repeats it because correcting happens with the panel closed (the
    // preview is page-level) — a status line nobody can see is not "loud".
    setStatus(`correction applied as plain replacement — ${message}`);
    reportError({
      source: "correction",
      message: `correction applied as plain replacement — ${message}`,
    });
  };

  /**
   * Apply a resolved correction to the preview + local doc WITHOUT
   * re-streaming it. Used for the channel corrector: the server already
   * produced this correction from the patchless request (it runs the diff
   * and merges the completed correction into its OWN stream), so streaming
   * the resolution too would make the server apply it twice.
   */
  const applyCorrectionLocally = (
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
    diff?: CorrectionDiff,
  ): void => {
    const wasMerging = merging;
    merging = true;
    try {
      engine.correction(target, instruction, via, diff);
    } finally {
      merging = wasMerging;
    }
  };

  // ── the correction micro-pipeline (mock local / channel round-trip) ──────
  const correctionPipeline = (
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
  ): void => {
    const allLines = composeIntent(engine.events, config().correctionPolicy)
      .items.filter((item) => item.kind === "text")
      .map((item) => item.text ?? "");
    // Scope the model's document to the active chunk (see the correction
    // event's `scope`): the patch stays context-anchored, so it lands in
    // the full transcript regardless.
    const docLines = target.scope
      ? allLines.slice(
          Math.max(0, target.scope.fromLine),
          Math.min(allLines.length, target.scope.toLine),
        )
      : allLines;
    if (config().corrector === "mock") {
      // Local patch: this correction event is the server's ONLY copy, so it
      // streams normally (the server, in mock mode, passes it through).
      void mockCorrector()
        .diff({ docLines, selected: target.original, instruction })
        .then((diff) => engine.correction(target, instruction, via, diff))
        .catch((error: unknown) => {
          noteCorrectionFailure(error);
          engine.correction(target, instruction, via);
        });
    } else {
      // Channel: the patchless request (sent inside requestChannelCorrection)
      // is what the server composes from; its echoed resolution is applied
      // locally only. A no-patch/timeout echo → plain replacement, also local.
      void requestChannelCorrection(target, instruction, via)
        .then((diff) => applyCorrectionLocally(target, instruction, via, diff))
        .catch((error: unknown) => {
          noteCorrectionFailure(error);
          applyCorrectionLocally(target, instruction, via, undefined);
        });
    }
  };

  /**
   * Channel corrector: stream the patchless correction as a request (an
   * events chunk, transient — not the engine's own event) and await the
   * server's patched echo. On timeout / no-patch, the pipeline above falls
   * back to plain replacement.
   */
  function requestChannelCorrection(
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
  ): Promise<CorrectionDiff> {
    return new Promise<CorrectionDiff>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = pendingDiffs.findIndex((p) => p.timer === timer);
        if (index >= 0) {
          pendingDiffs.splice(index, 1);
        }
        reject(new Error("correction timed out awaiting the channel echo"));
      }, CORRECTION_TIMEOUT_MS);
      const entry: PendingDiff = { resolve, reject, timer };
      pendingDiffs.push(entry);
      const reqEvent: IntentEvent = {
        at: Date.now(),
        type: "correction",
        from: target.from,
        to: target.to,
        original: target.original,
        instruction,
        via,
        ...(target.scope !== undefined ? { scope: target.scope } : {}),
      };
      void (async () => {
        const thread = await getThread();
        if (!thread) {
          const index = pendingDiffs.indexOf(entry);
          if (index >= 0) {
            pendingDiffs.splice(index, 1);
          }
          clearTimeout(timer);
          reject(new Error("no channel connected"));
          return;
        }
        await flushOutbox(thread);
        try {
          await thread.sendChunk({ kind: "events" }, { events: [reqEvent] }, false);
        } catch {
          // The timeout (or a later echo) settles this; nothing else to do.
        }
      })();
    });
  }

  return {
    onEngineEvent,
    socketState: () => threadState,
    getThread,
    flushOutbox,
    uploadAttachment,
    uploadAudio,
    uploadVideo,
    correctionPipeline,
    finalizeThread,
    cancelThread,
    dispose: () => {
      void cancelThread();
    },
  };
}
