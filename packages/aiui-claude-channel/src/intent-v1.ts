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
 * A thread that ends in `cancel` (or never fins) lowers to nothing. (The
 * corrector round-trip — patchless `correction` requests answered with V4A
 * diffs — was retired with correct mode in the append-only pivot; legacy
 * correction events in old traces still fold at compose time.)
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
import type { CallCost } from "./cost";
import { ELEVENLABS_COMMIT_FLOOR_MS, openElevenLabsRealtimeSession } from "./elevenlabs-realtime";
import type { ChunkDescriptor } from "./frame";
import { DEFAULT_GEMINI_LIVE_MODEL } from "./gemini-live";
import { createLinterSidecar, type LinterSidecar } from "./linter-sidecar";
import type { SelectionEntry } from "./live-resolve";
import type { LiveSession, LiveSessionCallbacks } from "./live-session";
import { DEFAULT_OPENAI_LIVE_MODEL } from "./openai-live";
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
  type RealtimeCallbacks,
  type RealtimeSession,
  type RealtimeSocketFactory,
} from "./realtime";

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
 * its own stream (transcripts it did not compute).
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
 * client (a debug viewer, a widget's "what did I just send?" affordance) can
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
 * The realtime submode's stale-key hint, the Gemini twin of {@link OPENAI_KEY_HINT}.
 * The single most common cause of "the live tier stopped working" is a missing or
 * revoked GEMINI_API_KEY in the channel process's environment — a condition only
 * the server can see, so the server names it.
 */
const ELEVENLABS_KEY_HINT =
  "If this keeps happening, check the ELEVEN_LABS_API_KEY in the environment the channel " +
  "process was launched from (a missing/stale key fails every Scribe call) — fix it and " +
  "relaunch `aiui claude`, or pick another transcriber (K, then a digit).";

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
  transcriber: "mock" | "openai" | "openai-realtime" | "openai-voice" | "elevenlabs";
  model: string;
  /** Domain-vocabulary bias (the keywords slot — see docs/guide/transcription.md). */
  keywords: string[] | undefined;
  /** Realtime transcription model (when transcriber = `openai-realtime`). */
  realtimeModel: string;
  /** Realtime latency/accuracy knob (`minimal`…`xhigh`); undefined → model default. */
  realtimeDelay: string | undefined;
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
  /** The prompt linter: off, or which live vendor observes the composition. */
  linter: "off" | "openai" | "gemini";
  /** Linter model id; undefined → the vendor default. */
  linterModel: string | undefined;
  /** Linter persona override; undefined → LINTER_INSTRUCTIONS. */
  linterInstructions: string | undefined;
  /** Ambient screen-frame cadence while sharing (ms per frame). */
  videoFrameIntervalMs: number;
  /** Legacy translations applied while resolving (each one human-readable). */
  coerced: string[];
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
   * Test seam override — used whenever the hello selects `transcriber: openai`,
   * in place of the real REST transcriber.
   */
  transcriber?: Transcriber;
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
 * Read the fields the lowering uses off the loosely-typed hello `intent`, with
 * defaults. The client sends the fully-expanded effective config, so the fine
 * fields are already concrete; but as a **defensive fallback** for a hello that
 * carries only `tier` (or a sparse partial), each field's default is the tier's
 * preset value — the shared `expandTier` from the pipeline package, so both sides
 * agree on what a tier means (model-tiers.md, "Channel side"). Absent tier →
 * `standard` (the quiet REST legacy — a sparse hello without a key must not
 * degrade loudly; the REST retirement will flip this to `rapid`); legacy
 * names (standard, flagship, live-*) expand via the shared alias table.
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
  const resolved: ResolvedIntent = {
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
      ["mock", "openai", "openai-realtime", "openai-voice", "elevenlabs"] as const,
      preset.transcriber,
    ),
    keywords:
      Array.isArray(cfg.keywords) && cfg.keywords.every((k) => typeof k === "string")
        ? (cfg.keywords as string[])
        : undefined,
    model: str(cfg.model, preset.model),
    realtimeModel: str(cfg.realtimeModel, preset.realtimeModel ?? DEFAULT_REALTIME_MODEL),
    realtimeDelay: optStr(cfg.realtimeDelay ?? preset.realtimeDelay),
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
    linter: oneOf(cfg.linter, ["off", "openai", "gemini"] as const, preset.linter ?? "off"),
    linterModel: optStr(cfg.linterModel ?? preset.linterModel),
    linterInstructions: optStr(cfg.linterInstructions ?? preset.linterInstructions),
    videoFrameIntervalMs:
      typeof cfg.videoFrameIntervalMs === "number" && cfg.videoFrameIntervalMs > 0
        ? cfg.videoFrameIntervalMs
        : (preset.videoFrameIntervalMs ?? 5000),
    coerced: [],
  };
  // ── legacy coercions (the linter pivot) — every translation is recorded ──
  // and lands on the `intent config` trace stage, so a hello that meant the
  // old world shows exactly how it was read into the new one.
  if (resolved.transcriber === "openai-voice") {
    // The flagship voice veneer is retired: transcription is streaming STT,
    // and the spoken companion is the LINTER (which keeps the chosen voice).
    resolved.transcriber = "openai-realtime";
    if (resolved.linter === "off") {
      resolved.linter = "openai";
    }
    resolved.coerced.push(
      "transcriber openai-voice → openai-realtime + linter openai (voice veneer retired)",
    );
  }
  if (resolved.submode === "realtime") {
    // The composer submode is retired: the compiler composes everywhere; the
    // live vendor the hello picked becomes the prompt LINTER, keeping the
    // model they chose.
    if (resolved.linter === "off") {
      resolved.linter = resolved.liveVendor;
    }
    if (resolved.linterModel === undefined) {
      resolved.linterModel = resolved.liveModel;
    }
    resolved.submode = "transcription";
    resolved.coerced.push(
      `submode realtime → linter ${resolved.linter} (the model-composes path retired; the compiler composes everywhere)`,
    );
  }
  return resolved;
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

