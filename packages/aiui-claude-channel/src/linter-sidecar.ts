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
 * ### The turn-end lint sequence (the state machine)
 *
 * The linter must judge the transcription the compiler will actually use —
 * not its own hearing — so a talk window does NOT end the linter's turn by
 * itself:
 *
 *  1. `onTalkEnd(seg)` arms `pendingEnd` (the STT commit races us).
 *  2. `onTranscriptFinal(seg, text)` inside {@link TRANSCRIPT_WAIT_MS} injects
 *     `[transcript seg_N: "…"]` as SILENT context, then ends the vendor turn
 *     (`activityEnd`) — the model now lints hearing + transcript together.
 *  3. The timeout ends the turn without the transcript (traced); a LATE final
 *     still injects silently, so the next lint sees it.
 *  4. `onTalkStart` while `pendingEnd` is armed MERGES: the human resumed
 *     before the lint fired — one longer window, no turn boundary (traced).
 *
 * `onTalkStart` also cancels any in-flight reply (client-side barge-in): a
 * human talking over the lint wants to keep briefing, not listen.
 */
import type { CallCost } from "./cost";
import { DEFAULT_GEMINI_LIVE_MODEL, openGeminiLiveSession } from "./gemini-live";
import { executeReadFile, READ_FILE_TOOL_NAME } from "./linter-tools";
import {
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";
import type { LinterToolCall, LiveSession, LiveSessionCallbacks } from "./live-session";
import { DEFAULT_OPENAI_LIVE_MODEL, openOpenAiLiveSession } from "./openai-live";
import type { RealtimeSocketFactory } from "./realtime";

/**
 * How long a talk-end waits for its segment's transcript-final before the
 * linter's turn ends without it. STT finals normally land well inside this;
 * the ceiling keeps a wedged transcription from wedging the lint.
 */
export const TRANSCRIPT_WAIT_MS = 2500;

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
  /** Push a spoken clip (the processor's pushSpeech). */
  pushSpeech(id: string, mime: string, bytes: Uint8Array, label?: string): void;
  /** Account a model call (the processor's recordCost). */
  recordCost(what: string, cost: CallCost | undefined): void;
  /** Surface a failure loudly (the processor wraps pushError). */
  onError(message: string, data?: unknown): void;
  /** Trace stages (the processor's trace, narrowed). */
  record?(stage: { kind: "info" | "ir"; label: string; data: unknown }): void;
  /** Test seam: the upstream socket for the vendor engine. */
  socketFactory?: RealtimeSocketFactory;
  /** Test seam: replaces the whole engine (a scripted LiveSession). */
  openSession?(callbacks: LiveSessionCallbacks): LiveSession;
}

/** The hooks the unified processor calls at its existing seams. */
export interface LinterSidecar {
  /** A talk window opened: barge-in cancel + window open (or merge). */
  onTalkStart(segment: number): void;
  /** One PCM16/24k frame from the mic (the same copy the STT session gets). */
  onAudioFrame(pcm: Uint8Array): void;
  /** The talk window closed: arm the transcript wait. */
  onTalkEnd(segment: number): void;
  /** A segment's final transcript landed (any transcriber). */
  onTranscriptFinal(segment: number, text: string): void;
  /** A deliberate shot's bytes arrived — inject labeled. */
  onShot(label: string, bytes: Uint8Array, mime: string): void;
  /** An app/code selection arrived or re-arrived under its marker. */
  onSelection(marker: string | undefined, entry: SelectionEntry, updated: boolean): void;
  /** A selection was retracted. */
  onSelectionDrop(marker: string | undefined): void;
  /** One ambient screen frame (the share's sampler). */
  onVideoFrame(bytes: Uint8Array, mime: string): void;
  /** Close the live session (fin / connection teardown). Idempotent. */
  close(): void;
}

