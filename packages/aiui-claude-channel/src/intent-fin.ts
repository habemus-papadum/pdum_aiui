/**
 * The `intent-v1` fin commit: the one place the observable side effect happens.
 * {@link finishTurn} drains any still-in-flight realtime finals, folds the merged
 * stream (reusing the speculative cache when the log is unchanged), wraps the
 * body in its context preamble, and — for a turn that wasn't cancelled and has
 * something to say — pushes the composed prompt to the client BEFORE handing it
 * to `sendPrompt`, so the widget's view never lags the session notification.
 *
 * The ordering here is pinned by the processor tests (push-before-send, span
 * shifting): drain → merged-events stage → cancel gate → compose reuse →
 * preamble/spans → lowered-prompt push → sendPrompt → speakAck → detached
 * summarize → close. Move nothing across those boundaries.
 */
import {
  type ComposedIntent,
  type ComposeOptions,
  composeIntent,
  type PromptSpan,
} from "@habemus-papadum/aiui-lowering-pipeline";
import { stageLabel } from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import { pushError, type ThreadContext } from "./channel";
import type { LoweredPromptMessage } from "./intent-messages";
import { ACK_PHRASES, OPENAI_KEY_HINT, type ResolvedIntent } from "./intent-resolve";
import { endedInCancel, REALTIME_DRAIN_TIMEOUT_MS } from "./intent-stream-util";
import type { IntentTurn } from "./intent-turn";
import { TRANSCRIPTION_NOTE, wrapWithContextParts } from "./prompt-context";
import type { Speaker } from "./speak";
import type { Summarizer } from "./summarize";
import type { TraceHandle } from "./trace";

/**
 * The fin commit: pick the composed intent (cached or fresh) and notify. Runs the
 * pinned side-effect sequence and then closes the thread's sessions.
 */
