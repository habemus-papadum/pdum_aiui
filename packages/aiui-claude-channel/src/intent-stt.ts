/**
 * The `intent-v1` streaming-transcription wing: the one shared realtime session
 * (opened at thread-open so the handshake overlaps the arm→talk gap), the
 * talk-end segment commit with its engine-specific discard floor, and the
 * per-frame PCM buffering. All parameterized on the {@link IntentTurn} so the
 * mid-turn linter swap keeps working (the sidecar is read through `turn`).
 *
 * Degradation is loud and specific — a keyless or erroring session finalizes the
 * segment through {@link IntentTurn.finalizeSilentSegment}, never a silent drop
 * and never a silent switch to mock.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import {
  type AudioOutOfOrderData,
  type RealtimeCommitData,
  type RealtimeDiscardData,
  type SttPartialData,
  stageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import { pushError, type ThreadContext } from "./channel";
import { ELEVENLABS_COMMIT_FLOOR_MS, openElevenLabsRealtimeSession } from "./elevenlabs-realtime";
import type { ChunkDescriptor } from "./frame";
import { ELEVENLABS_KEY_HINT, OPENAI_KEY_HINT, type ResolvedIntent } from "./intent-resolve";
import { MIN_REALTIME_COMMIT_MS, ordinalOf, REALTIME_PCM_BYTES_PER_MS } from "./intent-stream-util";
import type { IntentTurn } from "./intent-turn";
import type { IntentV1Options } from "./intent-v1";
import { openRealtimeSession, type RealtimeCallbacks, type RealtimeSession } from "./realtime";
import type { TraceHandle } from "./trace";

/** The channel-process API keys the streaming engines dial with. */
export interface SttKeys {
  /** OpenAI key (the `openai-realtime` engine + the openai linter). */
  apiKey: string | undefined;
  /** ElevenLabs key (the `elevenlabs` Scribe engine). */
  elevenLabsKey: string | undefined;
}

/**
 * Open the per-thread streaming-transcription session and return it (the caller
 * assigns it to `turn.realtime`). Both engines implement the same
 * {@link RealtimeSession} seam and share this ONE callbacks wiring — the vendor
 * difference is confined to the open. Deltas echo the preview as you speak; the
 * completed transcript is merged into the stream exactly like a `transcript-final`.
 */
