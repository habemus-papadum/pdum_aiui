/**
 * The `intent-v1` stream format: the multimodal intent tool's wire format and
 * its lowering processor.
 *
 * Where `text-concat` accumulates a string, `intent-v1` accumulates the intent
 * tool's **event log** plus binary attachments, and on `fin` lowers the whole
 * turn into one prompt with each screenshot inlined at its position
 * (`[screenshot: <path> (elements: …)]` — paths relativized to this process's
 * cwd, the agent's working directory; see composeIntent).
 * The pipeline core — `composeIntent`, the V4A applier, the config shape — is
 * imported from `@habemus-papadum/aiui-dev-overlay/intent-pipeline`, the same
 * module the browser modality runs, so one implementation and one set of
 * captured fixtures cover both sides (see the graduation handoff, P2).
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
 *  - `context`  → JSON `{ selection }`: the on-screen selection, at most once —
 *    the LEGACY carrier. Current clients ride selections on the stream itself
 *    as positional `app-selection` events (marker `sel_N`; one at thread-open,
 *    one per mid-turn selection, each retractable by marker via
 *    `app-selection-drop`), which `composeIntent` renders INLINE in the body
 *    at their stream position. Only this legacy chunk still lowers through the
 *    context preamble (`selectionSections`) — and only when the stream carried
 *    no `app-selection` events of its own.
 *
 * A correction event that arrives without a `patch` while the hello selected
 * the OpenAI corrector is a request: the V4A diff runs here (against the current
 * composed transcript) and the completed correction is merged and pushed back.
 * A thread that ends in `cancel` (or never fins) lowers to nothing.
 *
 * **Incremental lowering (streaming-turns.md §2).** The cheap, pure, and
 * pre-warmable work happens as events arrive, not at `fin`, so `fin` is a
 * near-empty commit of the one observable side effect (the session
 * notification). Concretely: attachment blobs are saved and shot paths wired on
 * arrival (zero fin-time disk I/O); the condition passes run on each attachment;
 * the prompt's tab/source preamble is pre-warmed at thread-open; and a
 * *speculative* {@link composeIntent} runs after each mutating batch, cached and
 * reused at `fin` when the event log has not changed since (fingerprinted by a
 * mutation counter). The invariant that keeps this safe: speculation only ever
 * populates caches and the trace — never `sendPrompt`, never a push, never a
 * paid re-run — and `fin` alone (and only when not cancelled) commits. An
 * abandoned turn (socket dropped, no `fin`) drops this state via {@link
 * StreamProcessor.onClose} and lowers to nothing.
 */
