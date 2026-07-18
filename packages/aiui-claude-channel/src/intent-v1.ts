/**
 * The `intent-v1` stream format: the multimodal intent tool's wire format and
 * its lowering processor.
 *
 * Where `text-concat` accumulates a string, `intent-v1` accumulates the intent
 * tool's **event log** plus binary attachments, and on `fin` lowers the whole
 * turn into one prompt with each screenshot inlined at its position
 * (`[screenshot located at <path>]` + a `<screenshot-metadata>` block when
 * elements were located — paths relativized to this process's cwd, the
 * agent's working directory; see composeIntent).
 * The pipeline core — `composeIntent`, the V4A applier, the config shape — is
 * imported from `@habemus-papadum/aiui-lowering-pipeline`, the same module the
 * browser modality runs, so one implementation and one set of captured fixtures
 * cover both sides.
 *
 * Frames are tagged in the envelope ({@link ChunkDescriptor}); the codec is the
 * identity codec ({@link rawCodec}) because a payload's meaning depends on its
 * chunk kind, which the codec — seeing only bytes — cannot know. The processor
 * interprets each payload from `meta.chunk`:
 *
 *  - `events`   → JSON `{ events }`: appended to the turn's stream in order.
 *  - `attachment shot_N` → a PNG: conditioned (downscale slot) and saved to the
 *    trace blob store **on arrival**, its path wired into the shot event then.
 *  - `attachment seg_N`  → audio: conditioned (silence-trim slot), saved on
 *    arrival, and — when the hello asked for server-side transcription —
 *    transcribed here; the produced `transcript-final` event is both merged
 *    into the stream and pushed back to the client as a `lowered` message.
 *  - `context`  → LEGACY (pre-greenfield clients, since deleted): a submit-time
 *    `{ selection }`.
 *    Accepted and ignored — current clients ride selections on the stream as
 *    positional `app-selection` events (marker `sel_N`, retractable via
 *    `app-selection-drop`), which `composeIntent` renders INLINE in the body
 *    at their stream position; the preamble path was retired (render audit,
 *    2026-07).
 *
 * A thread that ends in `cancel` (or never fins) lowers to nothing. (The
 * corrector round-trip — patchless `correction` requests answered with V4A
 * diffs — was retired with correct mode in the append-only pivot; legacy
 * correction events in old traces still fold at compose time.)
 *
 * **Incremental lowering (archive/streaming-turns.md §2).** The cheap, pure, and
 * pre-warmable work happens as events arrive, not at `fin`, so `fin` is a
 * near-empty commit of the one observable side effect (the session
 * notification). Concretely: attachment blobs are saved and shot paths wired on
 * arrival (zero fin-time disk I/O); the condition passes run on each attachment;
 * the prompt's tab/source preamble is pre-warmed at thread-open; and a
 * *speculative* `composeIntent` runs after each mutating batch, cached and
 * reused at `fin` when the event log has not changed since (fingerprinted by a
 * mutation counter). The invariant that keeps this safe: speculation only ever
 * populates caches and the trace — never `sendPrompt`, never a push, never a
 * paid re-run — and `fin` alone (and only when not cancelled) commits. An
 * abandoned turn (socket dropped, no `fin`) drops this state via {@link
 * StreamProcessor.onClose} and lowers to nothing.
 *
 * The processor here is thin orchestration — hello-config resolution
 * (`resolveIntent`, in `intent-resolve`), the shared mutable turn state and its
 * helper surface (`createIntentTurn`, in `intent-turn`), the linter sidecar, and
 * chunk dispatch. The wings live in siblings: `intent-stt` (the streaming
 * transcription session, segment commit, and PCM buffering), `intent-fin`
 * (`finishTurn`, the fin commit), `intent-stream-util` (pure helpers + protocol
 * floors), and `intent-messages` (the server→client push shapes).
 */