export function openSttSession(
  turn: IntentTurn,
  ctx: ThreadContext,
  trace: TraceHandle | undefined,
  intent: ResolvedIntent,
  keys: SttKeys,
  options: IntentV1Options,
): RealtimeSession {
  const sttCallbacks: RealtimeCallbacks = {
    onDelta: (segment, text) => {
      turn.push([{ at: Date.now(), type: "transcript-delta", segment, text }]);
      // The vendor's running text for the still-uncommitted segment, recorded
      // verbatim. Every engine behind this seam re-sends the CUMULATIVE text
      // (RealtimeCallbacks.onDelta's contract), so a partial that gets SHORTER
      // is the vendor revising itself — not a dropped frame and not something
      // this side patched. Without these stages that distinction is
      // unfalsifiable after the fact, since deltas are pushed and discarded.
      // Recorded only; the fold still composes from `transcript-final` alone.
      trace?.record({
        kind: "ir",
        label: stageLabel.sttPartial(segment),
        data: { chars: text.length, text } satisfies SttPartialData,
      });
    },
    onFinal: (segment, result) => {
      turn.recordCost(`realtime transcription seg_${segment}`, result.cost);
      const produced: IntentEvent = {
        at: Date.now(),
        type: "transcript-final",
        segment,
        text: result.text,
        latencyMs: result.latencyMs,
        model: result.model,
        // Word timestamps + logprobs (Scribe v2 today): the compiler's
        // exact media anchor and the preview's confidence heat map.
        ...(result.words !== undefined && result.words.length > 0 ? { words: result.words } : {}),
      };
      turn.appendEvent(produced);
      turn.push([produced]);
      turn.sidecar?.onTranscriptFinal(segment, result.text);
      // A glanceable per-final stage: "did words/logprobs/timestamps come
      // back?" must be answerable from the card list, not by digging the
      // merged-events JSON (the debugging lesson of the heat-map chase).
      const logprobs = (result.words ?? [])
        .map((w) => w.logprob)
        .filter((v): v is number => v !== undefined);
      trace?.record({
        kind: "info",
        label: stageLabel.sttFinal(segment),
        data: {
          model: result.model,
          chars: result.text.length,
          words: result.words?.length,
          withTimestamps: result.words?.some((w) => w.startMs !== undefined) === true,
          ...(logprobs.length > 0
            ? {
                logprobs: {
                  n: logprobs.length,
                  min: Math.min(...logprobs),
                  max: Math.max(...logprobs),
                },
              }
            : { logprobs: "none" }),
        },
      });
      turn.recomposeIfStale();
    },
    onError: (message, segment) => {
      const hint = intent.transcriber === "elevenlabs" ? ELEVENLABS_KEY_HINT : OPENAI_KEY_HINT;
      if (segment !== undefined) {
        turn.finalizeSilentSegment(`seg_${segment}`, `realtime transcription failed: ${message}`, {
          source: "transcription",
          detail: hint,
        });
      } else {
        // Session-wide fault before any commit (a refused upstream
        // handshake is where a bad key shows up on this path).
        turn.push([{ at: Date.now(), type: "note", text: `realtime transcription: ${message}` }]);
        pushError(ctx, {
          source: "transcription",
          message: `realtime transcription: ${message}`,
          detail: hint,
        });
      }
    },
    // Vendor-protocol observability. None of these change the turn; they exist
    // so a wire behaviour we didn't model (Scribe self-committing utterances,
    // a query param silently ignored, a message type we've never seen) leaves
    // a mark in the trace instead of vanishing into a `default: return`.
    onDiagnostic: (event) => {
      // `sttDiagnostic` types its param as the shared SttDiagnosticKind — if
      // realtime.ts's RealtimeDiagnostic gains a kind not in the vocabulary,
      // this call stops compiling (the label contract can't be bypassed).
      trace?.record({
        kind: "info",
        label: stageLabel.sttDiagnostic(event),
        data: event,
      });
      // A param we set that the vendor did not confirm means the behaviour we
      // think we configured is not in force — loud, not just traced.
      if (event.kind === "config-mismatch") {
        console.warn(
          `[aiui] ${intent.transcriber}: config param "${event.param}" not confirmed by the server ` +
            `(requested ${JSON.stringify(event.requested)}, echoed ${JSON.stringify(event.echoed)})`,
        );
      }
    },
  };
  return intent.transcriber === "elevenlabs"
    ? openElevenLabsRealtimeSession(
        {
          apiKey: keys.elevenLabsKey ?? "",
          ...(intent.keywords !== undefined ? { keyterms: () => intent.keywords } : {}),
          ...(options.elevenLabsSocketFactory !== undefined
            ? { socketFactory: options.elevenLabsSocketFactory }
            : {}),
        },
        sttCallbacks,
      )
    : openRealtimeSession(
        {
          apiKey: keys.apiKey ?? "",
          model: () => intent.realtimeModel,
          delay: () => intent.realtimeDelay,
          ...(options.realtimeSocketFactory !== undefined
            ? { socketFactory: options.realtimeSocketFactory }
            : {}),
        },
        sttCallbacks,
      );
}