export function createLinterSidecar(options: LinterSidecarOptions): LinterSidecar {
  const record = options.record ?? (() => {});
  let closed = false;
  let windowOpen = false;
  /** The segment whose transcript the armed wait is for. */
  let pendingEnd: { segment: number; timer: ReturnType<typeof setTimeout> } | undefined;
  /** The most recent segment (barge-in bookkeeping). */
  let lastSegment: number | undefined;
  /** The segment whose turn most recently ENDED — the one a lint is ABOUT.
   * Distinct from lastSegment: a reply can land after the user already
   * resumed (a new segment), and the note must anchor to the turn it
   * judged, not the one in progress. */
  let lintedSegment: number | undefined;
  let noteSeq = 0;
  const stats = { segments: 0, merged: 0, timeouts: 0, notes: 0, toolCalls: 0, frames: 0 };

  const onToolCall = (call: LinterToolCall): void => {
    stats.toolCalls += 1;
    const at = Date.now();
    const callEvent: ProducedEvent = {
      at,
      type: "linter-tool-call",
      tool: call.tool,
      args: call.args,
    };
    options.appendEvent(callEvent);
    record({ kind: "ir", label: `linter tool call ${call.tool}`, data: call.args });
    if (call.tool !== READ_FILE_TOOL_NAME) {
      const summary = `unknown tool "${call.tool}"`;
      const resultEvent: ProducedEvent = {
        at: Date.now(),
        type: "linter-tool-result",
        tool: call.tool,
        ok: false,
        summary,
      };
      options.appendEvent(resultEvent);
      options.push([callEvent, resultEvent]);
      record({ kind: "info", label: "linter tool result", data: { ok: false, summary } });
      call.respond(`error: ${summary}`);
      return;
    }
    const result = executeReadFile(call.args, options.promptCwd);
    const resultEvent: ProducedEvent = {
      at: Date.now(),
      type: "linter-tool-result",
      tool: call.tool,
      ok: result.ok,
      summary: result.summary,
    };
    options.appendEvent(resultEvent);
    options.push([callEvent, resultEvent]);
    // The FULL content the model read rides the trace — "anything readable"
    // is only honest because everything read is recorded.
    record({
      kind: "ir",
      label: "linter tool result",
      data: { ok: result.ok, summary: result.summary, content: result.content },
    });
    call.respond(result.content);
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
      record({ kind: "info", label: "linter note", data: { text, segment: lintedSegment } });
    },
    onReplyAudio: (bytes, mime) => {
      options.pushSpeech(`lint_${noteSeq++}`, mime, bytes);
    },
    onInterrupted: () => {
      record({ kind: "info", label: "linter interrupted", data: {} });
    },
    onUsage: (cost) => {
      options.recordCost("linter response", cost);
    },
    onError: (message, data) => {
      record({ kind: "info", label: "linter error", data: { message } });
      options.onError(`prompt linter: ${message} — dictation still works`, data);
    },
    onGoAway: (msLeft) => {
      record({ kind: "info", label: "linter go-away", data: { msLeft } });
    },
    onToolCall,
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
    label: "linter open",
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
    record({ kind: "info", label: "linter turn end", data: { segment: lintedSegment } });
  };

  return {
    onTalkStart(segment) {
      if (closed) {
        return;
      }
      lastSegment = segment;
      stats.segments += 1;
      // Client-side barge-in: a human talking over the lint wants to keep
      // briefing, not listen to the rest of it.
      session.cancelActiveResponse();
      if (pendingEnd !== undefined) {
        // The human resumed before the lint fired — MERGE into one window.
        clearTimeout(pendingEnd.timer);
        record({
          kind: "info",
          label: "linter turn merged",
          data: { pending: pendingEnd.segment, resumed: segment },
        });
        stats.merged += 1;
        pendingEnd = undefined;
        return; // the vendor window never closed — keep talking into it
      }
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
    onTalkEnd(segment) {
      if (closed || !windowOpen) {
        return;
      }
      if (pendingEnd !== undefined) {
        clearTimeout(pendingEnd.timer);
      }
      pendingEnd = {
        segment,
        timer: setTimeout(() => {
          pendingEnd = undefined;
          stats.timeouts += 1;
          record({ kind: "info", label: "linter transcript timeout", data: { segment } });
          endTurn(segment);
        }, TRANSCRIPT_WAIT_MS),
      };
    },
    onTranscriptFinal(segment, text) {
      if (closed) {
        return;
      }
      const awaited = pendingEnd !== undefined && pendingEnd.segment === segment;
      if (awaited && pendingEnd !== undefined) {
        clearTimeout(pendingEnd.timer);
        pendingEnd = undefined;
      }
      if (text.trim() !== "") {
        // SILENT context — the exact transcription the compiler will use,
        // injected just before the turn ends so the lint reconciles it
        // against what the model heard. A late final (after the timeout)
        // still injects: the next lint sees it.
        session.injectContextText(`[transcript seg_${segment}: "${text}"]`);
        record({
          kind: "ir",
          label: `linter transcript seg_${segment}`,
          data: { text, late: !awaited },
        });
      }
      if (awaited) {
        endTurn(segment);
      }
    },
    onShot(label, bytes, mime) {
      if (closed) {
        return;
      }
      session.injectLabeledImage(label, bytes, mime);
      record({ kind: "info", label: `linter label ${label}`, data: { mime } });
    },
    onSelection(marker, entry, updated) {
      if (closed) {
        return;
      }
      const text = selectionInjectionLabel(marker, entry, updated);
      session.injectContextText(text);
      record({ kind: "info", label: "linter selection", data: { text } });
    },
    onSelectionDrop(marker) {
      if (closed) {
        return;
      }
      const text = selectionRetractionLabel(marker);
      session.injectContextText(text);
      record({ kind: "info", label: "linter selection retracted", data: { text } });
    },
    onVideoFrame(bytes, mime) {
      if (closed) {
        return;
      }
      stats.frames += 1;
      session.appendVideoFrame(bytes, mime);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (pendingEnd !== undefined) {
        clearTimeout(pendingEnd.timer);
        pendingEnd = undefined;
      }
      session.close();
      record({ kind: "info", label: "linter close", data: stats });
    },
  };
}
