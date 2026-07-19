/**
 * The **oracle sidecar** — the second live consumer (capture-bus-and-consumers.md
 * §3, Phase 2): a DIRECT real-time voice conversation, where the linter is a
 * bystander. Same machinery (a {@link LiveSession} fed from the capture bus),
 * different turn strategy:
 *
 *  | | linter | oracle |
 *  |---|---|---|
 *  | strategy | overhear (turn ends at each pause) | **converse** (vendor auto-VAD) |
 *  | after a reply | keep overhearing | **loop** — keep conversing |
 *  | prompt | observes it being built | **pauses** its building (mic is addressed here) |
 *
 * Under `server_vad` the VENDOR owns the turn cycle: audio streams in, the
 * model decides when the human finished, replies, and resumes listening — no
 * `activityEnd`, no transcript wait, no merge machinery. What this sidecar
 * does is route: mic frames in; reply audio out as speech clips; the model's
 * own transcripts of BOTH directions out as `oracle-heard` / `oracle-said`
 * record events (§8 decision 6 — a record artifact, never prompt text);
 * `read_file` round-trips through the shared runner with the oracle's event
 * vocabulary. OpenAI-only in v1 (the reference vendor); Gemini follows.
 */
import {
  type OracleStageLabel,
  stageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import type { CallCost } from "./cost";
import { runConsumerToolCall } from "./linter-tools";
import {
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";
import type { LinterToolCall, LiveSession, LiveSessionCallbacks } from "./live-session";
import { DEFAULT_OPENAI_LIVE_MODEL, openOpenAiLiveSession } from "./openai-live";
import type { RealtimeSocketFactory } from "./realtime";

/**
 * The **oracle persona** — the authoritative system-instruction text for
 * oracle-mode sessions. Published VERBATIM in docs/guide/oracle.md (the
 * "every prompt is documented" principle) — edits here must be mirrored
 * there. Overridable per-hello via `oracleInstructions`. Kept terse —
 * instructions are billed as input tokens on every turn.
 */
export const ORACLE_INSTRUCTIONS =
  "You are the oracle: a real-time voice assistant a developer talks to DIRECTLY, mid-way " +
  "through composing a task briefing for a coding agent. While they address you, the briefing " +
  "is paused — you are a side conversation, and nothing you say enters the briefing. Answer " +
  "their questions plainly and briefly: a few spoken sentences, no lists, no preamble. You see " +
  "labeled screenshots ([image shot_3]) and on-screen selections ([selection sel_2: …]) they " +
  "share. You may call read_file to consult a file before answering — verify, don't browse. " +
  "If a question needs work you cannot do (editing files, running code), say so and suggest " +
  "they put it in the briefing instead.";

/** The vendor input-transcription model — the `oracle-heard` record's engine. */
export const ORACLE_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** An intent event the sidecar produces (kept loose to avoid a cycle). */
type ProducedEvent = Record<string, unknown> & { at: number; type: string };

export interface OracleSidecarOptions {
  /** The OpenAI key (v1 is OpenAI-only). */
  apiKey: string;
  /** Oracle model id; absent → the vendor default. */
  model?: string;
  /** Persona override; absent → ORACLE_INSTRUCTIONS. */
  instructions?: string;
  /** Output voice id (absent → the model default). */
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
  /** Trace stages, narrowed to the oracle's label vocabulary. */
  record?(stage: { kind: "info" | "ir"; label: OracleStageLabel; data: unknown }): void;
  /** Test seam: the upstream socket for the vendor engine. */
  socketFactory?: RealtimeSocketFactory;
  /** Test seam: replaces the whole engine (a scripted LiveSession). */
  openSession?(callbacks: LiveSessionCallbacks): LiveSession;
}

/** The hooks the unified processor calls at its existing seams. */
export interface OracleSidecar {
  /** One PCM16/24k frame from the mic — the oracle owns the mic while on.
   * (No talk hooks: under server VAD the VENDOR owns turn-taking AND
   * barge-in — it hears the human resume and interrupts itself; we only
   * LISTEN for that on the event stream via onInterrupted.) */
  onAudioFrame(pcm: Uint8Array): void;
  /** A deliberate shot's bytes arrived — inject labeled. */
  onShot(label: string, bytes: Uint8Array, mime: string): void;
  /** An app/code selection arrived or re-arrived under its marker. */
  onSelection(marker: string | undefined, entry: SelectionEntry, updated: boolean): void;
  /** A selection was retracted. */
  onSelectionDrop(marker: string | undefined): void;
  /** Close the live session (fin / control-off / teardown). Idempotent. */
  close(): void;
}

export function createOracleSidecar(options: OracleSidecarOptions): OracleSidecar {
  const record = options.record ?? (() => {});
  let closed = false;
  /** The current reply STREAM: chunks share `oracle_${clipSeq}` until the
   * reply completes (or is interrupted), then the ordinal bumps. */
  let clipSeq = 0;
  let chunkSeq = 0;
  let streamOpen = false;
  const stats = { heard: 0, said: 0, toolCalls: 0, interruptions: 0 };

  /** The reply stream ended (turn complete / vendor barge-in): rotate the id. */
  const closeReplyStream = (cancelled: boolean): void => {
    if (!streamOpen) {
      return;
    }
    if (cancelled) {
      options.pushSpeechCancel(`oracle_${clipSeq}`);
    }
    streamOpen = false;
    clipSeq += 1;
    chunkSeq = 0;
  };

  const onToolCall = (call: LinterToolCall): void => {
    stats.toolCalls += 1;
    // The shared execution policy with the ORACLE's event/label vocabulary.
    let callEvent: ProducedEvent | undefined;
    runConsumerToolCall(call, options.promptCwd, {
      onCall: (tool, args) => {
        callEvent = { at: Date.now(), type: "oracle-tool-call", tool, args };
        options.appendEvent(callEvent);
        record({ kind: "ir", label: stageLabel.oracleToolCall(tool), data: args });
      },
      onResult: (ok, summary, content) => {
        const resultEvent: ProducedEvent = {
          at: Date.now(),
          type: "oracle-tool-result",
          tool: call.tool,
          ok,
          summary,
        };
        options.appendEvent(resultEvent);
        options.push(callEvent !== undefined ? [callEvent, resultEvent] : [resultEvent]);
        record(
          ok || content !== ""
            ? { kind: "ir", label: stageLabel.oracleToolResult(), data: { ok, summary, content } }
            : { kind: "info", label: stageLabel.oracleToolResult(), data: { ok, summary } },
        );
      },
    });
  };

  const callbacks: LiveSessionCallbacks = {
    onReplyTranscript: (text) => {
      stats.said += 1;
      const event: ProducedEvent = { at: Date.now(), type: "oracle-said", text };
      options.appendEvent(event);
      options.push([event]);
      record({ kind: "info", label: stageLabel.oracleSaid(), data: { text } });
    },
    onInputTranscript: (text) => {
      // The §8-6 record: the model's OWN transcript of what it heard. Never
      // prompt text — the matching talk segments resolved empty upstream.
      stats.heard += 1;
      const event: ProducedEvent = { at: Date.now(), type: "oracle-heard", text };
      options.appendEvent(event);
      options.push([event]);
      record({ kind: "info", label: stageLabel.oracleHeard(), data: { text } });
    },
    onReplyAudio: (bytes, mime) => {
      // STREAMED the moment the vendor produced it — conversation rhythm
      // lives on time-to-first-audio (whole-clip buffering retired).
      streamOpen = true;
      options.pushSpeechChunk(`oracle_${clipSeq}`, chunkSeq++, mime, bytes);
    },
    onInterrupted: () => {
      stats.interruptions += 1;
      closeReplyStream(true);
      record({ kind: "info", label: stageLabel.oracleInterrupted(), data: {} });
    },
    onUsage: (cost) => {
      options.recordCost("oracle response", cost);
    },
    onError: (message, data) => {
      record({ kind: "info", label: stageLabel.oracleError(), data: { message } });
      options.onError(`oracle: ${message} — briefing capture still works`, data);
    },
    onToolCall,
    onTurnComplete: () => {
      // The after-reply policy is LOOP — nothing to run; the vendor's VAD
      // resumes listening on its own. Only the reply STREAM rotates, so the
      // next reply plays under a fresh id.
      closeReplyStream(false);
    },
  };

  const session: LiveSession = options.openSession
    ? options.openSession(callbacks)
    : openOpenAiLiveSession(
        {
          apiKey: options.apiKey,
          model: () => options.model ?? DEFAULT_OPENAI_LIVE_MODEL,
          serverVad: true,
          inputTranscriptionModel: ORACLE_INPUT_TRANSCRIPTION_MODEL,
          instructions: options.instructions ?? ORACLE_INSTRUCTIONS,
          ...(options.voice !== undefined ? { voice: () => options.voice } : {}),
          ...(options.socketFactory !== undefined ? { socketFactory: options.socketFactory } : {}),
        },
        callbacks,
      );

  record({
    kind: "info",
    label: stageLabel.oracleOpen(),
    data: { vendor: "openai", model: options.model ?? "(vendor default)" },
  });

  return {
    onAudioFrame(pcm) {
      if (closed) {
        return;
      }
      // No window gating: audio only arrives during talk anyway, and the
      // vendor's VAD owns segmentation under server_vad.
      session.appendAudio(pcm);
    },
    onShot(label, bytes, mime) {
      if (closed) {
        return;
      }
      session.injectLabeledImage(label, bytes, mime);
      record({ kind: "info", label: stageLabel.oracleLabel(label), data: { mime } });
    },
    onSelection(marker, entry, updated) {
      if (closed) {
        return;
      }
      const text = selectionInjectionLabel(marker, entry, updated);
      session.injectContextText(text);
      record({ kind: "info", label: stageLabel.oracleSelection(), data: { text } });
    },
    onSelectionDrop(marker) {
      if (closed) {
        return;
      }
      const text = selectionRetractionLabel(marker);
      session.injectContextText(text);
      record({ kind: "info", label: stageLabel.oracleSelectionRetracted(), data: { text } });
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      session.close();
      record({ kind: "info", label: stageLabel.oracleClose(), data: stats });
    },
  };
}
