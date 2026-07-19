/**
 * The **prompt-linter sidecar** — the one optional companion the unified
 * intent processor constructs when the hello asks for `linter != "off"`.
 *
 * The compiler (`composeIntent`) composes the prompt in EVERY configuration;
 * this sidecar only *observes* the same turn through a live conversational
 * session ({@link LiveSession}, Gemini or OpenAI in linter mode) and speaks
 * one short diagnostic at each pause (see
 * {@link ./live-session}.LINTER_INSTRUCTIONS — published verbatim in
 * docs/guide/prompt-linting.md). Its whole product is advisory:
 * `linter-note` events (+ reply audio), `linter-tool-call`/`-result` events,
 * and trace stages. Nothing here touches the chronicle's content or the
 * committed prompt.
 *
 * ### The converse turn contract (capture-bus-and-consumers.md; overhear retired 2026-07-19)
 *
 * The linter is ON-DEMAND: it accumulates silently and lints only when asked.
 * There is deliberately no automatic pause-lint anymore — the OVERHEAR
 * strategy (turn ends at each talk-end, with a transcript wait, a timeout,
 * and merge-on-resume) was retired by the owner; converse is the only mode:
 *
 *  1. `onTalkStart` opens the vendor window (once) and cancels any in-flight
 *     reply (client-side barge-in: a human talking wants to keep briefing).
 *     The window then stays open across talk segments — accumulation, not
 *     turn-taking; there is no `onTalkEnd`.
 *  2. `onTranscriptFinal` always injects `[transcript seg_N: "…"]` as SILENT
 *     context — the model judges the compiler's transcription, not just its
 *     own hearing. A final landing after a lint simply informs the next one
 *     (the accepted race: `lintNow` never waits for a pending final).
 *  3. {@link LinterSidecar.lintNow} — the button — ends the vendor turn; the
 *     model speaks ONE comprehensive lint over everything accumulated. When
 *     the reply completes ({@link LiveSessionCallbacks.onTurnComplete}) a
 *     `linter-turn-complete` event is pushed (the client's pulse settles).
 *  4. **Stay-on** (the after-reply policy): the linter remains on after each
 *     lint — talk again and the window reopens; press again and it lints
 *     again. The select is the only off switch.
 *  5. {@link LinterSidecar.lintStop} cancels an in-flight reply (the button
 *     barge-in) — abort this lint, keep accumulating.
 */