import {
  applyPatch,
  type ComposedIntent,
  composeIntent,
  DEFAULT_INTENT_CONFIG,
  expandTier,
  type IntentEvent,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import {
  type ChannelFormat,
  type MessageMeta,
  pushError,
  type StreamProcessor,
  type ThreadContext,
} from "./channel";
import { rawCodec } from "./codec";
import { type Corrector, openaiCorrector } from "./correct";
import type { CallCost } from "./cost";
import type { ChunkDescriptor } from "./frame";
import { DEFAULT_GEMINI_LIVE_MODEL, openGeminiLiveSession } from "./gemini-live";
import {
  type LabelEntry,
  resolveSegments,
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";
import {
  LIVE_COMPOSER_INSTRUCTIONS,
  LIVE_NUDGE_TEXT,
  type LiveSession,
  type LiveSessionCallbacks,
} from "./live-session";
import { DEFAULT_OPENAI_LIVE_MODEL, openOpenAiLiveSession } from "./openai-live";
import {
  asSelection,
  promptContextSections,
  type SelectionContext,
  selectionSections,
  wrapWithContext,
} from "./prompt-context";
import {
  DEFAULT_REALTIME_MODEL,
  openRealtimeSession,
  type RealtimeSession,
  type RealtimeSocketFactory,
} from "./realtime";
import {
  DEFAULT_VOICE_INSTRUCTIONS,
  openRealtimeVoiceSession,
  type RealtimeVoiceSession,
} from "./realtime-voice";
import { openaiSpeaker, type Speaker } from "./speak";
import { openaiSummarizer, type Summarizer } from "./summarize";
import type { TraceHandle } from "./trace";
import { traceOf } from "./tracing";
import {
  audioExtensionForMime,
  type FetchLike,
  openaiTranscriber,
  type Transcriber,
} from "./transcribe";

/**
 * A server-produced batch of intent events, pushed to the client to merge into
 * its own stream (transcripts it did not compute, completed correction diffs).
 * Distinguished from a per-frame ack by its `kind` field.
 */
export interface LoweredMessage {
  kind: "lowered";
  threadId: string;
  events: IntentEvent[];
}

/**
 * The turn's final lowered prompt, pushed to the client just before it is sent
 * into the session — exactly what the fin commit hands `sendPrompt`, so a
 * client (the workbench, a widget's "what did I just send?" affordance) can
 * show the committed prompt without polling the trace API. Pushed to every
 * client, unconditionally: the push protocol is additive, and old clients
 * ignore unknown kinds by design. A cancelled or empty turn pushes nothing
 * (there is no prompt to show).
 */
export interface LoweredPromptMessage {
  kind: "lowered-prompt";
  threadId: string;
  /** The full composed prompt (context preamble + body), exactly as sent. */
  prompt: string;
  /** The Option-C attachment paths, when the prompt carries `{shot_N}` tokens. */
  meta?: Record<string, string>;
}

/**
 * A base64 audio clip pushed to the client to play — the `premium` tier's spoken
 * TTS ack and the `flagship` tier's model reply share this one additive message
 * (streaming-turns.md §4, model-tiers.md T2/T3). Distinguished from a per-frame
 * ack and a {@link LoweredMessage} by its `kind`. `label` (when present) is the
 * spoken text, for the widget's speaker line and the trace.
 */
export interface SpeechMessage {
  kind: "speech";
  threadId: string;
  /** A per-thread clip id (`ack_N` / the model `responseId`), for the client player. */
  id: string;
  /** Container MIME of the clip (`audio/mpeg` for TTS acks, `audio/wav` for voice). */
  mime: string;
  /** Base64-encoded audio bytes. */
  data: string;
  /** The spoken text, when known (the widget shows it; the trace records it). */
  label?: string;
}

/**
 * How long `fin` waits for a still-in-flight realtime `…completed` before it
 * finalizes the segment blank and composes anyway. Generous — a spoken segment's
 * final lands well inside a second (the bench measures ~0.8 s); this is the
 * ceiling that keeps a dropped upstream from hanging the send.
 */
const REALTIME_DRAIN_TIMEOUT_MS = 10_000;

/**
 * The upstream's commit minimum: OpenAI rejects `input_audio_buffer.commit`
 * under 100 ms of audio ("buffer too small"). A Space tap released before the
 * worklet delivers its first frames streams less than this (often zero), so
 * talk-end discards such a segment instead of committing it — the debounce
 * that keeps a changed mind from erroring.
 */
const MIN_REALTIME_COMMIT_MS = 100;
/** PCM16 mono at the realtime session's 24 kHz: 48 bytes per millisecond. */
const REALTIME_PCM_BYTES_PER_MS = 48;

/**
 * How long the realtime submode's `fin` waits, after the Enter nudge, for the
 * model's `submit_intent` call before it falls back to composing over the
 * chronicle (§4.3 step 3). Generous — the spike measured Enter→tool-call well
 * inside a few seconds — because the fallback is a genuine degradation (the model
 * didn't compose), so we give it real room first.
 */
const LIVE_DRAIN_TIMEOUT_MS = 12_000;

/**
 * The realtime submode's stale-key hint, the Gemini twin of {@link OPENAI_KEY_HINT}.
 * The single most common cause of "the live tier stopped working" is a missing or
 * revoked GEMINI_API_KEY in the channel process's environment — a condition only
 * the server can see, so the server names it.
 */
const GEMINI_KEY_HINT =
  "If this keeps happening, check the GEMINI_API_KEY in the environment the channel " +
  "process was launched from (a missing/stale key fails every Gemini Live call) — fix it and " +
  "relaunch `aiui claude`, or switch to a transcription tier for text-composed prompts.";

/**
 * The premium tier's spoken-ack trigger table, keyed by lowering milestone → the
 * deterministic phrase the channel synthesizes (no LLM). Data-driven so acks are
 * tuneable; v1 ships the minimal recommended set — one send-received ack on a
 * successful `fin` (streaming-turns.md §4). Add a milestone here (and a call site)
 * to speak at another point.
 */
const ACK_PHRASES: Record<"sent", string> = {
  sent: "sent",
};

/** The subset of `IntentPipelineConfig` the lowering reads off the hello. */
interface ResolvedIntent {
  /** The cost-sized preset, echoed to the trace (the fine fields below are already expanded). */
  tier: string;
  /**
   * Which submode runs. `transcription` (the default) is document assembly —
   * everything the classic processor does; `realtime` holds a live
   * conversational session where the MODEL composes (submit_intent). See
   * transcription-and-realtime-submodes.md.
   */
  submode: "transcription" | "realtime";
  /** Realtime engine (submode=realtime): the reference `gemini` or degraded `openai`. */
  liveVendor: "gemini" | "openai";
  /** Realtime model id (bare, e.g. `gemini-3.1-flash-live-preview`). */
  liveModel: string;
  transcriber: "mock" | "openai" | "openai-realtime" | "openai-voice";
  model: string;
  /** Realtime transcription model (when transcriber = `openai-realtime`). */
  realtimeModel: string;
  /** Realtime latency/accuracy knob (`minimal`…`xhigh`); undefined → model default. */
  realtimeDelay: string | undefined;
  corrector: "mock" | "openai";
  correctionModel: string;
  correctionPolicy: "replace" | "note";
  passes: { silenceTrim: boolean; imageDownscale: boolean };
  /** Spoken audio back to the human: `off` | `acks` (premium TTS) | `voice` (flagship). */
  audioBack: "off" | "acks" | "voice";
  /** REST TTS model for `audioBack:"acks"` (premium). */
  ttsModel: string;
  /** TTS voice id (acks); undefined → the model default. */
  ttsVoice: string | undefined;
  /** Conversational realtime model for `audioBack:"voice"` (flagship). */
  realtimeVoiceModel: string;
  /** Conversational voice id (flagship); undefined → the model default. */
  realtimeVoice: string | undefined;
  /** Function-calling scope for flagship (`none` in v1). */
  realtimeTools: "none" | "submit_intent" | "page";
  /** Reasoning effort for the flagship model (`minimal`…`high`); undefined → model default. */
  realtimeReasoning: string | undefined;
  /** How screenshots render in the lowered body (see ComposeOptions.shotFormat). */
  shotFormat: "xml" | "text";
}

/** The premium TTS default model, and the flagship conversational default. */
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_REALTIME_VOICE_MODEL = "gpt-realtime-2";

/**
 * The remediation line every OpenAI-backed failure carries on its error push.
 * The single most common cause of "the pipeline stopped working" is a stale or
 * revoked OPENAI_API_KEY in the channel process's environment — a condition
 * only the server can see, so the server names it. Attached unconditionally to
 * OpenAI-seam failures: when the real cause is something else (a network blip,
 * a malformed model reply) the message line already says so, and a hint that
 * doesn't apply costs one sentence.
 */
const OPENAI_KEY_HINT =
  "If this keeps happening, check the OPENAI_API_KEY in the environment the channel " +
  "process was launched from (a stale key fails every OpenAI call) — fix it and relaunch " +
  "`aiui claude`, or switch to the mock tier for offline work.";

/** Dependency injection + env for the format (real seams in prod, mocks in tests). */
export interface IntentV1Options {
  /** OpenAI key; defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Injected fetch for the real seams (defaults to the global). */
  fetch?: FetchLike;
  /**
   * Test seam override — used whenever the hello selects `transcriber: openai`,
   * in place of the real REST transcriber.
   */
  transcriber?: Transcriber;
  /** Test seam override — used whenever the hello selects `corrector: openai`. */
  corrector?: Corrector;
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
  /**
   * Test seam override for the flagship voice upstream socket — used whenever the
   * hello selects `transcriber: openai-voice`, in place of the real `ws`
   * connection. Present (even keyless) → the voice path is exercised offline.
   */
  realtimeVoiceSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override for the realtime submode's **Gemini** upstream socket
   * (`submode: realtime`, `liveVendor: gemini`), in place of the real `ws`
   * connection. Present (even keyless) → the live path runs offline (the house
   * pattern; see gemini-live.ts).
   */
  geminiLiveSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override for the realtime submode's **OpenAI** upstream socket
   * (`submode: realtime`, `liveVendor: openai`). Present (even keyless) → the
   * degraded live path runs offline.
   */
  openaiLiveSocketFactory?: RealtimeSocketFactory;
  /**
   * Test seam override for the post-send turn summarizer (see summarize.ts). Its
   * mere presence enables summaries even with no key; absent + keyless → no
   * summary (the gloss is a convenience, never load-bearing). Real seam is the
   * env-keyed {@link openaiSummarizer}.
   */
  summarizer?: Summarizer;
}

/**
 * Read the fields the lowering uses off the loosely-typed hello `intent`, with
 * defaults. The client sends the fully-expanded effective config, so the fine
 * fields are already concrete; but as a **defensive fallback** for a hello that
 * carries only `tier` (or a sparse partial), each field's default is the tier's
 * preset value — the shared `expandTier` from the pipeline package, so both sides
 * agree on what a tier means (model-tiers.md, "Channel side"). Absent tier →
 * `standard`, which reproduces today's REST-mini defaults exactly.
 */
function resolveIntent(raw: unknown): ResolvedIntent {
  const cfg = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value !== "" ? value : fallback;
  const optStr = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  const passes = (
    cfg.passes !== null && typeof cfg.passes === "object" ? cfg.passes : {}
  ) as Record<string, unknown>;
  // The tier's expansion supplies each field's default (below the explicit hello
  // fields), so a `tier`-only hello still resolves concrete seams.
  const tier = str(cfg.tier, "standard");
  const preset = expandTier(tier);
  const liveVendor = oneOf(
    cfg.liveVendor,
    ["gemini", "openai"] as const,
    preset.liveVendor ?? "gemini",
  );
  return {
    tier,
    submode: oneOf(
      cfg.submode,
      ["transcription", "realtime"] as const,
      preset.submode ?? "transcription",
    ),
    liveVendor,
    liveModel: str(
      cfg.liveModel,
      preset.liveModel ??
        (liveVendor === "gemini" ? DEFAULT_GEMINI_LIVE_MODEL : DEFAULT_OPENAI_LIVE_MODEL),
    ),
    transcriber: oneOf(
      cfg.transcriber,
      ["mock", "openai", "openai-realtime", "openai-voice"] as const,
      preset.transcriber,
    ),
    model: str(cfg.model, preset.model),
    realtimeModel: str(cfg.realtimeModel, preset.realtimeModel ?? DEFAULT_REALTIME_MODEL),
    realtimeDelay: optStr(cfg.realtimeDelay ?? preset.realtimeDelay),
    corrector: oneOf(cfg.corrector, ["mock", "openai"] as const, preset.corrector),
    correctionModel: str(cfg.correctionModel, preset.correctionModel),
    correctionPolicy: oneOf(
      cfg.correctionPolicy,
      ["replace", "note"] as const,
      preset.correctionPolicy,
    ),
    passes: {
      silenceTrim: passes.silenceTrim === true,
      imageDownscale: passes.imageDownscale === true,
    },
    audioBack: oneOf(
      cfg.audioBack,
      ["off", "acks", "voice"] as const,
      preset.audioBack ?? DEFAULT_INTENT_CONFIG.audioBack ?? "off",
    ),
    ttsModel: str(cfg.ttsModel, preset.ttsModel ?? DEFAULT_TTS_MODEL),
    ttsVoice: optStr(cfg.ttsVoice ?? preset.ttsVoice),
    realtimeVoiceModel: str(
      cfg.realtimeVoiceModel,
      preset.realtimeVoiceModel ?? DEFAULT_REALTIME_VOICE_MODEL,
    ),
    realtimeVoice: optStr(cfg.realtimeVoice ?? preset.realtimeVoice),
    realtimeTools: oneOf(
      cfg.realtimeTools,
      ["none", "submit_intent", "page"] as const,
      preset.realtimeTools ?? "none",
    ),
    realtimeReasoning: optStr(cfg.realtimeReasoning ?? preset.realtimeReasoning),
    shotFormat: oneOf(cfg.shotFormat, ["xml", "text"] as const, "xml"),
  };
}

// ── the cleanup passes (openai-audio-stack.md) ───────────────────────────────
// Condition passes shrink/clean an upload *before* the expensive hop. Real
// trimming/downscaling is a lab measurement that ships later; the structure —
// a named slot on each side of the pipe, gated by config — is what P2 commits
// to, so the pipeline is already shaped for the real behavior. Identity today.

interface PassResult {
  bytes: Uint8Array;
  /** Whether the slot was engaged (config on) — recorded in the trace. */
  engaged: boolean;
}

const silenceTrim = (bytes: Uint8Array, enabled: boolean): PassResult => ({
  bytes,
  engaged: enabled,
});
const imageDownscale = (bytes: Uint8Array, enabled: boolean): PassResult => ({
  bytes,
  engaged: enabled,
});

/** Parse the trailing ordinal of an identifier-shaped attachment id (`seg_3` → 3). */
function ordinalOf(id: string): number {
  const match = /_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** True when the current thread (from its last open) ended in an explicit cancel. */
function endedInCancel(events: IntentEvent[]): boolean {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);
  for (let i = scope.length - 1; i >= 0; i--) {
    const event = scope[i];
    if (event.type === "thread-close") {
      return event.reason === "cancel";
    }
  }
  return false;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode a JSON chunk payload (events / context frames). */
function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) {
    return undefined;
  }
  return JSON.parse(utf8Decoder.decode(bytes));
}

/** Narrow a decoded events chunk to `IntentEvent[]` (append-only batch). */
function readEventBatch(decoded: unknown): IntentEvent[] {
  if (decoded === null || typeof decoded !== "object") {
    throw new Error('intent-v1 events chunk must be JSON { "events": IntentEvent[] }');
  }
  const { events } = decoded as { events?: unknown };
  if (!Array.isArray(events)) {
    throw new Error('intent-v1 events chunk is missing an "events" array');
  }
  return events as IntentEvent[];
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
  const trace = traceOf(ctx);
  // The base every prompt path (screenshots AND source locations) relativizes
  // against — the agent's working directory. Defaults to this process's cwd
  // (right for `aiui claude`, whose channel runs in the project); a supervisor
  // whose cwd is elsewhere overrides via AIUI_PROMPT_CWD (the workbench spawns
  // its channel in the workbench package but wants repo-root-relative paths).
  const promptCwd = process.env.AIUI_PROMPT_CWD || process.cwd();
  const composeOptions = { cwd: promptCwd, shotFormat: intent.shotFormat };

  // The realtime submode is a different processor entirely — the model composes,
  // not composeIntent — so it forks here, sharing only the resolved config, the
  // trace, and the prompt cwd. Everything below this branch is transcription mode.
  if (intent.submode === "realtime") {
    return realtimeIntentProcessor(ctx, options, intent, apiKey, trace, composeOptions);
  }

  // Resolve the pipe seams once. `openai` requested but keyless (and no test
  // override) → the seam is absent and that stage degrades (no transcript /
  // plain-replacement correction) rather than failing the turn.
  const transcriber: Transcriber | undefined =
    intent.transcriber === "openai"
      ? (options.transcriber ??
        (apiKey
          ? openaiTranscriber({ model: () => intent.model, apiKey, fetch: options.fetch })
          : undefined))
      : undefined;
  const corrector: Corrector | undefined =
    intent.corrector === "openai"
      ? (options.corrector ??
        (apiKey
          ? openaiCorrector({ model: () => intent.correctionModel, apiKey, fetch: options.fetch })
          : undefined))
      : undefined;

  // The realtime (streaming) transcriber is a *session*, not a per-blob seam:
  // one upstream WS per thread, opened at thread-open (below) so its handshake
  // overlaps the arm→talk gap. Keyless with no test factory → the session is
  // absent and the segment degrades loudly (the REST-keyless posture), never a
  // silent switch to mock. A test factory forces the path on with no key.
  const realtimeEnabled = intent.transcriber === "openai-realtime";
  const realtimeReady =
    realtimeEnabled &&
    ((apiKey !== undefined && apiKey !== "") || options.realtimeSocketFactory !== undefined);

  // The flagship conversational voice session (openai-voice): same per-thread WS
  // shape, but the model answers aloud. Its input transcription still feeds the
  // IR, so it is a superset of `rapid`, not a replacement. Keyless with no test
  // factory → absent + loud, never a silent downgrade to REST.
  const voiceEnabled = intent.transcriber === "openai-voice";
  const voiceReady =
    voiceEnabled &&
    ((apiKey !== undefined && apiKey !== "") || options.realtimeVoiceSocketFactory !== undefined);

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
    label: "intent config",
    data: {
      tier: intent.tier,
      transcriber: intent.transcriber,
      model: intent.model,
      realtimeModel: intent.realtimeModel,
      realtimeDelay: intent.realtimeDelay,
      corrector: intent.corrector,
      correctionModel: intent.correctionModel,
      correctionPolicy: intent.correctionPolicy,
      passes: intent.passes,
      audioBack: intent.audioBack,
      ttsModel: intent.ttsModel,
      realtimeVoiceModel: intent.realtimeVoiceModel,
      realtimeVoice: intent.realtimeVoice,
      realtimeTools: intent.realtimeTools,
      transcriberReady: transcriber !== undefined,
      realtimeReady,
      correctorReady: corrector !== undefined,
      speakerReady: speaker !== undefined,
      voiceReady,
      summarizerReady: summarizer !== undefined,
    },
  });

  // The turn's single accumulated stream, in arrival order — client events
  // interleaved with server-produced ones (transcripts, completed corrections)
  // exactly where they were produced. This *is* the merge the fin lowering runs.
  let events: IntentEvent[] = [];
  // Absolute path of each shot's saved blob. Populated on the shot's arrival
  // (its bytes are saved then, not at fin) and wired into the matching shot
  // event so fin does no disk I/O.
  const shotPaths = new Map<string, string>();
  // The LEGACY context-chunk selection (older clients). Ignored the moment the
  // stream carries its own `app-selection` events — those render inline in the
  // body, and the preamble section must not duplicate them.
  let selection: SelectionContext | undefined;
  let streamHasSelection = false;
  let engagedSilenceTrim = false;
  let engagedImageDownscale = false;

  // The per-thread realtime session (assigned once the helpers it calls back into
  // exist, below). Segments stream PCM into it during talk and commit at talk-end.
  let realtime: RealtimeSession | undefined;
  // The per-thread flagship voice session (openai-voice). Mutually exclusive with
  // `realtime` — a hello selects one transcriber. Same PCM-append/commit shape.
  let realtimeVoice: RealtimeVoiceSession | undefined;
  // Monotonic id for TTS-ack clips pushed to the client (`ack_0`, `ack_1`, …).
  let ackSeq = 0;
  // Accumulated PCM frames per streaming segment — saved as one blob at commit so
  // the debugger has the audio (the realtime analogue of the REST seg blob).
  const audioFrames = new Map<number, { chunks: Uint8Array[]; bytes: number; lastSeq: number }>();

  // Pre-warm the prompt skeleton: the tab/source preamble is fully known at
  // thread-open, so assemble it once here — fin only concatenates the body and
  // the late-arriving selection (streaming-turns.md §2). Empty for a bare client.
  const staticSections = promptContextSections(ctx.hello);
  if (staticSections.length > 0) {
    trace?.record({ kind: "info", label: "prompt preamble", data: staticSections });
  }

  // Speculative-compose cache. `mutationSeq` bumps on every change to `events`
  // (an append or a shot-path wiring); `recompose` snapshots it into
  // `composedSeq`. fin reuses `lastComposed` when the log is unchanged since
  // (composedSeq === mutationSeq) and otherwise recomputes — either way
  // producing exactly what a fresh `composeIntent(events)` would. The cache is a
  // latency shim, never a source of truth.
  let mutationSeq = 0;
  let composedSeq = -1;
  let lastComposed: ComposedIntent | undefined;

  const appendEvent = (event: IntentEvent): void => {
    events.push(event);
    mutationSeq += 1;
  };

  /** Wire every known shot path into the current events (idempotent). */
  const applyShotPaths = (): void => {
    if (shotPaths.size === 0) {
      return;
    }
    let changed = false;
    events = events.map((event) => {
      if (
        event.type === "shot" &&
        shotPaths.has(event.marker) &&
        event.path !== shotPaths.get(event.marker)
      ) {
        changed = true;
        return { ...event, path: shotPaths.get(event.marker) };
      }
      return event;
    });
    if (changed) {
      mutationSeq += 1;
    }
  };

  /**
   * Speculative fold of the merged stream so far. Pure and side-effect-free
   * beyond the cache + a trace stage (the invariant: speculation never sends,
   * pushes, or spends). fin reuses this when the log is unchanged since.
   */
  const recompose = (): void => {
    lastComposed = composeIntent(events, intent.correctionPolicy, composeOptions);
    composedSeq = mutationSeq;
    trace?.record({
      kind: "ir",
      label: "composed (speculative)",
      data: { transcript: lastComposed.transcript, prompt: lastComposed.prompt },
    });
  };

  /** Recompose only if the log changed since the last cache — the arrival seam. */
  const recomposeIfStale = (): void => {
    if (composedSeq !== mutationSeq) {
      recompose();
    }
  };

  const push = (produced: IntentEvent[]): void => {
    ctx.push?.({
      kind: "lowered",
      threadId: ctx.threadId,
      events: produced,
    } satisfies LoweredMessage);
  };

  /**
   * Account one model call: a `cost:` trace stage (what/usage/usd — the trace
   * viewer renders these as 💰 cards) plus the manifest's running roll-up.
   * Unpriced calls (a model missing from the catalog) still record usage; only
   * a priced call moves the roll-up. Post-end callers (the summary gloss) get
   * the roll-up but no stage — `record` is closed by then, by design.
   */
  const recordCost = (what: string, cost: CallCost | undefined): void => {
    if (!cost) {
      return;
    }
    trace?.record({ kind: "info", label: `cost: ${what}`, data: cost });
    if (cost.usd !== undefined) {
      trace?.addCost(cost.usd);
    }
  };

  /** Push a base64 audio clip for the client to play (TTS ack / model reply). */
  const pushSpeech = (id: string, mime: string, bytes: Uint8Array, label?: string): void => {
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
      label: `speech ${id}`,
      data: { mime, bytes: bytes.length, ...(label !== undefined ? { text: label } : {}) },
    });
  };

  /** Run the correction diff for a patchless request, or fall back on failure. */
  const resolveCorrection = async (
    request: Extract<IntentEvent, { type: "correction" }>,
  ): Promise<void> => {
    // Document = segments-as-lines from the current composed state (the same
    // shape the corrector model and the applier share — field-notes contract),
    // narrowed to the request's chunk scope when it carries one: the model
    // only ever sees the chunk the user was editing, so "fix every occurrence"
    // can't leak across an image boundary. The patch stays context-anchored,
    // so it applies to the full document unchanged.
    const composed = composeIntent(events, intent.correctionPolicy, composeOptions);
    const allLines = composed.items
      .filter((item) => item.kind === "text")
      .map((item) => item.text ?? "");
    const docLines = request.scope
      ? allLines.slice(
          Math.max(0, request.scope.fromLine),
          Math.min(allLines.length, request.scope.toLine),
        )
      : allLines;
    // Trace the whole round-trip: "why didn't my fix apply?" must be
    // answerable from the trace viewer, not reconstructed from toasts.
    trace?.record({
      kind: "ir",
      label: "correction request",
      data: { selected: request.original, instruction: request.instruction, docLines },
    });
    try {
      const diff = await corrector?.diff({
        docLines,
        selected: request.original,
        instruction: request.instruction,
      });
      if (!diff) {
        throw new Error("corrector unavailable");
      }
      // Validate the patch actually applies; a patch that does not is treated
      // as malformed and dropped so the client falls back to plain replacement.
      applyPatch(docLines, diff.patch);
      trace?.record({
        kind: "ir",
        label: "correction patch",
        // The call's cost rides the patch stage itself (one card in the
        // viewer), but still moves the manifest roll-up below.
        data: {
          model: diff.model,
          latencyMs: diff.latencyMs,
          patch: diff.patch,
          ...(diff.cost ? { cost: diff.cost } : {}),
        },
      });
      if (diff.cost?.usd !== undefined) {
        trace?.addCost(diff.cost.usd);
      }
      const completed: IntentEvent = {
        ...request,
        patch: diff.patch,
        model: diff.model,
        latencyMs: diff.latencyMs,
      };
      appendEvent(completed);
      push([completed]);
    } catch (error) {
      // Corrections never silently vanish: push the request through without a
      // patch (plain first-occurrence replacement downstream) — and say WHY.
      // Before the error push, the cause (an invalid key 401, a patch that
      // wouldn't apply) died here in this catch; the client could only report
      // "the echo had no patch".
      const fallback: IntentEvent = { ...request, patch: undefined };
      appendEvent(fallback);
      push([fallback]);
      const message = error instanceof Error ? error.message : String(error);
      trace?.record({ kind: "info", label: "correction failed", data: { message } });
      pushError(ctx, {
        source: "correction",
        message: `correction failed — applied as a plain replacement instead: ${message}`,
        detail: OPENAI_KEY_HINT,
      });
    }
    // The merged stream just changed — refresh the speculative compose.
    recompose();
  };

  /**
   * Finalize a segment we could not transcribe: echo an empty `transcript-final`
   * (so the client's preview resolves instead of waiting for an echo that will
   * never come) plus a `note` the widget shows in its status — and push the
   * same text as a generic error (see {@link pushError}) so the failure is
   * visible even with the panel closed (the note only reaches the footer
   * status line). Degradation is loud and specific — never a silent drop,
   * never a silent switch to mock.
   */
  const finalizeSilentSegment = (
    id: string,
    noteText: string,
    error: { source: string; detail?: string } = { source: "transcription" },
  ): void => {
    const empty: IntentEvent = {
      at: Date.now(),
      type: "transcript-final",
      segment: ordinalOf(id),
      text: "",
      latencyMs: 0,
      model: intent.model,
    };
    appendEvent(empty);
    push([empty, { at: Date.now(), type: "note", text: noteText }]);
    pushError(ctx, {
      source: error.source,
      message: noteText,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    });
  };

  // ── realtime (streaming) transcription session ───────────────────────────────
  // Opened here, at processor construction (≈ thread-open), so the handshake +
  // session.update overlap the arm→talk gap. Deltas echo the preview as you
  // speak; the completed transcript is merged into the stream exactly like the
  // REST path's `transcript-final`. Keyless/error take the same loud
  // finalizeSilentSegment posture — never a silent drop, never a silent switch.
  if (realtimeReady) {
    realtime = openRealtimeSession(
      {
        apiKey: apiKey ?? "",
        model: () => intent.realtimeModel,
        delay: () => intent.realtimeDelay,
        ...(options.realtimeSocketFactory !== undefined
          ? { socketFactory: options.realtimeSocketFactory }
          : {}),
      },
      {
        onDelta: (segment, text) => {
          push([{ at: Date.now(), type: "transcript-delta", segment, text }]);
        },
        onFinal: (segment, result) => {
          recordCost(`realtime transcription seg_${segment}`, result.cost);
          const produced: IntentEvent = {
            at: Date.now(),
            type: "transcript-final",
            segment,
            text: result.text,
            latencyMs: result.latencyMs,
            model: result.model,
          };
          appendEvent(produced);
          push([produced]);
          recomposeIfStale();
        },
        onError: (message, segment) => {
          if (segment !== undefined) {
            finalizeSilentSegment(`seg_${segment}`, `realtime transcription failed: ${message}`, {
              source: "transcription",
              detail: OPENAI_KEY_HINT,
            });
          } else {
            // Session-wide fault before any commit (a refused upstream
            // handshake is where a bad key shows up on this path).
            push([{ at: Date.now(), type: "note", text: `realtime transcription: ${message}` }]);
            pushError(ctx, {
              source: "transcription",
              message: `realtime transcription: ${message}`,
              detail: OPENAI_KEY_HINT,
            });
          }
        },
      },
    );
  }

  // ── flagship conversational voice session (openai-voice) ─────────────────────
  // Same lifecycle as the STT session above, but the model answers aloud. The
  // input transcription (onUserFinal) feeds compose exactly like `rapid`, so the
  // IR never depends on the model speaking; the model's audio (onAudio) rides the
  // additive `speech` message and its spoken reply (onReplyTranscript) is surfaced
  // to the widget + trace. Function calling is `none` in v1 (nothing reaches the
  // page). Keyless/error take the same loud finalizeSilentSegment posture.
  if (voiceReady) {
    realtimeVoice = openRealtimeVoiceSession(
      {
        apiKey: apiKey ?? "",
        model: () => intent.realtimeVoiceModel,
        voice: () => intent.realtimeVoice,
        transcriptionModel: () => intent.model,
        instructions: DEFAULT_VOICE_INSTRUCTIONS,
        ...(options.realtimeVoiceSocketFactory !== undefined
          ? { socketFactory: options.realtimeVoiceSocketFactory }
          : {}),
      },
      {
        onUserDelta: (segment, text) => {
          push([{ at: Date.now(), type: "transcript-delta", segment, text }]);
        },
        onUserFinal: (segment, result) => {
          const produced: IntentEvent = {
            at: Date.now(),
            type: "transcript-final",
            segment,
            text: result.text,
            latencyMs: result.latencyMs,
            model: result.model,
          };
          appendEvent(produced);
          push([produced]);
          recomposeIfStale();
        },
        onAudio: (clip) => {
          pushSpeech(`reply_${clip.responseId}`, clip.mime, clip.bytes);
        },
        onReplyTranscript: (text) => {
          // What the human was told — a status note (the widget shows it) and the
          // trace records it; never the IR (text stays the single source of truth).
          push([{ at: Date.now(), type: "note", text: `🔊 ${text}` }]);
          trace?.record({ kind: "info", label: "voice reply", data: { text } });
        },
        onUsage: (cost, responseId) => {
          // Conversational responses re-bill the whole context each time — the
          // per-response accounting is exactly where the money goes.
          recordCost(`voice response ${responseId}`, cost);
        },
        onError: (message, segment) => {
          if (segment !== undefined) {
            finalizeSilentSegment(`seg_${segment}`, `flagship voice failed: ${message}`, {
              source: "voice",
              detail: OPENAI_KEY_HINT,
            });
          } else {
            push([{ at: Date.now(), type: "note", text: `flagship voice: ${message}` }]);
            pushError(ctx, {
              source: "voice",
              message: `flagship voice: ${message}`,
              detail: OPENAI_KEY_HINT,
            });
          }
        },
      },
    );
  }

  /** Commit a streaming segment at talk-end: save its accumulated PCM, then commit. */
  const commitRealtimeSegment = (segment: number): void => {
    const buffered = audioFrames.get(segment);
    if (buffered !== undefined) {
      audioFrames.delete(segment);
      if (buffered.chunks.length > 0) {
        const merged = new Uint8Array(buffered.bytes);
        let offset = 0;
        for (const chunk of buffered.chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        trace?.recordBlob(
          { kind: "ir", label: `attachment seg_${segment}` },
          merged,
          `seg_${segment}.pcm`,
        );
      }
      trace?.record({
        kind: "ir",
        label: `realtime commit seg_${segment}`,
        data: { frames: buffered.chunks.length, bytes: buffered.bytes },
      });
    }
    // The Space-tap debounce: the upstream rejects a commit under 100 ms of
    // audio ("buffer too small"), and a tapped-and-released key often streams
    // zero frames. Discard instead of committing — clear the upstream buffer,
    // resolve the segment as empty (the preview stops waiting), and record it
    // in the trace. Quiet by design: an accidental tap is not an error.
    const session = realtime ?? realtimeVoice;
    const pcmBytes = buffered?.bytes ?? 0;
    if (session !== undefined && pcmBytes < MIN_REALTIME_COMMIT_MS * REALTIME_PCM_BYTES_PER_MS) {
      session.discard(segment);
      const empty: IntentEvent = {
        at: Date.now(),
        type: "transcript-final",
        segment,
        text: "",
        latencyMs: 0,
        model: intent.model,
      };
      appendEvent(empty);
      push([empty]);
      trace?.record({
        kind: "info",
        label: `realtime discard seg_${segment}`,
        data: {
          bytes: pcmBytes,
          ms: Math.round(pcmBytes / REALTIME_PCM_BYTES_PER_MS),
          note: `under the ${MIN_REALTIME_COMMIT_MS} ms upstream commit minimum — not transcribed`,
        },
      });
      return;
    }
    if (realtime !== undefined) {
      realtime.commit(segment);
    } else if (realtimeVoice !== undefined) {
      realtimeVoice.commit(segment);
    } else if (realtimeEnabled || voiceEnabled) {
      // Keyless realtime/voice: no session to commit into. Same loud note as REST
      // keyless — the preview resolves and the widget can say why.
      finalizeSilentSegment(
        `seg_${segment}`,
        `${voiceEnabled ? "flagship voice" : "server-side realtime transcription"} is unavailable — ` +
          "the channel process has no OPENAI_API_KEY. " +
          'Set it and relaunch `aiui claude`, or use transcriber:"mock" for offline work.',
        { source: voiceEnabled ? "voice" : "transcription" },
      );
    }
  };

  const onAudioChunk = (
    chunk: Extract<ChunkDescriptor, { kind: "audio" }>,
    bytes: Uint8Array,
  ): void => {
    const segment = ordinalOf(chunk.id);
    let buffered = audioFrames.get(segment);
    if (buffered === undefined) {
      buffered = { chunks: [], bytes: 0, lastSeq: -1 };
      audioFrames.set(segment, buffered);
    }
    // seq is a monotonic ordinal per segment; frames arrive in per-connection
    // order, so this holds in practice. A gap/reorder is tolerated (forwarded in
    // arrival order — the upstream buffer is append-only) but noted in the trace.
    if (chunk.seq <= buffered.lastSeq) {
      trace?.record({
        kind: "info",
        label: `audio ${chunk.id} out-of-order`,
        data: { seq: chunk.seq, lastSeq: buffered.lastSeq, note: "tolerated (arrival order kept)" },
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
    // Only one of the two sessions is ever active (a hello picks one transcriber).
    realtime?.appendAudio(segment, copy);
    realtimeVoice?.appendAudio(segment, copy);
  };

  const onEventsChunk = async (bytes: Uint8Array): Promise<void> => {
    for (const event of readEventBatch(decodeJson(bytes))) {
      // A patchless correction under the OpenAI corrector is a diff request; the
      // completed correction is pushed into this same stream (and echoed). Every
      // other event — including a correction that already carries its patch — is
      // appended in arrival order. The client applies our echo locally and never
      // re-sends the correction, so no patched twin appears on the wire.
      if (event.type === "correction" && event.patch === undefined && corrector !== undefined) {
        await resolveCorrection(event);
      } else {
        appendEvent(event);
        // Selections are first-class in the trace: "did my selection make it
        // in?" must be answerable from a named stage, not by digging through
        // raw input frames. (The composed/fin stages then show what they
        // lowered to.)
        if (event.type === "app-selection") {
          // The stream carries its own selections now: they render INLINE in
          // the body (composeIntent), so the legacy context-chunk preamble
          // must stand down for this turn or the selection would ride twice.
          streamHasSelection = true;
          const { at: _at, type: _type, ...data } = event;
          trace?.record({ kind: "ir", label: "app selection", data });
        } else if (event.type === "code-selection") {
          const { at: _at, type: _type, ...data } = event;
          trace?.record({ kind: "ir", label: "code selection", data });
        } else if (event.type === "app-selection-drop") {
          trace?.record({
            kind: "ir",
            label: "app selection dropped",
            data: { ...(event.marker !== undefined ? { marker: event.marker } : {}) },
          });
        } else if (event.type === "code-selection-drop") {
          trace?.record({
            kind: "ir",
            label: "code selection dropped",
            data: { marker: event.marker },
          });
        }
        // talk-end is the segment-commit boundary for the streaming transcriber
        // (PTT stays the contract — no `last` flag on the audio frames). The
        // client flushes talk-end immediately past its 60 ms debounce so the
        // upstream buffer commits promptly.
        if ((realtimeEnabled || voiceEnabled) && event.type === "talk-end") {
          commitRealtimeSegment(event.segment);
        }
        // Barge-in: a new talk while the flagship model is still speaking cancels
        // its reply upstream (the overlay ducks local playback in parallel).
        if (voiceEnabled && event.type === "talk-start") {
          realtimeVoice?.cancelActiveResponse();
        }
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
      const conditioned = silenceTrim(bytes, intent.passes.silenceTrim);
      engagedSilenceTrim = engagedSilenceTrim || conditioned.engaged;
      trace?.record({
        kind: "ir",
        label: `condition ${id} (silenceTrim)`,
        data: { enabled: intent.passes.silenceTrim, engaged: conditioned.engaged },
      });
      // Save the segment blob on arrival (the debugger reads it; fin does no I/O).
      trace?.recordBlob(
        { kind: "ir", label: `attachment ${id}` },
        bytes,
        `${id}.${audioExtensionForMime(mime)}`,
      );
      if (transcriber !== undefined) {
        try {
          const result = await transcriber.transcribe({ bytes: conditioned.bytes, mime });
          recordCost(`transcription ${id}`, result.cost);
          const produced: IntentEvent = {
            at: Date.now(),
            type: "transcript-final",
            segment: ordinalOf(id),
            text: result.text,
            latencyMs: result.latencyMs,
            model: result.model,
          };
          appendEvent(produced);
          push([produced]);
        } catch (error) {
          // A live transcription failure (an invalid key, a REST error): don't
          // reject the frame into silence — echo a note the widget surfaces,
          // and an error push naming the likeliest fix (the stale-key hint).
          // Also record it in the trace: the toast is ephemeral, and a trace
          // whose transcript is silently empty is undebuggable after the fact.
          const message = error instanceof Error ? error.message : String(error);
          trace?.record({ kind: "info", label: `transcription failed ${id}`, data: { message } });
          finalizeSilentSegment(id, `transcription failed: ${message}`, {
            source: "transcription",
            detail: OPENAI_KEY_HINT,
          });
        }
      } else if (intent.transcriber === "openai") {
        // The hello asked for channel-side transcription but this channel has no
        // OPENAI_API_KEY (the seam is absent). Since `openai` is the shipped
        // default, a keyless launch lands here — say so rather than dropping the
        // segment silently and leaving the preview waiting forever.
        finalizeSilentSegment(
          id,
          "server-side transcription is unavailable — the channel process has no OPENAI_API_KEY. " +
            'Set it and relaunch `aiui claude`, or use transcriber:"mock" for offline work.',
        );
      }
      // A completed segment lands its transcript here — refresh the cache.
      recomposeIfStale();
    } else if (id.startsWith("shot_")) {
      const conditioned = imageDownscale(bytes, intent.passes.imageDownscale);
      engagedImageDownscale = engagedImageDownscale || conditioned.engaged;
      trace?.record({
        kind: "ir",
        label: `condition ${id} (imageDownscale)`,
        data: { enabled: intent.passes.imageDownscale, engaged: conditioned.engaged },
      });
      // Save the shot blob on arrival and wire its path into the (already
      // flushed) shot event. Deliberately no recompose here: the wiring bumps
      // `mutationSeq`, so fin recomputes once with the path present — the one
      // "late mutation between the last batch and fin" the fingerprint catches.
      const path = trace?.recordBlob(
        { kind: "ir", label: `attachment ${id}` },
        conditioned.bytes,
        `${id}.png`,
      );
      if (path !== undefined) {
        shotPaths.set(id, path);
        applyShotPaths();
      }
    }
    // Any other attachment id has no place in the compose and no blob to save.
  };

  const onContextChunk = (bytes: Uint8Array): void => {
    const decoded = decodeJson(bytes);
    selection = asSelection(decoded) ?? selection;
  };

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
      push([{ at: Date.now(), type: "note", text }]);
      pushError(ctx, { source: "speech", message: text });
      return;
    }
    try {
      const clip = await speaker.speak({
        text: phrase,
        ...(intent.ttsVoice !== undefined ? { voice: intent.ttsVoice } : {}),
      });
      recordCost("tts ack", clip.cost);
      pushSpeech(`ack_${ackSeq++}`, clip.mime, clip.bytes, phrase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      push([{ at: Date.now(), type: "note", text: `spoken confirmation failed: ${message}` }]);
      pushError(ctx, {
        source: "speech",
        message: `spoken confirmation failed: ${message}`,
        detail: OPENAI_KEY_HINT,
      });
    }
  };

  /**
   * Gloss the just-sent turn onto its trace, off the hot path. Fired
   * fire-and-forget from {@link lower} *after* the send — the fin ack must never
   * wait on a summary — so by the time this resolves the trace has usually ended
   * already; {@link TraceHandle.setSummary} is designed to write post-end. Input
   * is the composed body (no preamble; screenshots stripped inside the seam).
   * Keyless (no seam) or any failure → skip silently: a missing row gloss falls
   * back to the timestamp, never a broken turn. (A failure can't be traced here —
   * `record` no-ops once the trace has ended — so the drop is genuinely silent.)
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

  /** The fin commit: pick the composed intent (cached or fresh) and notify. */
  const lower = async (): Promise<void> => {
    // Realtime finals arrive off-band (over the upstream socket), not on the
    // frame that carried the audio — so a fast Enter can outrun a `…completed`.
    // Drain the committed-but-not-final segments before composing; any that miss
    // the window are finalized loudly so the compose (and the preview) resolve.
    // The STT and voice sessions are mutually exclusive; drain whichever is live.
    const streamSession = realtime ?? realtimeVoice;
    if (streamSession !== undefined) {
      const timedOut = await streamSession.drain(REALTIME_DRAIN_TIMEOUT_MS);
      for (const segment of timedOut) {
        finalizeSilentSegment(
          `seg_${segment}`,
          "realtime transcription did not complete before send — the segment was left blank",
        );
      }
      recomposeIfStale();
    }

    // Blobs were saved and shot paths wired on arrival; the only wiring left is
    // the defensive case of a shot event that trailed its bytes (usually a no-op).
    applyShotPaths();

    trace?.record({ kind: "ir", label: "merged events", data: events });

    const cancelled = endedInCancel(events);
    // Reuse the speculative compose when the log is unchanged since it last ran;
    // otherwise recompute (e.g. a shot path was wired after the final batch).
    let composed: ComposedIntent;
    let reused: boolean;
    if (lastComposed !== undefined && composedSeq === mutationSeq) {
      composed = lastComposed;
      reused = true;
    } else {
      composed = composeIntent(events, intent.correctionPolicy, composeOptions);
      reused = false;
    }
    trace?.record({ kind: "info", label: "fin compose", data: { reused } });
    trace?.record({
      kind: "ir",
      label: "composed intent",
      data: {
        transcript: composed.transcript,
        items: composed.items,
        corrections: composed.corrections,
        prompt: composed.prompt,
        meta: composed.meta,
      },
    });
    trace?.record({
      kind: "ir",
      label: "conditioned",
      data: {
        cancelled,
        passes: {
          silenceTrim: { enabled: intent.passes.silenceTrim, engaged: engagedSilenceTrim },
          imageDownscale: { enabled: intent.passes.imageDownscale, engaged: engagedImageDownscale },
        },
        body: composed.prompt,
        meta: composed.meta,
      },
    });

    // A cancelled turn (or one with nothing to say) lowers to no notification.
    if (!cancelled && composed.prompt !== "") {
      // App selections are stream events, folded by composeIntent into the
      // BODY at their positions (marker-keyed latest-wins, drops honored) —
      // already part of composed.prompt. The preamble's selection section
      // survives only for the legacy send-time `context` chunk (older
      // clients), and stands down when the stream carried its own selections.
      const prompt = wrapWithContext(
        [...staticSections, ...selectionSections(streamHasSelection ? undefined : selection)],
        composed.prompt,
      );
      const meta = Object.keys(composed.meta).length > 0 ? composed.meta : undefined;
      // Show the client what is about to be committed (pushed first, so the
      // widget's view of the prompt never lags the session notification).
      ctx.push?.({
        kind: "lowered-prompt",
        threadId: ctx.threadId,
        prompt,
        ...(meta !== undefined ? { meta } : {}),
      } satisfies LoweredPromptMessage);
      await ctx.sendPrompt(prompt, meta);
      // Premium tier: a spoken "sent" once the notification landed (the send-
      // received ack — the minimal recommended trigger set, streaming-turns.md §4).
      await speakAck();
      // Gloss the turn for the trace list — detached, so the fin ack does not
      // wait on a chat round-trip. `composed.prompt` is the body only (the
      // preamble is context, not intent). Best-effort; never awaited.
      void summarize(composed.prompt);
    }
    // The turn committed — the upstream socket(s) have no more segments to handle,
    // so close (idempotent; onClose closes them for abandoned turns).
    realtime?.close();
    realtimeVoice?.close();
    ctx.close();
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
        onAudioChunk(chunk, bytes);
      } else if (chunk?.kind === "context") {
        onContextChunk(bytes);
      }
      if (meta.fin) {
        await lower();
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
      events = [];
      shotPaths.clear();
      lastComposed = undefined;
      audioFrames.clear();
      realtime?.close();
      realtimeVoice?.close();
    },
  };
}

/**
 * The **realtime submode** processor (transcription-and-realtime-submodes.md §4).
 * The classic {@link intentProcessor} above assembles a document and lets
 * `composeIntent` compile it; here a live conversational session
 * ({@link LiveSession}, Gemini or OpenAI) is held per-thread, the *model* composes
 * via `submit_intent`, and the channel re-attaches the withheld metadata — shot
 * paths/elements, full selection renderings — as it resolves the call. The event
 * stream stays the IR of record — the chronicle —
 * so the trace debugger keeps working and the fin ladder's step-3 fallback
 * (`composeIntent` over the transcripts) is free.
 *
 * Shares only the resolved config, the trace, and the prompt cwd with the classic
 * path; everything below is its own thin assembly (companion doc §B.3: two
 * assemblies over one parts bin, not one component with mode flags).
 */
function realtimeIntentProcessor(
  ctx: ThreadContext,
  options: IntentV1Options,
  intent: ResolvedIntent,
  apiKey: string | undefined,
  trace: TraceHandle | undefined,
  composeOptions: { cwd: string; shotFormat: "xml" | "text" },
): StreamProcessor {
  const keyed = apiKey !== undefined && apiKey !== "";
  const keyHint = intent.liveVendor === "gemini" ? GEMINI_KEY_HINT : OPENAI_KEY_HINT;
  const keyName = intent.liveVendor === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";

  // Pre-warm the tab/source preamble (hello-fixed) exactly like the classic path;
  // the model composes the body, the channel still owns context + commitment.
  const staticSections = promptContextSections(ctx.hello);

  // The chronicle: every event in arrival order (client acts + server-produced
  // transcripts). It is the fallback compiler's input and the trace's record.
  let events: IntentEvent[] = [];
  let selection: SelectionContext | undefined;
  // Whether the stream carried its own app selections. The live model sees each
  // one as an injected labeled item (below), so the context preamble stands
  // down on BOTH fin paths: the tool-call body is the model's composition
  // (authoritative — a selection it chose not to reference does not sneak back
  // in) and the step-3 fallback's composeIntent renders every carried selection
  // INLINE. Only the legacy `context` chunk (older clients, no stream events)
  // still lowers through the preamble.
  let chronicleHasSelection = false;
  // Shot metadata kept keyed by label — NEVER sent to the live model; re-attached
  // by resolveSegments at fin (the `<screenshot>` block the agent gets).
  const shotRegistry = new Map<string, LabelEntry>();
  // Selection payloads keyed by marker (`sel_N`/`code_N`) — the live model sees
  // only the clipped injection label; the LATEST payload under a marker is
  // re-attached (full rendering) by resolveSegments at fin. Drops mark entries
  // retracted rather than deleting them, so a referenced-anyway retraction is
  // caught and reported at resolve.
  const selectionRegistry = new Map<string, SelectionEntry>();
  // Pre-marker clients: whether an id-less selection label was injected (its
  // markerless drop then retracts "it" rather than naming a marker).
  let unmarkedSelectionInjected = false;
  // Synthetic, increasing segment ordinals for the model's user-transcript turns
  // (the chronicle needs monotonic segment numbers so the preview fills in order).
  let userSeq = 0;
  // Ambient video: count every frame, persist every 10th as a named artifact.
  let videoCount = 0;
  let videoUnsupportedNoted = false;

  const push = (produced: IntentEvent[]): void => {
    ctx.push?.({
      kind: "lowered",
      threadId: ctx.threadId,
      events: produced,
    } satisfies LoweredMessage);
  };
  const pushSpeech = (id: string, mime: string, bytes: Uint8Array, label?: string): void => {
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
      label: `speech ${id}`,
      data: { mime, bytes: bytes.length, ...(label !== undefined ? { text: label } : {}) },
    });
  };
  const recordCost = (what: string, cost: CallCost | undefined): void => {
    if (!cost) {
      return;
    }
    trace?.record({ kind: "info", label: `cost: ${what}`, data: cost });
    if (cost.usd !== undefined) {
      trace?.addCost(cost.usd);
    }
  };

  // The post-send summarizer (the one-line trace gloss), same posture as the
  // classic path: enabled whenever there's a key or a test seam, best-effort.
  const summarizer: Summarizer | undefined =
    options.summarizer ??
    (keyed
      ? openaiSummarizer({
          apiKey: apiKey as string,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : undefined);
  const summarize = async (body: string): Promise<void> => {
    if (summarizer === undefined || body === "") {
      return;
    }
    try {
      const result = await summarizer.summarize(body);
      trace?.setSummary(result.text);
      if (result.cost?.usd !== undefined) {
        trace?.addCost(result.cost.usd);
      }
    } catch {
      // best-effort: the trace list just shows the timestamp for this turn
    }
  };

  // ── open the live session (or degrade loudly) ────────────────────────────────
  const factory =
    intent.liveVendor === "gemini"
      ? options.geminiLiveSocketFactory
      : options.openaiLiveSocketFactory;
  const liveReady = keyed || factory !== undefined;

  let replySeq = 0;
  const callbacks: LiveSessionCallbacks = {
    onUserTranscript: (text) => {
      // The model's user-transcript for one turn → a synthetic transcript-final,
      // so the client preview fills and the fallback compiler has a document.
      const produced: IntentEvent = {
        at: Date.now(),
        type: "transcript-final",
        segment: userSeq++,
        text,
        latencyMs: 0,
        model: intent.liveModel,
      };
      events.push(produced);
      push([produced]);
    },
    onReplyTranscript: (text) => {
      // What the human was told — a status note (the widget shows it) + the trace;
      // never the IR (the committed prompt is submit_intent / the fallback).
      push([{ at: Date.now(), type: "note", text: `🔊 ${text}` }]);
      trace?.record({ kind: "info", label: "live reply", data: { text } });
    },
    onReplyAudio: (bytes, mime) => {
      pushSpeech(`reply_${replySeq++}`, mime, bytes);
    },
    onInterrupted: () => {
      trace?.record({ kind: "info", label: "live interrupted", data: {} });
    },
    onUsage: (cost) => {
      // A live turn re-bills its context every response — where the money goes.
      recordCost("live response", cost);
    },
    onError: (message) => {
      push([{ at: Date.now(), type: "note", text: `${intent.liveVendor} realtime: ${message}` }]);
      pushError(ctx, {
        source: "voice",
        message: `${intent.liveVendor} realtime: ${message}`,
        detail: keyHint,
      });
    },
    onGoAway: (msLeft) => {
      const text = `live session winding down in ~${Math.round(msLeft / 1000)}s (${intent.liveVendor} GoAway)`;
      push([{ at: Date.now(), type: "note", text }]);
      trace?.record({ kind: "info", label: "live goaway", data: { msLeft } });
    },
  };

  let session: LiveSession | undefined;
  if (liveReady) {
    session =
      intent.liveVendor === "gemini"
        ? openGeminiLiveSession(
            {
              apiKey: apiKey ?? "",
              model: () => intent.liveModel,
              instructions: LIVE_COMPOSER_INSTRUCTIONS,
              ...(options.geminiLiveSocketFactory !== undefined
                ? { socketFactory: options.geminiLiveSocketFactory }
                : {}),
            },
            callbacks,
          )
        : openOpenAiLiveSession(
            {
              apiKey: apiKey ?? "",
              model: () => intent.liveModel,
              instructions: LIVE_COMPOSER_INSTRUCTIONS,
              ...(options.openaiLiveSocketFactory !== undefined
                ? { socketFactory: options.openaiLiveSocketFactory }
                : {}),
            },
            callbacks,
          );
    trace?.record({
      kind: "info",
      label: "live open",
      data: {
        vendor: intent.liveVendor,
        model: intent.liveModel,
        capabilities: session.capabilities,
        // The persona actually sent at open (passed above), so the trace shows
        // the instructions this session ran under — including the commit gate.
        instructions: LIVE_COMPOSER_INSTRUCTIONS,
      },
    });
  } else {
    // Keyless with no test factory: absent + loud (never a silent downgrade to a
    // transcription tier), immediately — the tier promised a live conversation.
    trace?.record({
      kind: "info",
      label: "live open",
      data: { vendor: intent.liveVendor, model: intent.liveModel, ready: false },
    });
    const message = `${intent.liveVendor} realtime is unavailable — the channel process has no ${keyName}.`;
    push([{ at: Date.now(), type: "note", text: message }]);
    pushError(ctx, { source: "voice", message, detail: keyHint });
  }

  // ── selection injection (F2: the moment a selection event arrives) ──────────
  // The counterpart of the labeled-shot injection below: a compact bracketed
  // text item ([selection sel_2: …] — live-resolve owns the grammar) rides the
  // conversation as SILENT context, so the model can ground deictic speech and
  // reference the id in submit_intent; the full rendering is re-attached at
  // resolve. A re-emit under the same marker injects an update; a drop injects
  // an explicit retraction (append-only conversation — nothing can be unseen).
  const injectSelection = (
    marker: string | undefined,
    entry: SelectionEntry,
    updated: boolean,
  ): void => {
    if (session === undefined) {
      return; // keyless: the chronicle/trace still record the event itself
    }
    const text = selectionInjectionLabel(marker, entry, updated);
    session.injectContextText(text);
    if (marker === undefined) {
      unmarkedSelectionInjected = true;
    }
    trace?.record({
      kind: "info",
      label: `live selection ${marker ?? "(unmarked)"}`,
      data: { text },
    });
  };
  const injectRetraction = (marker: string | undefined): void => {
    if (session === undefined) {
      return;
    }
    const text = selectionRetractionLabel(marker);
    session.injectContextText(text);
    trace?.record({
      kind: "info",
      label: `live selection ${marker ?? "(unmarked)"} retracted`,
      data: { text },
    });
  };
  /** The most recent still-carried marker of one kind (for markerless drops). */
  const latestCarriedMarker = (kind: "app" | "code"): string | undefined => {
    let found: string | undefined;
    for (const [marker, entry] of selectionRegistry) {
      if (entry.kind === kind && entry.retracted !== true) {
        found = marker;
      }
    }
    return found;
  };

  // ── routing (chronicle accumulation + live injections) ───────────────────────
  const onEventsChunk = (bytes: Uint8Array): void => {
    for (const event of readEventBatch(decodeJson(bytes))) {
      events.push(event);
      switch (event.type) {
        case "talk-start":
          session?.activityStart();
          break;
        case "talk-end":
          session?.activityEnd();
          break;
        case "shot":
          // Merge the shot's metadata into the registry (the bytes/path arrive on
          // its attachment frame); the model never sees any of it.
          shotRegistry.set(event.marker, {
            ...shotRegistry.get(event.marker),
            components: event.components,
            ...(event.viewport !== undefined ? { viewport: event.viewport } : {}),
          });
          break;
        case "video-share":
          trace?.record({ kind: "info", label: "video-share", data: { on: event.on } });
          break;
        case "app-selection": {
          // First-class in the trace here too — and injected into the live
          // conversation on arrival (a labeled item under its marker; a
          // superseding re-emit under the SAME marker injects an update).
          chronicleHasSelection = true;
          const { at: _at, type: _type, marker, ...data } = event;
          trace?.record({
            kind: "ir",
            label: "app selection",
            data: { ...(marker !== undefined ? { marker } : {}), ...data },
          });
          const entry: SelectionEntry = { kind: "app", item: data };
          const updated = marker !== undefined && selectionRegistry.has(marker);
          if (marker !== undefined) {
            selectionRegistry.set(marker, entry);
          }
          injectSelection(marker, entry, updated);
          break;
        }
        case "app-selection-drop": {
          // Retract exactly one: a marker'd drop only clears its own marker
          // (a markerless drop — pre-marker clients — clears whatever rides).
          // The registry entry stays, marked retracted (a referenced-anyway id
          // is caught at resolve), and the model is told to disregard it.
          trace?.record({
            kind: "ir",
            label: "app selection dropped",
            data: { ...(event.marker !== undefined ? { marker: event.marker } : {}) },
          });
          const marker = event.marker ?? latestCarriedMarker("app");
          const entry = marker !== undefined ? selectionRegistry.get(marker) : undefined;
          if (entry !== undefined && entry.retracted !== true) {
            entry.retracted = true;
            injectRetraction(marker);
          } else if (marker === undefined && unmarkedSelectionInjected) {
            unmarkedSelectionInjected = false;
            injectRetraction(undefined);
          }
          break;
        }
        case "code-selection": {
          const { at: _at, type: _type, marker, ...data } = event;
          trace?.record({
            kind: "ir",
            label: "code selection",
            data: { ...(marker !== undefined ? { marker } : {}), ...data },
          });
          const entry: SelectionEntry = { kind: "code", item: data };
          const updated = marker !== undefined && selectionRegistry.has(marker);
          if (marker !== undefined) {
            selectionRegistry.set(marker, entry);
          }
          injectSelection(marker, entry, updated);
          break;
        }
        case "code-selection-drop": {
          trace?.record({
            kind: "ir",
            label: "code selection dropped",
            data: { marker: event.marker },
          });
          const entry = selectionRegistry.get(event.marker);
          if (entry !== undefined && entry.retracted !== true) {
            entry.retracted = true;
            injectRetraction(event.marker);
          }
          break;
        }
        case "correction": {
          // Corrections are transcription-only; the client gates the UI, so a
          // stray request just gets a patchless echo (the chronicle stays uniform)
          // and a note — never the V4A pipeline.
          const echo: IntentEvent = { ...event, patch: undefined };
          push([
            echo,
            {
              at: Date.now(),
              type: "note",
              text: "corrections are off in realtime mode — talk to adjust instead",
            },
          ]);
          trace?.record({ kind: "info", label: "correction ignored (realtime)", data: {} });
          break;
        }
        default:
          break;
      }
    }
  };

  const onAttachmentChunk = (
    chunk: Extract<ChunkDescriptor, { kind: "attachment" }>,
    bytes: Uint8Array,
  ): void => {
    if (!chunk.id.startsWith("shot_")) {
      return; // realtime streams audio as `audio` chunks; only shots arrive here
    }
    // Save the shot artifact (the path the resolved prompt hands the agent), wire
    // it into the registry, and inject the labeled image into the live session.
    const path = trace?.recordBlob(
      { kind: "ir", label: `attachment ${chunk.id}` },
      bytes,
      `${chunk.id}.png`,
    );
    shotRegistry.set(chunk.id, {
      ...shotRegistry.get(chunk.id),
      ...(path !== undefined ? { path } : {}),
    });
    session?.injectLabeledImage(chunk.id, bytes, chunk.mime);
    trace?.record({
      kind: "info",
      label: `live label ${chunk.id}`,
      data: { mime: chunk.mime, hasPath: path !== undefined },
    });
  };

  const onVideoChunk = (
    chunk: Extract<ChunkDescriptor, { kind: "video" }>,
    bytes: Uint8Array,
  ): void => {
    videoCount += 1;
    // Persist every 10th frame as a named artifact (the decorator already blobs
    // every frame as input-N.bin; this gives the debugger legible video stills).
    if (videoCount % 10 === 1) {
      trace?.recordBlob(
        { kind: "ir", label: `video sample ${chunk.id}` },
        bytes,
        `${chunk.id}_${chunk.seq}.jpg`,
      );
    }
    if (session?.capabilities.video) {
      session.appendVideoFrame(bytes, chunk.mime);
    } else if (session !== undefined && !videoUnsupportedNoted) {
      // The degraded vendor (OpenAI) has no video — say so once, then drop silently.
      videoUnsupportedNoted = true;
      trace?.record({
        kind: "info",
        label: "live video unsupported",
        data: { vendor: intent.liveVendor },
      });
      push([
        {
          at: Date.now(),
          type: "note",
          text: `${intent.liveVendor} realtime has no video — screen frames ignored`,
        },
      ]);
    }
  };

  const onContextChunk = (bytes: Uint8Array): void => {
    selection = asSelection(decodeJson(bytes)) ?? selection;
  };

  // ── the fin ladder (§4.3) ────────────────────────────────────────────────────
  const lower = async (): Promise<void> => {
    trace?.record({ kind: "ir", label: "chronicle", data: events });
    const cancelled = endedInCancel(events);
    if (cancelled || session === undefined) {
      // Cancelled, or keyless (already toasted at open): lower to nothing.
      session?.close();
      ctx.close();
      return;
    }

    // The commit gate: inject the sentinel — per the instructions, the ONLY
    // message that authorizes submit_intent — then await the model's call.
    session.nudgeSubmit();
    trace?.record({ kind: "info", label: "live nudge", data: { text: LIVE_NUDGE_TEXT } });
    const call = await session.drainToolCall(LIVE_DRAIN_TIMEOUT_MS);

    let body: string;
    if (call !== null && call.segments.length > 0) {
      trace?.record({ kind: "ir", label: "live tool call", data: { segments: call.segments } });
      const resolved = resolveSegments(call.segments, shotRegistry, {
        ...composeOptions,
        selections: selectionRegistry,
      });
      body = resolved.body;
      call.respond(true);
      if (resolved.missingRefs.length > 0) {
        trace?.record({
          kind: "info",
          label: "live refs unresolved",
          data: { missing: resolved.missingRefs },
        });
      }
      // One ref row per marker — shots AND selections (the viewer counts
      // resolved via `resolved === true || path`): a resolved shot carries the
      // path it re-attached; a retracted selection the model referenced anyway
      // is marked so "did my retraction hold?" reads off this row.
      const refs = [
        ...resolved.resolvedMarkers.map((marker) => {
          const path = shotRegistry.get(marker)?.path;
          return { marker, resolved: true, ...(path !== undefined ? { path } : {}) };
        }),
        ...resolved.missingRefs.map((marker) => ({
          marker,
          resolved: false,
          ...(selectionRegistry.get(marker)?.retracted === true ? { retracted: true } : {}),
        })),
      ];
      trace?.record({ kind: "ir", label: "live resolved", data: { body, refs } });
    } else {
      // Step 3: the model didn't compose — fall back to composeIntent over the
      // chronicle (the transcription compiler on the transcripts we kept). Loud.
      const composed = composeIntent(events, intent.correctionPolicy, composeOptions);
      body = composed.prompt;
      const reason =
        call === null ? "no submit_intent before send" : "submit_intent had no segments";
      trace?.record({ kind: "info", label: "live fallback", data: { fallback: true, reason } });
      pushError(ctx, {
        source: "voice",
        message: `the live model didn't compose a prompt (${reason}) — composed one from the transcript instead`,
        detail: keyHint,
      });
    }

    if (body !== "") {
      // Stream selections never ride the preamble: the model saw each one as
      // an injected labeled item, so on the tool-call path its composition is
      // authoritative (a selection it chose not to reference stays out), and
      // the fallback's composeIntent renders every carried selection INLINE.
      // Only the legacy `context` chunk (older clients, no stream events)
      // still lowers through the preamble — on both paths.
      const preambleSelection = chronicleHasSelection ? undefined : selection;
      const prompt = wrapWithContext(
        [...staticSections, ...selectionSections(preambleSelection)],
        body,
      );
      ctx.push?.({
        kind: "lowered-prompt",
        threadId: ctx.threadId,
        prompt,
      } satisfies LoweredPromptMessage);
      await ctx.sendPrompt(prompt);
      // Gloss the turn for the trace list — detached; the fin ack never waits on it.
      void summarize(body);
    }
    session.close();
    ctx.close();
  };

  return {
    async onMessage(payload: unknown, meta: MessageMeta) {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(0);
      const chunk = meta.chunk;
      if (chunk?.kind === "events") {
        onEventsChunk(bytes);
      } else if (chunk?.kind === "attachment") {
        onAttachmentChunk(chunk, bytes);
      } else if (chunk?.kind === "audio") {
        session?.appendAudio(bytes);
      } else if (chunk?.kind === "video") {
        onVideoChunk(chunk, bytes);
      } else if (chunk?.kind === "context") {
        onContextChunk(bytes);
      }
      if (meta.fin) {
        await lower();
      }
    },
    onClose() {
      // Abandoned turn (socket dropped before fin): drop the chronicle and close
      // the upstream live session so its WebSocket is not leaked (the S2 teardown).
      events = [];
      shotRegistry.clear();
      selectionRegistry.clear();
      session?.close();
    },
  };
}

/** The built-in `intent-v1` format (real env-keyed seams). */
export const intentV1Format: ChannelFormat = createIntentV1Format();