import {
  type IntentEvent,
  LINTER_VENDORS,
  type LinterVendor,
} from "@habemus-papadum/aiui-lowering-pipeline";
import {
  type ConditionData,
  type IntentConfigData,
  stageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import {
  type ChannelFormat,
  type MessageMeta,
  pushError,
  type StreamProcessor,
  type ThreadContext,
} from "./channel";
import { rawCodec } from "./codec";
import type { ChunkDescriptor } from "./frame";
import { finishTurn } from "./intent-fin";
import type { LoweredMessage } from "./intent-messages";
import { GEMINI_KEY_HINT, OPENAI_KEY_HINT, resolveIntent } from "./intent-resolve";
import {
  decodeJson,
  imageDownscale,
  imageExtension,
  readEventBatch,
  silenceTrim,
} from "./intent-stream-util";
import { commitRealtimeSegment, onAudioChunk, openSttSession } from "./intent-stt";
import { createIntentTurn } from "./intent-turn";
import { createLinterSidecar } from "./linter-sidecar";
import type { SelectionEntry } from "./live-resolve";
import type { LiveSession, LiveSessionCallbacks } from "./live-session";
import { promptContextSections } from "./prompt-context";
import type { RealtimeSocketFactory } from "./realtime";

import { openaiSpeaker, type Speaker } from "./speak";
import { openaiSummarizer, type Summarizer } from "./summarize";
import { traceOf } from "./tracing";
import { audioExtensionForMime, type FetchLike } from "./transcribe";

// The three server→client push wire shapes now live in intent-messages.ts;
// re-exported here so `from "./intent-v1"` importers (internal.ts's no-semver
// seam, the test suite) are unchanged.
export type { LoweredMessage, LoweredPromptMessage, SpeechMessage } from "./intent-messages";

/** Dependency injection + env for the format (real seams in prod, mocks in tests). */
export interface IntentV1Options {
  /** OpenAI key; defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /**
   * Gemini key, used only by the realtime submode's Gemini Live engine;
   * defaults to `process.env.GEMINI_API_KEY`. Deliberately its own slot —
   * the OpenAI key must never be sent to Gemini (it fails every call with a
   * close-frame auth error), which is exactly what happened when the two
   * shared one field.
   */
  geminiApiKey?: string;
  /** Injected fetch for the real seams (defaults to the global). */
  fetch?: FetchLike;
  /**
   * Test seam override for the realtime upstream socket — used whenever the hello
   * selects `transcriber: openai-realtime`, in place of the real `ws` connection.
   * Present (even keyless) → the realtime path is exercised offline.
   */
  realtimeSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override — used whenever the hello asks for `audioBack: "acks"`
   * (the premium tier's TTS acks), in place of the real REST speaker.
   */
  speaker?: Speaker;
  /** ElevenLabs key (Scribe v2); defaults to `process.env.ELEVEN_LABS_API_KEY`. */
  elevenLabsApiKey?: string;
  /**
   * Test seam override for the Scribe v2 upstream socket — used whenever the
   * hello selects `transcriber: elevenlabs`. Present (even keyless) → the
   * path runs offline.
   */
  elevenLabsSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override for the linter's **Gemini** upstream socket
   * (`linter: "gemini"`), in place of the real `ws` connection. Present (even
   * keyless) → the linter runs offline (the house pattern; see gemini-live.ts).
   */
  geminiLiveSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override for the linter's **OpenAI** upstream socket
   * (`linter: "openai"`). Present (even keyless) → the linter runs offline.
   */
  openaiLiveSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override replacing the linter's whole engine with a scripted
   * {@link LiveSession} — the sidecar's state machine is then exercised with
   * no vendor dialect at all.
   */
  linterSessionFactory?: (callbacks: LiveSessionCallbacks) => LiveSession;
  /**
   * Test seam override for the post-send turn summarizer (see summarize.ts). Its
   * mere presence enables summaries even with no key; absent + keyless → no
   * summary (the gloss is a convenience, never load-bearing). Real seam is the
   * env-keyed {@link openaiSummarizer}.
   */
  summarizer?: Summarizer;
}

/**
 * Revalidate an untrusted control value against the linter vocabulary — the
 * runtime check is DERIVED from {@link LINTER_VENDORS} (adding a vendor is a
 * one-site change in the shared leaf), and this narrows the wire value to
 * {@link LinterVendor} for the callers.
 */
function isLinterVendor(value: unknown): value is LinterVendor {
  return (LINTER_VENDORS as readonly string[]).includes(value as string);
}

/**
 * Build the `intent-v1` format. The zero-arg {@link intentV1Format} registers
 * the real (env-keyed, network) seams; tests build their own with mock seams.
 */
export function createIntentV1Format(options: IntentV1Options = {}): ChannelFormat {
  return {
    codec: rawCodec,
    createProcessor: (ctx: ThreadContext) => intentProcessor(ctx, options),
  };
}

function intentProcessor(ctx: ThreadContext, options: IntentV1Options): StreamProcessor {
  const intent = resolveIntent(ctx.hello?.intent);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const geminiApiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY;
  const trace = traceOf(ctx);
  // The base every prompt path (screenshots AND source locations) relativizes
  // against — the agent's working directory. Defaults to this process's cwd
  // (right for `aiui claude`, whose channel runs in the project); a supervisor
  // whose cwd is elsewhere overrides via AIUI_PROMPT_CWD (a supervisor that
  // spawns its channel in a subdirectory but wants repo-root-relative paths).
  const promptCwd = process.env.AIUI_PROMPT_CWD || process.cwd();
  const composeOptions = { cwd: promptCwd };

  // The realtime (streaming) transcriber is a *session*, not a per-blob seam:
  // one upstream WS per thread, opened at thread-open (below) so its handshake
  // overlaps the arm→talk gap. Keyless with no test factory → the session is
  // absent and the segment degrades loudly (the REST-keyless posture), never a
  // silent switch to mock. A test factory forces the path on with no key.
  const elevenLabsKey = options.elevenLabsApiKey ?? process.env.ELEVEN_LABS_API_KEY;
  // Scribe is the shipped DEFAULT — so its keyless posture is a graceful,
  // VISIBLE fallback to Realtime Whisper (a note, not an error storm), not
  // the loud per-segment degradation an explicit choice gets. An explicit
  // choice is indistinguishable from the default on the wire; the fallback
  // fires only when whisper is actually available, so "neither key" still
  // degrades loudly below.
  if (
    intent.transcriber === "elevenlabs" &&
    (elevenLabsKey === undefined || elevenLabsKey === "") &&
    options.elevenLabsSocketFactory === undefined &&
    ((apiKey !== undefined && apiKey !== "") || options.realtimeSocketFactory !== undefined)
  ) {
    intent.transcriber = "openai-realtime";
    intent.coerced.push(
      "transcriber elevenlabs → openai-realtime (no ELEVEN_LABS_API_KEY; Scribe is the default, whisper is the fallback)",
    );
    ctx.push?.({
      kind: "lowered",
      threadId: ctx.threadId,
      events: [
        {
          at: Date.now(),
          type: "note",
          text: "🎬 Scribe unavailable (no ELEVEN_LABS_API_KEY) — transcribing with ⚡ Realtime Whisper",
        },
      ],
    } satisfies LoweredMessage);
  }
  const realtimeEnabled =
    intent.transcriber === "openai-realtime" || intent.transcriber === "elevenlabs";
  const realtimeReady =
    intent.transcriber === "openai-realtime"
      ? (apiKey !== undefined && apiKey !== "") || options.realtimeSocketFactory !== undefined
      : intent.transcriber === "elevenlabs"
        ? (elevenLabsKey !== undefined && elevenLabsKey !== "") ||
          options.elevenLabsSocketFactory !== undefined
        : false;

  // The premium TTS-ack speaker (audioBack:"acks"): a REST seam, keyed like the
  // transcriber/corrector. Keyless → absent, and the ack degrades loudly at
  // send (a promised feature of the tier must not vanish silently).
  const speaker: Speaker | undefined =
    intent.audioBack === "acks"
      ? (options.speaker ??
        (apiKey
          ? openaiSpeaker({ model: () => intent.ttsModel, apiKey, fetch: options.fetch })
          : undefined))
      : undefined;

  // The post-send summarizer (summarize.ts): unlike the seams above it is not
  // gated on a tier — every turn is worth a one-line gloss for the trace list.
  // Enabled whenever there's a key (or a test seam); keyless → absent and the
  // trace simply carries no summary. Never on the hot path (see `summarize`).
  const summarizer: Summarizer | undefined =
    options.summarizer ??
    (apiKey
      ? openaiSummarizer({ apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) })
      : undefined);

  trace?.record({
    kind: "info",
    label: stageLabel.intentConfig(),
    data: {
      tier: intent.tier,
      transcriber: intent.transcriber,
      model: intent.model,
      realtimeModel: intent.realtimeModel,
      realtimeDelay: intent.realtimeDelay,
      audioBack: intent.audioBack,
      ttsModel: intent.ttsModel,
      realtimeVoice: intent.realtimeVoice,
      linter: intent.linter,
      linterModel: intent.linterModel,
      realtimeReady,
      speakerReady: speaker !== undefined,
      summarizerReady: summarizer !== undefined,
      ...(intent.coerced.length > 0 ? { coerced: intent.coerced } : {}),
    } satisfies IntentConfigData,
  });

  // The turn context owns the single shared, mutable turn state (the merged
  // event stream, the shot-path map, the per-segment audio buffers, the
  // speculative-compose cache, the reassignable realtime/sidecar slots) and the
  // helper surface over it. The methods close over the context, so calling them
  // through these local aliases is identical to `turn.method`; the mutable state
  // (turn.events, turn.realtime, turn.sidecar, …) is always read back through
  // `turn`, never captured by value.
  const turn = createIntentTurn(ctx, trace, intent, composeOptions);
  const { appendEvent, applyShotPaths, recomposeIfStale, push, recordCost, pushSpeech } = turn;

  // Pre-warm the prompt skeleton: the tab/source preamble is fully known at
  // thread-open, so assemble it once here — fin only concatenates the body and
  // the late-arriving selection (archive/streaming-turns.md §2). Empty for a bare client.
  const staticSections = promptContextSections(ctx.hello);
  if (staticSections.length > 0) {
    trace?.record({ kind: "info", label: stageLabel.promptPreamble(), data: staticSections });
  }

  // ── the prompt-linter sidecar (linter != "off") ──────────────────────────────
  // Purely advisory: it observes the same turn through a live session in
  // linter mode and speaks one short diagnostic per pause. Keyless → disabled
  // LOUDLY, once, and dictation still works (the promise in the error text).
  //
  // (Re)buildable to a vendor so a mid-thread `control` chunk can start / stop /
  // swap it LIVE — the client's linter select moving mid-turn, not only at
  // thread-open (owner, 2026-07-16). Teardown is idempotent; `off` leaves no
  // sidecar. The model/instructions/voice stay the hello's — the client's
  // select carries only the vendor, and those advanced fields default to the
  // vendor default when unset (the common case).
  const buildLinter = (vendor: LinterVendor): void => {
    turn.sidecar?.close();
    turn.sidecar = undefined;
    if (vendor === "off") {
      return;
    }
    const linterKey = vendor === "gemini" ? geminiApiKey : apiKey;
    const linterSocketFactory =
      vendor === "gemini" ? options.geminiLiveSocketFactory : options.openaiLiveSocketFactory;
    if (
      (linterKey !== undefined && linterKey !== "") ||
      linterSocketFactory !== undefined ||
      options.linterSessionFactory !== undefined
    ) {
      turn.sidecar = createLinterSidecar({
        vendor,
        apiKey: linterKey ?? "",
        ...(intent.linterModel !== undefined ? { model: intent.linterModel } : {}),
        ...(intent.linterInstructions !== undefined
          ? { instructions: intent.linterInstructions }
          : {}),
        ...(intent.realtimeVoice !== undefined ? { voice: intent.realtimeVoice } : {}),
        promptCwd,
        appendEvent: (event) => appendEvent(event as unknown as IntentEvent),
        push: (produced) => push(produced as unknown as IntentEvent[]),
        pushSpeech,
        recordCost,
        onError: (message, data) =>
          pushError(ctx, {
            source: "linter",
            message,
            detail: vendor === "gemini" ? GEMINI_KEY_HINT : OPENAI_KEY_HINT,
            ...(data !== undefined ? { data } : {}),
          }),
        ...(trace !== undefined ? { record: (stage) => trace.record(stage) } : {}),
        ...(linterSocketFactory !== undefined ? { socketFactory: linterSocketFactory } : {}),
        ...(options.linterSessionFactory !== undefined
          ? { openSession: options.linterSessionFactory }
          : {}),
      });
    } else {
      const message =
        vendor === "gemini"
          ? "prompt linter disabled — the channel process has no GEMINI_API_KEY; dictation still works"
          : "prompt linter disabled — the channel process has no OPENAI_API_KEY; dictation still works";
      push([{ at: Date.now(), type: "note", text: message }]);
      pushError(ctx, {
        source: "linter",
        message,
        detail: vendor === "gemini" ? GEMINI_KEY_HINT : OPENAI_KEY_HINT,
      });
      trace?.record({
        kind: "info",
        label: stageLabel.linterDisabled(),
        data: { vendor, reason: "no key" },
      });
    }
  };
  buildLinter(intent.linter);

  // ── realtime (streaming) transcription session ───────────────────────────────
  // Opened here, at processor construction (≈ thread-open), so the handshake +
  // session.update overlap the arm→talk gap. Deltas echo the preview as you
  // speak; the completed transcript is merged into the stream exactly like the
  // REST path's `transcript-final`. Keyless/error take the same loud
  // finalizeSilentSegment posture — never a silent drop, never a silent switch.
  if (realtimeReady) {
    turn.realtime = openSttSession(turn, ctx, trace, intent, { apiKey, elevenLabsKey }, options);
  }

  // The linter's selection view: latest payload per marker, so a re-emit under
  // the same marker labels as "updated" (the grammar the persona describes).
  const selectionRegistry = new Map<string, SelectionEntry>();

  const onEventsChunk = async (bytes: Uint8Array): Promise<void> => {
    for (const event of readEventBatch(decodeJson(bytes))) {
      appendEvent(event);
      // Selections are first-class in the trace: "did my selection make it
      // in?" must be answerable from a named stage, not by digging through
      // raw input frames. (The composed/fin stages then show what they
      // lowered to.)
      if (event.type === "app-selection") {
        const { at: _at, type: _type, marker, ...data } = event;
        trace?.record({ kind: "ir", label: stageLabel.appSelection(), data: { ...data, marker } });
        const entry: SelectionEntry = { kind: "app", item: data };
        const updated = marker !== undefined && selectionRegistry.has(marker);
        if (marker !== undefined) {
          selectionRegistry.set(marker, entry);
        }
        turn.sidecar?.onSelection(marker, entry, updated);
      } else if (event.type === "code-selection") {
        const { at: _at, type: _type, marker, ...data } = event;
        trace?.record({ kind: "ir", label: stageLabel.codeSelection(), data: { ...data, marker } });
        const entry: SelectionEntry = { kind: "code", item: data };
        const updated = marker !== undefined && selectionRegistry.has(marker);
        if (marker !== undefined) {
          selectionRegistry.set(marker, entry);
        }
        turn.sidecar?.onSelection(marker, entry, updated);
      } else if (event.type === "app-selection-drop") {
        trace?.record({
          kind: "ir",
          label: stageLabel.appSelectionDropped(),
          data: { ...(event.marker !== undefined ? { marker: event.marker } : {}) },
        });
        turn.sidecar?.onSelectionDrop(event.marker);
      } else if (event.type === "code-selection-drop") {
        trace?.record({
          kind: "ir",
          label: stageLabel.codeSelectionDropped(),
          data: { marker: event.marker },
        });
        turn.sidecar?.onSelectionDrop(event.marker);
      }
      // talk-end is the segment-commit boundary for the streaming transcriber
      // (PTT stays the contract — no `last` flag on the audio frames). The
      // client flushes talk-end immediately past its 60 ms debounce so the
      // upstream buffer commits promptly.
      if (realtimeEnabled && event.type === "talk-end") {
        commitRealtimeSegment(turn, trace, intent, event.segment);
      }
      // The linter observes the same boundaries (and a client-produced final —
      // the mock transcriber — feeds its transcript wait like a server one).
      if (event.type === "talk-start") {
        turn.sidecar?.onTalkStart(event.segment);
      } else if (event.type === "talk-end") {
        turn.sidecar?.onTalkEnd(event.segment);
      } else if (event.type === "transcript-final" && !event.correction) {
        turn.sidecar?.onTranscriptFinal(event.segment, event.text);
      }
    }
    // A shot event may share its batch with (or arrive after) its bytes — wire
    // any path already held — then refresh the speculative compose for the batch.
    applyShotPaths();
    recomposeIfStale();
  };

  const onAttachmentChunk = async (
    chunk: Extract<ChunkDescriptor, { kind: "attachment" }>,
    bytes: Uint8Array,
  ): Promise<void> => {
    const { id, mime } = chunk;
    if (id.startsWith("seg_")) {
      // REST transcription is retired: transcription is streaming-only (PCM
      // `audio` chunks into a per-thread session). A whole-segment blob from
      // an old client is still saved for the debugger — its transcript stays
      // empty, exactly like any other segment the stream never resolved.
      silenceTrim(bytes);
      trace?.record({
        kind: "ir",
        label: stageLabel.condition(id, "silenceTrim"),
        data: { identity: true } satisfies ConditionData,
      });
      trace?.recordBlob(
        { kind: "ir", label: stageLabel.attachment(id) },
        bytes,
        `${id}.${audioExtensionForMime(mime)}`,
      );
      recomposeIfStale();
    } else if (id.startsWith("shot_")) {
      const conditioned = imageDownscale(bytes);
      trace?.record({
        kind: "ir",
        label: stageLabel.condition(id, "imageDownscale"),
        data: { identity: true } satisfies ConditionData,
      });
      // Save the shot blob on arrival and wire its path into the (already
      // flushed) shot event. Deliberately no recompose here: the wiring bumps
      // `mutationSeq`, so fin recomputes once with the path present — the one
      // "late mutation between the last batch and fin" the fingerprint catches.
      const path = trace?.recordBlob(
        { kind: "ir", label: stageLabel.attachment(id) },
        conditioned,
        `${id}.${imageExtension(mime)}`,
      );
      if (path !== undefined) {
        turn.shotPaths.set(id, path);
        applyShotPaths();
        // Refresh the LIVE fold too (2026-07-12): the shot's event usually
        // outruns its bytes, so the fold that introduced `{shot_N}` rendered
        // before this blob existed — the trace hero showed "(image not
        // captured)" until the NEXT fold picked the path up (off by one shot,
        // observed live). fin was always correct (the wiring bumps the
        // mutation seq); this makes the preview correct as well.
        recomposeIfStale();
      }
      turn.sidecar?.onShot(id, conditioned, mime);
    }
    // Any other attachment id has no place in the compose and no blob to save.
  };

  // A mid-thread `control` chunk — reconfiguration, never turn content. Today's
  // one control is the prompt linter: start / stop / swap the sidecar live
  // (the client's linter select moving mid-turn). A no-op when the value is
  // unchanged or unrecognized. `intent.linter` is updated too so a later
  // `control` sees the current mode (and the trace reads honestly).
  const onControlChunk = (bytes: Uint8Array): void => {
    const decoded = decodeJson(bytes) as { control?: unknown; value?: unknown } | undefined;
    if (decoded === undefined || decoded.control !== "linter") {
      return;
    }
    const value = decoded.value;
    if (!isLinterVendor(value) || value === intent.linter) {
      return;
    }
    trace?.record({
      kind: "info",
      label: stageLabel.linterControl(),
      data: { from: intent.linter, to: value },
    });
    intent.linter = value;
    buildLinter(value);
  };

  return {
    async onMessage(payload: unknown, meta: MessageMeta) {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(0);
      const chunk = meta.chunk;
      if (chunk?.kind === "events") {
        await onEventsChunk(bytes);
      } else if (chunk?.kind === "attachment") {
        await onAttachmentChunk(chunk, bytes);
      } else if (chunk?.kind === "audio") {
        onAudioChunk(turn, trace, chunk, bytes);
      } else if (chunk?.kind === "control") {
        onControlChunk(bytes);
      }
      if (meta.fin) {
        await finishTurn(
          turn,
          ctx,
          trace,
          intent,
          staticSections,
          speaker,
          summarizer,
          composeOptions,
        );
      }
    },
    onClose() {
      // The connection dropped this turn before `fin`. Nothing user-visible has
      // happened (the invariant) and the trace decorator marks the run
      // abandoned; here we drop the in-memory speculative state so a long-lived
      // connection's abandoned turns don't accumulate, and — the S2 teardown —
      // close the per-thread realtime session so its upstream OpenAI WebSocket
      // is not leaked. Blobs already written to the trace dir are left as the
      // record of the attempt (cheap; the design is silent on cleaning them).
      turn.reset();
      turn.realtime?.close();
      turn.sidecar?.close();
    },
  };
}

export const intentV1Format: ChannelFormat = createIntentV1Format();