import {
  type LinterStageLabel,
  stageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import type { CallCost } from "./cost";
import { DEFAULT_GEMINI_LIVE_MODEL, openGeminiLiveSession } from "./gemini-live";
import { runConsumerToolCall } from "./linter-tools";
import {
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";
import type { LinterToolCall, LiveSession, LiveSessionCallbacks } from "./live-session";
import { DEFAULT_OPENAI_LIVE_MODEL, openOpenAiLiveSession } from "./openai-live";
import type { RealtimeSocketFactory } from "./realtime";

/** An intent event the sidecar produces (kept loose to avoid a cycle). */
type ProducedEvent = Record<string, unknown> & { at: number; type: string };

export interface LinterSidecarOptions {
  vendor: "openai" | "gemini";
  /** The VENDOR's key (never cross-sent — see IntentV1Options.geminiApiKey). */
  apiKey: string;
  /** Linter model id; absent → the vendor default. */
  model?: string;
  /** Persona override; absent → LINTER_INSTRUCTIONS. */
  instructions?: string;
  /** OpenAI linter voice id (absent → the model default). */
  voice?: string;
  /** The prompt cwd — `read_file`'s relative-path base. */
  promptCwd: string;
  /** Append a produced event to the chronicle (the processor's appendEvent). */
  appendEvent(event: ProducedEvent): void;
  /** Push produced events to the client (the processor's push). */
  push(events: ProducedEvent[]): void;
  /** Push one streamed reply chunk (the processor's pushSpeechChunk). */
  pushSpeechChunk(id: string, seq: number, mime: string, bytes: Uint8Array): void;
  /** Stop the client playing stream `id` (the processor's pushSpeechCancel). */
  pushSpeechCancel(id: string): void;
  /** Account a model call (the processor's recordCost). */
  recordCost(what: string, cost: CallCost | undefined): void;
  /** Surface a failure loudly (the processor wraps pushError). */
  onError(message: string, data?: unknown): void;
  /** Trace stages (the processor's trace, narrowed). The `label` is a
   *  {@link LinterStageLabel} so a new linter label must go through the shared
   *  contract's builders — it cannot bypass the vocabulary. */
  record?(stage: { kind: "info" | "ir"; label: LinterStageLabel; data: unknown }): void;
  /** Test seam: the upstream socket for the vendor engine. */
  socketFactory?: RealtimeSocketFactory;
  /** Test seam: replaces the whole engine (a scripted LiveSession). */
  openSession?(callbacks: LiveSessionCallbacks): LiveSession;
}

/** The hooks the unified processor calls at its existing seams. */
export interface LinterSidecar {
  /** A talk window opened: barge-in cancel + vendor window open (idempotent —
   * the window stays open across talk segments; accumulation, not turns). */
  onTalkStart(segment: number): void;
  /** One PCM16/24k frame from the mic (the same copy the STT session gets). */
  onAudioFrame(pcm: Uint8Array): void;
  /** A segment's final transcript landed (any transcriber) — always injected
   * as silent context; it informs the next lint. */
  onTranscriptFinal(segment: number, text: string): void;
  /** A deliberate shot's bytes arrived — inject labeled. */
  onShot(label: string, bytes: Uint8Array, mime: string): void;
  /** An app/code selection arrived or re-arrived under its marker. */
  onSelection(marker: string | undefined, entry: SelectionEntry, updated: boolean): void;
  /** A selection was retracted. */
  onSelectionDrop(marker: string | undefined): void;
  /**
   * THE lint trigger — the button. Ends the vendor turn over everything
   * accumulated; the reply's completion pushes `linter-turn-complete`, and
   * the linter STAYS ON (talk reopens the window; press again to lint
   * again). A no-op when no window is open (nothing was said to lint).
   */
  lintNow(): void;
  /** Cancel the in-flight reply (the button barge-in) — abort this lint,
   * keep accumulating. */
  lintStop(): void;
  /** Close the live session (fin / connection teardown). Idempotent. */
  close(): void;
}

export function createLinterSidecar(options: LinterSidecarOptions): LinterSidecar {
  const record = options.record ?? (() => {});
  let closed = false;
  let windowOpen = false;
  /** The most recent segment (the lint anchor when the button fires). */
  let lastSegment: number | undefined;
  /** The segment whose turn most recently ENDED — the one a lint is ABOUT.
   * Distinct from lastSegment: a reply can land after the user already
   * resumed (a new segment), and the note must anchor to the turn it
   * judged, not the one in progress. */
  let lintedSegment: number | undefined;
  /** The current reply STREAM: chunks share `lint_${noteSeq}` until the reply
   * completes (or is interrupted), then the ordinal bumps for the next one. */
  let noteSeq = 0;
  let chunkSeq = 0;
  let streamOpen = false;
  const stats = { segments: 0, notes: 0, toolCalls: 0, lintNows: 0 };

  /** The reply stream ended (turn complete / vendor barge-in): rotate the id. */
  const closeReplyStream = (cancelled: boolean): void => {
    if (!streamOpen) {
      return;
    }
    if (cancelled) {
      options.pushSpeechCancel(`lint_${noteSeq}`);
    }
    streamOpen = false;
    noteSeq += 1;
    chunkSeq = 0;
  };

  const onToolCall = (call: LinterToolCall): void => {
    stats.toolCalls += 1;
    // The shared execution policy (runConsumerToolCall) with the LINTER's
    // event/label vocabulary. The call event is held until the result half so
    // both push in one batch (the client sees the round-trip whole).
    let callEvent: ProducedEvent | undefined;
    runConsumerToolCall(call, options.promptCwd, {
      onCall: (tool, args) => {
        callEvent = { at: Date.now(), type: "linter-tool-call", tool, args };
        options.appendEvent(callEvent);
        record({ kind: "ir", label: stageLabel.linterToolCall(tool), data: args });
      },
      onResult: (ok, summary, content) => {
        const resultEvent: ProducedEvent = {
          at: Date.now(),
          type: "linter-tool-result",
          tool: call.tool,
          ok,
          summary,
        };
        options.appendEvent(resultEvent);
        options.push(callEvent !== undefined ? [callEvent, resultEvent] : [resultEvent]);
        // The FULL content the model read rides the trace — "anything
        // readable" is only honest because everything read is recorded.
        record(
          ok || content !== ""
            ? {
                kind: "ir",
                label: stageLabel.linterToolResult(),
                data: { ok, summary, content },
              }
            : { kind: "info", label: stageLabel.linterToolResult(), data: { ok, summary } },
        );
      },
    });
  };

  const callbacks: LiveSessionCallbacks = {
    onReplyTranscript: (text) => {
      stats.notes += 1;
      const note: ProducedEvent = {
        at: Date.now(),
        type: "linter-note",
        text,
        ...(lintedSegment !== undefined ? { segment: lintedSegment } : {}),
      };
      options.appendEvent(note);
      options.push([note]);
      record({
        kind: "info",
        label: stageLabel.linterNote(),
        data: { text, segment: lintedSegment },
      });
    },
    onReplyAudio: (bytes, mime) => {
      // STREAMED: each PCM chunk goes to the client the moment the vendor
      // produced it — the first audible byte no longer waits for the reply
      // to finish generating (whole-clip buffering retired 2026-07-19).
      streamOpen = true;
      options.pushSpeechChunk(`lint_${noteSeq}`, chunkSeq++, mime, bytes);
    },
    onInterrupted: () => {
      // The vendor's own barge-in (Gemini VAD): chunks already forwarded
      // cannot be un-sent — tell the client to stop playing them.
      closeReplyStream(true);
      record({ kind: "info", label: stageLabel.linterInterrupted(), data: {} });
    },
    onUsage: (cost) => {
      options.recordCost("linter response", cost);
    },
    onError: (message, data) => {
      record({ kind: "info", label: stageLabel.linterError(), data: { message } });
      options.onError(`prompt linter: ${message} — dictation still works`, data);
    },
    onGoAway: (msLeft) => {
      record({ kind: "info", label: stageLabel.linterGoAway(), data: { msLeft } });
    },
    onToolCall,
    onTurnComplete: () => {
      // Every lint turn is button-driven now, so every completion is worth
      // reporting: the client's pulse settles on it. STAY-ON is the policy —
      // nothing closes here; talk reopens the window, the button lints again.
      closeReplyStream(false); // the reply finished — the next one is a new stream
      const event: ProducedEvent = {
        at: Date.now(),
        type: "linter-turn-complete",
        ...(lintedSegment !== undefined ? { segment: lintedSegment } : {}),
      };
      options.appendEvent(event);
      options.push([event]);
      record({
        kind: "info",
        label: stageLabel.linterTurnComplete(),
        data: { segment: lintedSegment },
      });
    },
  };

  const session: LiveSession = options.openSession
    ? options.openSession(callbacks)
    : options.vendor === "gemini"
      ? openGeminiLiveSession(
          {
            apiKey: options.apiKey,
            model: () => options.model ?? DEFAULT_GEMINI_LIVE_MODEL,
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
            ...(options.socketFactory !== undefined
              ? { socketFactory: options.socketFactory }
              : {}),
          },
          callbacks,
        )
      : openOpenAiLiveSession(
          {
            apiKey: options.apiKey,
            model: () => options.model ?? DEFAULT_OPENAI_LIVE_MODEL,
            ...(options.voice !== undefined ? { voice: () => options.voice } : {}),
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
            ...(options.socketFactory !== undefined
              ? { socketFactory: options.socketFactory }
              : {}),
          },
          callbacks,
        );

  record({
    kind: "info",
    label: stageLabel.linterOpen(),
    data: { vendor: options.vendor, model: options.model ?? "(vendor default)" },
  });

  /** End the linter's vendor turn (the window closes; the model may speak). */
  const endTurn = (segment?: number): void => {
    if (!windowOpen) {
      return;
    }
    windowOpen = false;
    lintedSegment = segment ?? lastSegment;
    session.activityEnd();
    record({ kind: "info", label: stageLabel.linterTurnEnd(), data: { segment: lintedSegment } });
  };

  return {
    onTalkStart(segment) {
      if (closed) {
        return;
      }
      lastSegment = segment;
      stats.segments += 1;
      // Client-boundary barge-in: a human talking over the lint wants to keep
      // briefing, not listen to the rest of it. The LINTER runs manual VAD
      // (turn_detection: null) so the vendor cannot detect this itself — the
      // talk boundary is the one signal there is (the oracle, under server
      // VAD, deliberately has none of this: its vendor owns barge-in).
      session.cancelActiveResponse();
      closeReplyStream(true); // stop the client playing the stale reply
      // Accumulation, not turn-taking: the window opens once and stays open
      // across talk segments until the BUTTON ends it (there is no talk-end
      // hook — overhear retired 2026-07-19).
      if (!windowOpen) {
        windowOpen = true;
        session.activityStart();
      }
    },
    onAudioFrame(pcm) {
      if (closed || !windowOpen) {
        return;
      }
      session.appendAudio(pcm);
    },
    onTranscriptFinal(segment, text) {
      if (closed) {
        return;
      }
      if (text.trim() !== "") {
        // SILENT context — the exact transcription the compiler will use, so
        // a lint reconciles it against what the model heard. A final landing
        // after a lint informs the next one (the accepted lintNow race).
        session.injectContextText(`[transcript seg_${segment}: "${text}"]`);
        record({
          kind: "ir",
          label: stageLabel.linterTranscript(segment),
          data: { text },
        });
      }
    },
    onShot(label, bytes, mime) {
      if (closed) {
        return;
      }
      session.injectLabeledImage(label, bytes, mime);
      record({ kind: "info", label: stageLabel.linterLabel(label), data: { mime } });
    },
    onSelection(marker, entry, updated) {
      if (closed) {
        return;
      }
      const text = selectionInjectionLabel(marker, entry, updated);
      session.injectContextText(text);
      record({ kind: "info", label: stageLabel.linterSelection(), data: { text } });
    },
    onSelectionDrop(marker) {
      if (closed) {
        return;
      }
      const text = selectionRetractionLabel(marker);
      session.injectContextText(text);
      record({ kind: "info", label: stageLabel.linterSelectionRetracted(), data: { text } });
    },
    lintNow() {
      if (closed || !windowOpen) {
        return; // nothing was said into this window — nothing to lint
      }
      // Ends NOW — never waits for a pending STT final (the accepted race:
      // a final landing after this injects silently and informs the NEXT lint).
      stats.lintNows += 1;
      endTurn();
    },
    lintStop() {
      if (closed) {
        return;
      }
      session.cancelActiveResponse();
      closeReplyStream(true); // one mechanism: the server tells the client to stop
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      session.close();
      record({ kind: "info", label: stageLabel.linterClose(), data: stats });
    },
  };
}