/** Commit a streaming segment at talk-end: save its accumulated PCM, then commit. */
export function commitRealtimeSegment(
  turn: IntentTurn,
  trace: TraceHandle | undefined,
  intent: ResolvedIntent,
  segment: number,
): void {
  const buffered = turn.audioFrames.get(segment);
  if (buffered !== undefined) {
    turn.audioFrames.delete(segment);
    if (buffered.chunks.length > 0) {
      const merged = new Uint8Array(buffered.bytes);
      let offset = 0;
      for (const chunk of buffered.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      trace?.recordBlob(
        { kind: "ir", label: stageLabel.attachment(`seg_${segment}`) },
        merged,
        `seg_${segment}.pcm`,
      );
    }
    trace?.record({
      kind: "ir",
      label: stageLabel.realtimeCommit(segment),
      data: {
        frames: buffered.chunks.length,
        bytes: buffered.bytes,
      } satisfies RealtimeCommitData,
    });
  }
  // The Space-tap debounce: the upstream rejects a commit under 100 ms of
  // audio ("buffer too small"), and a tapped-and-released key often streams
  // zero frames. Discard instead of committing — clear the upstream buffer,
  // resolve the segment as empty (the preview stops waiting), and record it
  // in the trace. Quiet by design: an accidental tap is not an error.
  const session = turn.realtime;
  const pcmBytes = buffered?.bytes ?? 0;
  // The discard floor is ENGINE-specific: OpenAI rejects commits under
  // ~100 ms ("buffer too small"); ElevenLabs FATALLY closes the session
  // under 300 ms, so its session refuses commits below its own 500 ms
  // safety floor. Discarding here at the same floor keeps a 100–500 ms
  // tap on the consistent path (one traced discard) instead of a
  // commit the session would refuse into a silent empty final.
  const commitFloorMs =
    intent.transcriber === "elevenlabs" ? ELEVENLABS_COMMIT_FLOOR_MS : MIN_REALTIME_COMMIT_MS;
  if (session !== undefined && pcmBytes < commitFloorMs * REALTIME_PCM_BYTES_PER_MS) {
    session.discard(segment);
    const empty: IntentEvent = {
      at: Date.now(),
      type: "transcript-final",
      segment,
      text: "",
      latencyMs: 0,
      model: intent.model,
    };
    turn.appendEvent(empty);
    turn.push([empty]);
    trace?.record({
      kind: "info",
      label: stageLabel.realtimeDiscard(segment),
      data: {
        bytes: pcmBytes,
        ms: Math.round(pcmBytes / REALTIME_PCM_BYTES_PER_MS),
        note: `under the ${commitFloorMs} ms upstream commit minimum — not transcribed`,
      } satisfies RealtimeDiscardData,
    });
    return;
  }
  if (turn.realtime !== undefined) {
    turn.realtime.commit(segment);
  } else if (intent.transcriber === "openai-realtime" || intent.transcriber === "elevenlabs") {
    // Keyless realtime: no session to commit into. Same loud note as REST
    // keyless — the preview resolves and the widget can say why.
    turn.finalizeSilentSegment(
      `seg_${segment}`,
      "server-side realtime transcription is unavailable — " +
        "the channel process has no OPENAI_API_KEY. " +
        'Set it and relaunch `aiui claude`, or use transcriber:"mock" for offline work.',
    );
  }
}

/**
 * Resolve a talk segment that was ADDRESSED TO THE ORACLE (capture-bus
 * Phase 2): prompt building is paused, so the segment commits to no
 * transcriber — it resolves EMPTY (the preview stops waiting; the compiler
 * composes nothing from it) and the buffered PCM is still saved to the trace
 * (the record of the audio; the oracle's own `oracle-heard` transcript is the
 * record of the words). Never an error: talking to the oracle is deliberate.
 */
export function resolveOracleAddressedSegment(
  turn: IntentTurn,
  trace: TraceHandle | undefined,
  segment: number,
): void {
  const buffered = turn.audioFrames.get(segment);
  if (buffered !== undefined) {
    turn.audioFrames.delete(segment);
    if (buffered.chunks.length > 0) {
      const merged = new Uint8Array(buffered.bytes);
      let offset = 0;
      for (const chunk of buffered.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      trace?.recordBlob(
        { kind: "ir", label: stageLabel.attachment(`seg_${segment}`) },
        merged,
        `seg_${segment}.pcm`,
      );
    }
  }
  const empty: IntentEvent = {
    at: Date.now(),
    type: "transcript-final",
    segment,
    text: "",
    latencyMs: 0,
    model: "oracle",
  };
  turn.appendEvent(empty);
  turn.push([empty]);
  trace?.record({
    kind: "info",
    label: stageLabel.oracleAddressed(segment),
    data: {
      bytes: buffered?.bytes ?? 0,
      note: "mic addressed to the oracle — prompt building paused for this segment",
    },
  });
}

/** Buffer one PCM frame into its segment (the realtime analogue of the REST seg blob). */
export function onAudioChunk(
  turn: IntentTurn,
  trace: TraceHandle | undefined,
  chunk: Extract<ChunkDescriptor, { kind: "audio" }>,
  bytes: Uint8Array,
): void {
  const segment = ordinalOf(chunk.id);
  let buffered = turn.audioFrames.get(segment);
  if (buffered === undefined) {
    buffered = { chunks: [], bytes: 0, lastSeq: -1 };
    turn.audioFrames.set(segment, buffered);
  }
  // seq is a monotonic ordinal per segment; frames arrive in per-connection
  // order, so this holds in practice. A gap/reorder is tolerated (forwarded in
  // arrival order — the upstream buffer is append-only) but noted in the trace.
  if (chunk.seq <= buffered.lastSeq) {
    trace?.record({
      kind: "info",
      label: stageLabel.audioOutOfOrder(chunk.id),
      data: {
        seq: chunk.seq,
        lastSeq: buffered.lastSeq,
        note: "tolerated (arrival order kept)",
      } satisfies AudioOutOfOrderData,
    });
  }
  buffered.lastSeq = Math.max(buffered.lastSeq, chunk.seq);
  // The payload is a view into the received frame; copy before retaining it.
  // Explicitly: on a Buffer, `.slice()` is another view, not a copy (the
  // trap that corrupted REST transcription uploads — see transcribe.ts), so
  // retaining it would pin every frame's whole allocation in memory.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  buffered.chunks.push(copy);
  buffered.bytes += copy.length;
  // The route switch (capture-bus §1): while the ORACLE holds the mic, audio
  // goes to it ALONE — not to the STT session (prompt building is paused; the
  // segment resolves empty at talk-end) and not to the linter (the journeys'
  // XOR means none is running). Otherwise the BRIEF journey's fan-out:
  // transcriber always, linter when subscribed.
  if (turn.oracle !== undefined) {
    turn.oracle.onAudioFrame(copy);
    return;
  }
  turn.realtime?.appendAudio(segment, copy);
  turn.sidecar?.onAudioFrame(copy);
}
