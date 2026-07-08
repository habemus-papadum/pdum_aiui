/**
 * The multimodal modality's **thread socket half** — framework-free plumbing
 * extracted from modality.ts (proposal B2.4), which composes it and remains
 * the only caller.
 *
 * One socket per thread, opened on thread-open. Outbound, the engine's event
 * log rides `chunk{kind:"events"}` JSON frames batched on a short debounce;
 * shot PNGs and whole audio segments ride `chunk{kind:"attachment"}` frames;
 * streamed PCM and sampled video frames ride `audio`/`video` chunks. Inbound,
 * the server's lowered echoes (`transcript-delta`s/`-final`s, pushed `speech`
 * clips) merge into the engine stream as if local — guarded by the `merging`
 * reentrancy flag so a merge never re-streams itself.
 *
 * Owns its state (socket promise, outbox, debounce timer); talks to the
 * engine and the host context only through {@link WireDeps}.
 */

import type { OverlayErrorInput } from "../../errors";
import type { IntentThread, OpenThreadOptions } from "../../intent";
import type { Engine, IntentEvent, IntentPipelineConfig } from "../../intent-pipeline";
import type { ThreadSocketState } from "../../overlay-tools";
import type { Ack, VideoChunk } from "../../protocol";
import { REALTIME_PCM_MIME } from "../audio";
import type { SpeechClip } from "../speech";
import { VIDEO_FRAME_MIME } from "../video";

/** How long to accumulate engine events before flushing an events chunk. */
const EVENTS_DEBOUNCE_MS = 60;

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
      // A spoken clip. The gate depends on WHOSE voice it is: a linter note
      // (`lint_N`) is the linter's product and plays whenever the linter is
      // on — `audioBack` is the TTS-ack knob and must not mute it (the
      // silent-linter bug). Everything else (acks) honors audioBack. Read
      // live so a config switch takes effect immediately.
      const isLinterClip = typeof msg.id === "string" && msg.id.startsWith("lint_");
      if (isLinterClip ? (config().linter ?? "off") !== "off" : config().audioBack !== "off") {
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
          // Fills the preview for an uploaded segment (word timestamps +
          // logprobs ride along for the heat map and the compiler's anchors).
          engine.transcriptFinal(
            event.segment,
            event.text,
            event.latencyMs,
            event.model,
            event.words,
          );
        } else if (event.type === "note") {
          setStatus(event.text);
        } else if (event.type === "linter-note") {
          // The lint: a 💡 chip in the accumulator preview (via the engine
          // stream) and the status line; the spoken clip rides `speech`.
          engine.ingestLinter(event);
          setStatus(`💡 ${event.text}`);
        } else if (event.type === "linter-tool-call" || event.type === "linter-tool-result") {
          // Trace/debug material — chronicled so the turn store and the
          // debugger see it; no chip renders (the trace viewer is its surface).
          engine.ingestLinter(event);
        }
      }
    } finally {
      merging = false;
    }
  }

  return {
    onEngineEvent,
    socketState: () => threadState,
    getThread,
    flushOutbox,
    uploadAttachment,
    uploadAudio,
    uploadVideo,
    finalizeThread,
    cancelThread,
    dispose: () => {
      void cancelThread();
    },
  };
}

// HMR guard: the mounted intent tool holds RUNNING closures from this module,
// and a hot swap would strand them on stale code while fresh modules load
// around them (the silent-stale-tab footgun: pushes flow, the view ignores
// them). Declining makes any edit here a full page reload — mount-once code
// has no meaningful hot path.
if (import.meta.hot) {
  import.meta.hot.decline();
}