/** A shot blob's file extension from its declared mime: S-key shots are PNG,
 * the share's sampled frames are JPEG. Default PNG for anything unexpected. */
function imageExtension(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : "png";
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
  const geminiApiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY;
  const trace = traceOf(ctx);
  // The base every prompt path (screenshots AND source locations) relativizes
  // against — the agent's working directory. Defaults to this process's cwd
  // (right for `aiui claude`, whose channel runs in the project); a supervisor
  // whose cwd is elsewhere overrides via AIUI_PROMPT_CWD (a supervisor that
  // spawns its channel in a subdirectory but wants repo-root-relative paths).
  const promptCwd = process.env.AIUI_PROMPT_CWD || process.cwd();
  const composeOptions = { cwd: promptCwd, shotFormat: intent.shotFormat };

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
    label: "intent config",
    data: {
      tier: intent.tier,
      transcriber: intent.transcriber,
      model: intent.model,
      realtimeModel: intent.realtimeModel,
      realtimeDelay: intent.realtimeDelay,
      passes: intent.passes,
      audioBack: intent.audioBack,
      ttsModel: intent.ttsModel,
      realtimeVoiceModel: intent.realtimeVoiceModel,
      realtimeVoice: intent.realtimeVoice,
      realtimeTools: intent.realtimeTools,
      linter: intent.linter,
      linterModel: intent.linterModel,
      transcriberReady: transcriber !== undefined,
      realtimeReady,
      speakerReady: speaker !== undefined,
      summarizerReady: summarizer !== undefined,
      ...(intent.coerced.length > 0 ? { coerced: intent.coerced } : {}),
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
    lastComposed = composeIntent(events, "replace", composeOptions);
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

  // ── the prompt-linter sidecar (linter != "off") ──────────────────────────────
  // Purely advisory: it observes the same turn through a live session in
  // linter mode and speaks one short diagnostic per pause. Keyless → disabled
  // LOUDLY, once, and dictation still works (the promise in the error text).
  let sidecar: LinterSidecar | undefined;
  if (intent.linter !== "off") {
    const vendor = intent.linter;
    const linterKey = vendor === "gemini" ? geminiApiKey : apiKey;
    const linterSocketFactory =
      vendor === "gemini" ? options.geminiLiveSocketFactory : options.openaiLiveSocketFactory;
    if (
      (linterKey !== undefined && linterKey !== "") ||
      linterSocketFactory !== undefined ||
      options.linterSessionFactory !== undefined
    ) {
      sidecar = createLinterSidecar({
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
      trace?.record({ kind: "info", label: "linter disabled", data: { vendor, reason: "no key" } });
    }
  }

  // ── realtime (streaming) transcription session ───────────────────────────────
  // Opened here, at processor construction (≈ thread-open), so the handshake +
  // session.update overlap the arm→talk gap. Deltas echo the preview as you
  // speak; the completed transcript is merged into the stream exactly like the
  // REST path's `transcript-final`. Keyless/error take the same loud
  // finalizeSilentSegment posture — never a silent drop, never a silent switch.
  if (realtimeReady) {
    // Both streaming engines implement the same RealtimeSession seam and share
    // this ONE callbacks wiring — the vendor difference is confined to the open.
    const sttCallbacks: RealtimeCallbacks = {
      onDelta: (segment, text) => {
        push([{ at: Date.now(), type: "transcript-delta", segment, text }]);
        // The vendor's running text for the still-uncommitted segment, recorded
        // verbatim. Every engine behind this seam re-sends the CUMULATIVE text
        // (RealtimeCallbacks.onDelta's contract), so a partial that gets SHORTER
        // is the vendor revising itself — not a dropped frame and not something
        // this side patched. Without these stages that distinction is
        // unfalsifiable after the fact, since deltas are pushed and discarded.
        // Recorded only; the fold still composes from `transcript-final` alone.
        trace?.record({
          kind: "ir",
          label: `stt partial seg_${segment}`,
          data: { chars: text.length, text },
        });
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
          // Word timestamps + logprobs (Scribe v2 today): the compiler's
          // exact media anchor and the preview's confidence heat map.
          ...(result.words !== undefined && result.words.length > 0 ? { words: result.words } : {}),
        };
        appendEvent(produced);
        push([produced]);
        sidecar?.onTranscriptFinal(segment, result.text);
        // A glanceable per-final stage: "did words/logprobs/timestamps come
        // back?" must be answerable from the card list, not by digging the
        // merged-events JSON (the debugging lesson of the heat-map chase).
        const logprobs = (result.words ?? [])
          .map((w) => w.logprob)
          .filter((v): v is number => v !== undefined);
        trace?.record({
          kind: "info",
          label: `stt final seg_${segment}`,
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
        recomposeIfStale();
      },
      onError: (message, segment) => {
        const hint = intent.transcriber === "elevenlabs" ? ELEVENLABS_KEY_HINT : OPENAI_KEY_HINT;
        if (segment !== undefined) {
          finalizeSilentSegment(`seg_${segment}`, `realtime transcription failed: ${message}`, {
            source: "transcription",
            detail: hint,
          });
        } else {
          // Session-wide fault before any commit (a refused upstream
          // handshake is where a bad key shows up on this path).
          push([{ at: Date.now(), type: "note", text: `realtime transcription: ${message}` }]);
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
        trace?.record({
          kind: "info",
          label:
            event.kind === "vendor-commit"
              ? `stt vendor commit seg_${event.segment}`
              : `stt ${event.kind}`,
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
    realtime =
      intent.transcriber === "elevenlabs"
        ? openElevenLabsRealtimeSession(
            {
              apiKey: elevenLabsKey ?? "",
              ...(intent.keywords !== undefined ? { keyterms: () => intent.keywords } : {}),
              ...(options.elevenLabsSocketFactory !== undefined
                ? { socketFactory: options.elevenLabsSocketFactory }
                : {}),
            },
            sttCallbacks,
          )
        : openRealtimeSession(
            {
              apiKey: apiKey ?? "",
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
    const session = realtime;
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
      appendEvent(empty);
      push([empty]);
      trace?.record({
        kind: "info",
        label: `realtime discard seg_${segment}`,
        data: {
          bytes: pcmBytes,
          ms: Math.round(pcmBytes / REALTIME_PCM_BYTES_PER_MS),
          note: `under the ${commitFloorMs} ms upstream commit minimum — not transcribed`,
        },
      });
      return;
    }
    if (realtime !== undefined) {
      realtime.commit(segment);
    } else if (realtimeEnabled) {
      // Keyless realtime: no session to commit into. Same loud note as REST
      // keyless — the preview resolves and the widget can say why.
      finalizeSilentSegment(
        `seg_${segment}`,
        "server-side realtime transcription is unavailable — " +
          "the channel process has no OPENAI_API_KEY. " +
          'Set it and relaunch `aiui claude`, or use transcriber:"mock" for offline work.',
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
    realtime?.appendAudio(segment, copy);
    sidecar?.onAudioFrame(copy);
  };

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
        // The stream carries its own selections now: they render INLINE in
        // the body (composeIntent), so the legacy context-chunk preamble
        // must stand down for this turn or the selection would ride twice.
        streamHasSelection = true;
        const { at: _at, type: _type, marker, ...data } = event;
        trace?.record({ kind: "ir", label: "app selection", data: { ...data, marker } });
        const entry: SelectionEntry = { kind: "app", item: data };
        const updated = marker !== undefined && selectionRegistry.has(marker);
        if (marker !== undefined) {
          selectionRegistry.set(marker, entry);
        }
        sidecar?.onSelection(marker, entry, updated);
      } else if (event.type === "code-selection") {
        const { at: _at, type: _type, marker, ...data } = event;
        trace?.record({ kind: "ir", label: "code selection", data: { ...data, marker } });
        const entry: SelectionEntry = { kind: "code", item: data };
        const updated = marker !== undefined && selectionRegistry.has(marker);
        if (marker !== undefined) {
          selectionRegistry.set(marker, entry);
        }
        sidecar?.onSelection(marker, entry, updated);
      } else if (event.type === "app-selection-drop") {
        trace?.record({
          kind: "ir",
          label: "app selection dropped",
          data: { ...(event.marker !== undefined ? { marker: event.marker } : {}) },
        });
        sidecar?.onSelectionDrop(event.marker);
      } else if (event.type === "code-selection-drop") {
        trace?.record({
          kind: "ir",
          label: "code selection dropped",
          data: { marker: event.marker },
        });
        sidecar?.onSelectionDrop(event.marker);
      }
      // talk-end is the segment-commit boundary for the streaming transcriber
      // (PTT stays the contract — no `last` flag on the audio frames). The
      // client flushes talk-end immediately past its 60 ms debounce so the
      // upstream buffer commits promptly.
      if (realtimeEnabled && event.type === "talk-end") {
        commitRealtimeSegment(event.segment);
      }
      // The linter observes the same boundaries (and a client-produced final —
      // the mock transcriber — feeds its transcript wait like a server one).
      if (event.type === "talk-start") {
        sidecar?.onTalkStart(event.segment);
      } else if (event.type === "talk-end") {
        sidecar?.onTalkEnd(event.segment);
      } else if (event.type === "transcript-final" && !event.correction) {
        sidecar?.onTranscriptFinal(event.segment, event.text);
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
          const message = error instanceof Error ? error.message : String(error);
          // A too-short segment (an accidental tap — OpenAI: "Audio file is
          // too short. Minimum audio length is 0.1 seconds.") is not a fault
          // worth a toast: resolve it as an empty final QUIETLY (trace only),
          // exactly like the streaming engines' commit-floor discard.
          if (/too short|minimum audio/i.test(message)) {
            const empty: IntentEvent = {
              at: Date.now(),
              type: "transcript-final",
              segment: ordinalOf(id),
              text: "",
              latencyMs: 0,
              model: intent.model,
            };
            appendEvent(empty);
            push([empty]);
            trace?.record({
              kind: "info",
              label: `transcription discard ${id}`,
              data: { message, note: "segment under the vendor minimum — not an error" },
            });
            return;
          }
          // A live transcription failure (an invalid key, a REST error): don't
          // reject the frame into silence — echo a note the widget surfaces,
          // and an error push naming the likeliest fix (the stale-key hint).
          // Also record it in the trace: the toast is ephemeral, and a trace
          // whose transcript is silently empty is undebuggable after the fact.
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
        `${id}.${imageExtension(mime)}`,
      );
      if (path !== undefined) {
        shotPaths.set(id, path);
        applyShotPaths();
        // Refresh the LIVE fold too (2026-07-12): the shot's event usually
        // outruns its bytes, so the fold that introduced `{shot_N}` rendered
        // before this blob existed — the trace hero showed "(image not
        // captured)" until the NEXT fold picked the path up (off by one shot,
        // observed live). fin was always correct (the wiring bumps the
        // mutation seq); this makes the preview correct as well.
        recomposeIfStale();
      }
      sidecar?.onShot(id, conditioned.bytes, mime);
    }
    // Any other attachment id has no place in the compose and no blob to save.
  };

  /**
   * One sampled screen frame riding a `video` chunk — the pre-frames-are-shots
   * wire shape, kept for compatibility with older overlays. The current
   * overlay uploads each sampled frame as a `shot_N` ATTACHMENT instead (so it
   * composes into the prompt and reaches the linter labeled, like any other
   * shot); a client still streaming `video` chunks gets the old behavior:
   * every frame persists to the trace, and the linter sees it as ambient,
   * unlabeled sight.
   */
  const onVideoChunk = (
    chunk: Extract<ChunkDescriptor, { kind: "video" }>,
    bytes: Uint8Array,
  ): void => {
    trace?.recordBlob(
      { kind: "ir", label: `video ${chunk.id} #${chunk.seq}` },
      bytes,
      `${chunk.id}_${chunk.seq}.jpg`,
    );
    sidecar?.onVideoFrame(bytes, chunk.mime);
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
    const streamSession = realtime;
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
      composed = composeIntent(events, "replace", composeOptions);
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
    sidecar?.close();
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
      sidecar?.close();
    },
  };
}

export const intentV1Format: ChannelFormat = createIntentV1Format();
