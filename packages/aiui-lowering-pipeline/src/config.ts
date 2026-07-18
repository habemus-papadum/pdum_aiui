/**
 * The intent pipeline's configuration — one object, deliberately wider than any
 * UI. It began, in the retired workbench lab, as a settings drawer (every contested
 * interaction-design choice as a knob, argued by toggling) and graduates here
 * as a **superset**: the same visible toggles, plus research knobs that ship
 * without UI so they can be measured before they are designed for.
 *
 * Plumbing (not here): the **client-side** knobs ride the intent client's
 * config; the **server-side** knobs (real transcription/correction models,
 * silence gating, priming) live in the channel's config; the hello frame
 * carries the client's view so a trace records the whole configuration. A
 * debug harness can expose everything by default via its settings drawer + a
 * raw-JSON advanced panel; the shipping intent client exposes a curated few.
 * Same type throughout.
 *
 * Framework-free, browser-safe, no deps — like everything in this folder.
 */
import type { VideoCaptureMode } from "./types";

export interface IntentPipelineConfig {
  // ── the tier dial (the cost-sized preset over the fine fields below) ────────
  /**
   * Cost-sized preset that expands into the fine fields; explicit fine fields
   * win. Transcription is STREAMING-ONLY now (the append-only pivot): two
   * surfaced rungs — `rapid` (streaming `gpt-realtime-whisper`, the default)
   * and `premium` (the higher-quality `gpt-4o-mini-transcribe` over the same
   * streaming endpoint, plus spoken TTS acks). `mock` survives for tests and
   * offline development but is NOT surfaced in the strip. Legacy tier names
   * (`standard`, `flagship`, `live-gemini`, `live-openai`) still expand via
   * {@link expandTier}'s alias table so persisted configs and old hellos keep
   * resolving. Prompt LINTING is orthogonal to the tier — see {@link linter}.
   */
  tier?: "mock" | "rapid" | "premium";

  // ── the visible toggles ────────────────────────────────────────────────────
  /**
   * LEGACY (retired knob): Space is always hold-to-talk; H is the hands-free
   * toggle. Tolerated so persisted configs and old hellos stay valid; nothing
   * reads it.
   */
  talkMode?: "hold" | "toggle";
  /**
   * Seconds until an ink stroke fades away. **0 (the default) is PERMANENT
   * ink**: strokes persist until you clear them with C, across sends, across
   * abandoned turns — the pen is not scoped to a turn, the page is a
   * whiteboard you happen to be talking over. Any positive value makes it
   * *vanishing* ink.
   */
  inkFadeSec: number;
  /** Auto-end the thread after this many silent/idle seconds; 0 = explicit Enter only. */
  autoEndSec: number;
  /**
   * Which transcriber runs. `elevenlabs` (Scribe v2, the default when keyed)
   * and `openai-realtime` are the **streaming** engines: the client streams
   * PCM to a per-thread channel-held session and partial deltas fill the
   * preview as you speak (archive/streaming-turns.md §3). `openai` is the
   * channel-side REST transcriber (one round-trip per segment). `mock` is the
   * explicit offline/developer choice: local, no key, no network, canned
   * output. `openai-voice` is LEGACY — the retired flagship voice veneer; the
   * channel coerces it to `openai-realtime` + an openai linter at hello time.
   */
  transcriber: "mock" | "openai" | "openai-realtime" | "openai-voice" | "elevenlabs";
  /** OpenAI transcription model (when transcriber = openai). */
  model: string;
  /**
   * Domain vocabulary the transcriber is biased toward — product names,
   * acronyms, code identifiers. A SLOT today (nothing in the UI writes it):
   * wired to ElevenLabs `keyterms` and the request-response engine's prompt
   * ("Keywords: …"); `gpt-realtime-whisper` does not support prompting, so
   * the field is documented-inert there. See docs/guide/transcription.md.
   */
  keywords?: string[];
  /**
   * Realtime transcription model (when transcriber = openai-realtime). Absent →
   * the channel default (`gpt-realtime-whisper`).
   */
  realtimeModel?: string;
  /**
   * Realtime latency/accuracy trade-off (when transcriber = openai-realtime):
   * lower = faster/less accurate. Absent → the model's own default.
   */
  realtimeDelay?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Mock: per-word cadence in ms. */
  mockWordMs: number;
  /** Mock: probability [0..1] a word is mangled — fuel for correction mode. */
  mockTypoRate: number;