export async function finishTurn(
  turn: IntentTurn,
  ctx: ThreadContext,
  trace: TraceHandle | undefined,
  intent: ResolvedIntent,
  staticSections: string[],
  speaker: Speaker | undefined,
  summarizer: Summarizer | undefined,
  composeOptions: ComposeOptions,
): Promise<void> {
  /** Speak the premium tier's send-received ack, or say loudly why it can't. */
  const speakAck = async (): Promise<void> => {
    if (intent.audioBack !== "acks") {
      return;
    }
    const phrase = ACK_PHRASES.sent;
    if (speaker === undefined) {
      // Keyless/degraded premium: the spoken ack is a promised feature of the
      // tier, so its absence is loud (never a silent downgrade to `rapid`).
      const text =
        "spoken confirmation unavailable — the channel process has no OPENAI_API_KEY (premium tier)";
      turn.push([{ at: Date.now(), type: "note", text }]);
      pushError(ctx, { source: "speech", message: text });
      return;
    }
    try {
      const clip = await speaker.speak({
        text: phrase,
        ...(intent.ttsVoice !== undefined ? { voice: intent.ttsVoice } : {}),
      });
      turn.recordCost("tts ack", clip.cost);
      turn.pushSpeech(`ack_${turn.ackSeq++}`, clip.mime, clip.bytes, phrase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      turn.push([{ at: Date.now(), type: "note", text: `spoken confirmation failed: ${message}` }]);
      pushError(ctx, {
        source: "speech",
        message: `spoken confirmation failed: ${message}`,
        detail: OPENAI_KEY_HINT,
      });
    }
  };

  /**
   * Gloss the just-sent turn onto its trace, off the hot path. Fired
   * fire-and-forget from {@link finishTurn} *after* the send — the fin ack must
   * never wait on a summary — so by the time this resolves the trace has usually
   * ended already; {@link TraceHandle.setSummary} is designed to write post-end.
   * Input is the composed body (no preamble; screenshots stripped inside the
   * seam). Keyless (no seam) or any failure → skip silently: a missing row gloss
   * falls back to the timestamp, never a broken turn. (A failure can't be traced
   * here — `record` no-ops once the trace has ended — so the drop is silent.)
   */
  const summarize = async (body: string): Promise<void> => {
    if (summarizer === undefined || body === "") {
      return;
    }
    try {
      const result = await summarizer.summarize(body);
      trace?.setSummary(result.text);
      // The trace has ended by now, so no `cost:` stage lands (record no-ops
      // post-end) — but the roll-up still moves; addCost writes post-end.
      if (result.cost?.usd !== undefined) {
        trace?.addCost(result.cost.usd);
      }
    } catch {
      // best-effort: the trace list just shows the timestamp for this turn
    }
  };

  // Realtime finals arrive off-band (over the upstream socket), not on the
  // frame that carried the audio — so a fast Enter can outrun a `…completed`.
  // Drain the committed-but-not-final segments before composing; any that miss
  // the window are finalized loudly so the compose (and the preview) resolve.
  // The STT and voice sessions are mutually exclusive; drain whichever is live.
  const streamSession = turn.realtime;
  if (streamSession !== undefined) {
    const timedOut = await streamSession.drain(REALTIME_DRAIN_TIMEOUT_MS);
    for (const segment of timedOut) {
      turn.finalizeSilentSegment(
        `seg_${segment}`,
        "realtime transcription did not complete before send — the segment was left blank",
      );
    }
    turn.recomposeIfStale();
  }

  // Blobs were saved and shot paths wired on arrival; the only wiring left is
  // the defensive case of a shot event that trailed its bytes (usually a no-op).
  turn.applyShotPaths();

  trace?.record({ kind: "ir", label: stageLabel.mergedEvents(), data: turn.events });

  const cancelled = endedInCancel(turn.events);
  // Reuse the speculative compose when the log is unchanged since it last ran;
  // otherwise recompute (e.g. a shot path was wired after the final batch).
  let composed: ComposedIntent;
  let reused: boolean;
  if (turn.lastComposed !== undefined && turn.composedSeq === turn.mutationSeq) {
    composed = turn.lastComposed;
    reused = true;
  } else {
    composed = composeIntent(turn.events, "replace", composeOptions);
    reused = false;
  }
  trace?.record({ kind: "info", label: stageLabel.finCompose(), data: { reused } });
  trace?.record({
    kind: "ir",
    label: stageLabel.composedIntent(),
    data: {
      transcript: composed.transcript,
      items: composed.items,
      corrections: composed.corrections,
      prompt: composed.prompt,
    },
  });
  trace?.record({
    kind: "ir",
    label: stageLabel.conditioned(),
    data: { cancelled, body: composed.prompt },
  });

  // A cancelled turn (or one with nothing to say) lowers to no notification.
  if (!cancelled && composed.prompt !== "") {
    // The preamble: the hello-fixed sections (pre-warmed at thread-open)
    // plus the TURN-dependent ones, decided here at fin — today that is the
    // transcription warning, added only when the stream actually contains
    // speech-transcribed text (typed contributions carry model
    // "contribution" and never trigger it). This is the seam every future
    // event-dependent preamble section rides through.
    const hasSpeech = turn.events.some(
      (e) => e.type === "transcript-final" && e.model !== "contribution",
    );
    const { text: prompt, preambleLen } = wrapWithContextParts(
      [...staticSections, ...(hasSpeech ? [TRANSCRIPTION_NOTE] : [])],
      composed.prompt,
    );
    // The sent prompt's spans: composeIntent's body spans shifted past the
    // context preamble, with the preamble itself as a leading span so the
    // hero can grey it. Recorded as its own stage because the `lowered prompt`
    // output stage is written by the generic sendPrompt tracer (which carries
    // only the text) — the hero pairs the two by threadId/proximity.
    const spans: PromptSpan[] =
      preambleLen > 0
        ? [
            { kind: "preamble", start: 0, end: preambleLen },
            ...composed.spans.map((s) => ({
              ...s,
              start: s.start + preambleLen,
              end: s.end + preambleLen,
            })),
          ]
        : composed.spans;
    trace?.record({ kind: "ir", label: stageLabel.loweredPromptSpans(), data: { spans } });
    // Show the client what is about to be committed (pushed first, so the
    // widget's view of the prompt never lags the session notification).
    ctx.push?.({
      kind: "lowered-prompt",
      threadId: ctx.threadId,
      prompt,
      // Omit when empty (a bare-client text-only prompt) — additive.
      ...(spans.length > 0 ? { spans } : {}),
    } satisfies LoweredPromptMessage);
    await ctx.sendPrompt(prompt);
    // Premium tier: a spoken "sent" once the notification landed (the send-
    // received ack — the minimal recommended trigger set, archive/streaming-turns.md §4).
    await speakAck();
    // Gloss the turn for the trace list — detached, so the fin ack does not
    // wait on a chat round-trip. `composed.prompt` is the body only (the
    // preamble is context, not intent). Best-effort; never awaited.
    void summarize(composed.prompt);
  }
  // The turn committed — the upstream socket(s) have no more segments to handle,
  // so close (idempotent; onClose closes them for abandoned turns).
  turn.realtime?.close();
  turn.sidecar?.close();
  ctx.close();
}