  // ── audio-back: spoken audio to the human (premium) ─────────────────────────
  /**
   * Spoken audio back to the human. `off` = silent; `acks` = short TTS
   * confirmations the channel synthesizes on lowering milestones (premium —
   * e.g. a spoken "sent"). `voice` is LEGACY — the retired flagship voice
   * veneer; accepted from old hellos, treated as `off`. Absent → `off`.
   */
  audioBack?: "off" | "acks" | "voice";
  /** REST TTS model for `audioBack:"acks"`. Absent → gpt-4o-mini-tts. */
  ttsModel?: string;
  /** TTS voice id (acks). Absent → the model default. */
  ttsVoice?: string;
  /** The linter's spoken voice id. Absent → the model default (e.g. cedar/marin). */
  realtimeVoice?: string;

  // ── arming (decision #5: a host-app opt-out / rebind, cheap insurance) ──────
  /**
   * The arming gesture. `key` is the arm/disarm key (backtick by default —
   * collides less than feared, see field-notes); `enabled: false` lets a host
   * app turn keyboard arming off entirely when the default gesture is wrong for
   * its surface.
   */
  arming?: { key?: string; enabled?: boolean };

  // ── research knobs (shipped without UI; measured in the lab) ────────────────
  /**
   * Silence gating before a segment is sent to transcription
   * (archive/workbench/openai-audio-stack.md):
   * trim dead air / suppress empty segments. Off by default.
   */
  silenceGate?: { enabled: boolean; thresholdDb?: number; minSilenceMs?: number };
  /**
   * Keyword-priming sources — page text, component names, etc. — fed to the
   * transcriber as a bias prompt. Toggled per source; none by default.
   */
  priming?: { sources?: string[] };
  // ── the prompt linter (archive/realtime_prompt_linter_design.md) ────────────
  /**
   * The realtime **prompt linter** — on/off plus a vendor, orthogonal to the
   * tier. While on, the channel holds a live conversational session (Gemini
   * Live / GPT realtime) alongside transcription: the model hears the mic,
   * sees labeled shots, selections, and (while sharing) screen frames, and at
   * each talk-window end speaks one short observation — a probable
   * mistranscription, an ambiguous reference, a missing screenshot. It NEVER
   * composes the prompt; the compiler does, in every configuration. Absent →
   * `off`.
   */
  linter?: "off" | "openai" | "gemini";
  /** Linter model id. Absent → the vendor default (gpt-realtime-2 / Gemini Live). */
  linterModel?: string;
  /** The linter persona override. Absent → the channel's LINTER_INSTRUCTIONS. */
  linterInstructions?: string;
  /**
   * Screen-frame cadence while sharing, in ms per frame. Absent → 5000 (one
   * frame every five seconds); the share's slider adjusts it live. Under
   * `videoMode: "smart"` this is a CEILING, not a metronome.
   */
  videoFrameIntervalMs?: number;
  /**
   * How the share decides when to sample. Absent → `"smart"`: a frame goes out
   * only if the human touched the page since the last one. `"continuous"` fires
   * on every cadence tick. See {@link VideoCaptureMode}.
   */
  videoMode?: VideoCaptureMode;

  // ── legacy realtime-submode fields (pre-linter wire compat) ─────────────────
  /**
   * LEGACY (the composer era): `realtime` selected the channel's
   * model-composes processor. Kept so old hellos/persisted configs resolve;
   * nothing surfaced sets it anymore — the linter fields above replace it.
   */
  submode?: "transcription" | "realtime";
  /** LEGACY — the composer-era engine pick; superseded by {@link linter}. */
  liveVendor?: "gemini" | "openai";
  /** LEGACY — the composer-era model id; superseded by {@link linterModel}. */
  liveModel?: string;
}

/**
 * The shipped defaults. Transcription and correction default to the **real**
 * `openai` backends (channel-side), so an intent client launched through
 * `aiui claude` works against the channel out of the box. `mock` is never a
 * default here — it is the explicit offline choice a developer opts into (an
 * offline harness overrides these two back to `mock` so it runs with no
 * channel and no key). The `mock*` cadence/typo knobs below only matter once
 * `transcriber: "mock"`.
 */
export const DEFAULT_INTENT_CONFIG: IntentPipelineConfig = {
  // Permanent. Ink is a drawing on the page, not a property of the turn that
  // happened to be open when you drew it — so it outlives sends and abandoned
  // turns, and only C erases it. `inkFadeSec > 0` opts into vanishing ink.
  inkFadeSec: 0,
  autoEndSec: 0,
  // Scribe v2 is the default WHEN AVAILABLE — word timestamps + logprobs
  // make it the richest engine. The channel falls back to Realtime Whisper
  // (with a visible note) when it has no ELEVEN_LABS_API_KEY, so a
  // keyless-for-ElevenLabs setup still dictates out of the box.
  transcriber: "elevenlabs",
  model: "gpt-4o-mini-transcribe",
  realtimeModel: "gpt-realtime-whisper",
  // The delay dial trades latency for accuracy; the accumulator preview
  // absorbs slow finals gracefully (deltas keep it live), so default to the
  // accuracy end. See docs/guide/transcription.md.
  realtimeDelay: "xhigh",
  mockWordMs: 140,
  mockTypoRate: 0.07,
  audioBack: "off",
  linter: "off",
  videoFrameIntervalMs: 5000,
  // Sitting still and narrating should not spend money on identical frames.
  videoMode: "smart",
  arming: { key: "`", enabled: true },
};

// ── the tier presets (the cost-sized dial → fine fields) ─────────────────────

/** The tier values (`mock` unsurfaced — tests/offline only). */
export type IntentTier = NonNullable<IntentPipelineConfig["tier"]>;

/**
 * Each tier as a `Partial<IntentPipelineConfig>` of the fine fields it sets. A
 * blank (absent key) means "not set by this preset" — it inherits
 * {@link DEFAULT_INTENT_CONFIG}. Explicit fine fields (Vite `intent` ∪
 * panel/agent overrides) still win over these — see {@link expandTier} and
 * `effectiveConfig`.
 *
 * Transcription is streaming-only; the rungs differ by MODEL:
 *  - `mock`    — offline dev: mock STT, $0 (tests; not in the strip).
 *  - `rapid`   — streaming `gpt-realtime-whisper`: fastest finals. The default.
 *  - `premium` — streaming `gpt-4o-mini-transcribe` (higher quality over the
 *    same realtime endpoint) + spoken TTS acks (gpt-4o-mini-tts).
 */
export const TIER_PRESETS: Record<IntentTier, Partial<IntentPipelineConfig>> = {
  mock: {
    transcriber: "mock",
    audioBack: "off",
  },
  // The legacy tiers no longer pin a transcriber (the ENGINE picker owns
  // that choice now; the default rides DEFAULT_INTENT_CONFIG) — a tier is
  // just its audio-back posture.
  rapid: {
    audioBack: "off",
  },
  premium: {
    transcriber: "openai-realtime",
    realtimeModel: "gpt-4o-mini-transcribe",
    audioBack: "acks",
    ttsModel: "gpt-4o-mini-tts",
  },
};

/**
 * The retired tier names, expanded EXACTLY as their presets read before the
 * linter pivot — persisted configs and old hellos keep resolving to the
 * behavior they meant. (These collapse onto the new world as the channel
 * retires the composer/voice paths; until then, byte-identical is the safest
 * translation.)
 */
const LEGACY_TIER_EXPANSIONS: Record<string, Partial<IntentPipelineConfig>> = {
  standard: {
    transcriber: "openai",
    model: "gpt-4o-mini-transcribe",
    audioBack: "off",
  },
  flagship: {
    transcriber: "openai-voice",
    audioBack: "voice",
    realtimeVoice: "cedar",
  },
  "live-gemini": {
    submode: "realtime",
    liveVendor: "gemini",
    liveModel: "gemini-3.1-flash-live-preview",
    audioBack: "voice",
  },
  "live-openai": {
    submode: "realtime",
    liveVendor: "openai",
    liveModel: "gpt-realtime-2",
    audioBack: "voice",
  },
};

/** The default tier when none is set: `rapid` (streaming whisper, no voice back). */
const DEFAULT_TIER: IntentTier = DEFAULT_INTENT_CONFIG.tier ?? "rapid";

/**
 * Expand a `tier` into the fine fields it sets, layered over the defaults:
 * `{ ...DEFAULT, ...preset }`. Explicit fine fields are layered on top of
 * this by the caller (`effectiveConfig` / the channel's `resolveIntent`), so
 * this is only the "defaults ← preset" part. Legacy tier names expand via
 * {@link LEGACY_TIER_EXPANSIONS}; an unknown tier expands to the bare
 * defaults. Shared by both sides (client + channel) so there is one source
 * of truth for what a tier means.
 */
export function expandTier(tier: string | undefined): IntentPipelineConfig {
  const name = tier ?? DEFAULT_TIER;
  const preset = TIER_PRESETS[name as IntentTier] ?? LEGACY_TIER_EXPANSIONS[name] ?? {};
  return { ...DEFAULT_INTENT_CONFIG, ...preset };
}
