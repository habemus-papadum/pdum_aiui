/**
 * The intent pipeline's configuration — one object, deliberately wider than any
 * UI. It began, in the retired workbench lab, as a settings drawer (every contested
 * interaction-design choice as a knob, argued by toggling) and graduates here
 * as a **superset**: the same visible toggles, plus research knobs that ship
 * without UI so they can be measured before they are designed for.
 *
 * Plumbing (implemented in P2/P3, not here): the **client-side** knobs ride the
 * modality options (`aiuiDevOverlay({ intent: {...} })` → widget); the
 * **server-side** knobs (real transcription/correction models, silence gating,
 * priming) live in the channel's config; the hello frame carries the client's
 * view so a trace records the whole configuration. A debug harness can expose
 * everything by default via its settings drawer + a raw-JSON advanced panel;
 * the shipping overlay exposes a curated few. Same type throughout.
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
  /** Space bar behavior: hold-to-talk (walkie-talkie) or press-to-toggle. */
  talkMode: "hold" | "toggle";
  /**
   * Seconds until an ink stroke fades away. **0 (the default) is PERMANENT
   * ink**: strokes persist until you clear them with C, across sends, across
   * abandoned turns — the pen is not scoped to a turn, the page is a
   * whiteboard you happen to be talking over.
   *
   * Any value in [{@link INK_FADE_MIN_SEC}, {@link INK_FADE_MAX_SEC}] makes it
   * *vanishing* ink. The HUD's ✒️/💨 chip flips between the two and its slider
   * sets this (see the modality's HUD); {@link INK_FADE_DEFAULT_SEC} is what
   * the chip picks when it turns fading on.
   */
  inkFadeSec: number;
  /** Auto-end the thread after this many silent/idle seconds; 0 = explicit Enter only. */
  autoEndSec: number;
  /**
   * Which transcriber runs. Defaults to `openai` — the real, channel-side REST
   * transcriber (the key lives in the channel process, not the page).
   * `openai-realtime` is the experimental **streaming** transcriber: the client
   * streams PCM to a per-thread channel-held realtime session and partial deltas
   * fill the preview *as you speak* (streaming-turns.md §3). `openai-voice` is
   * the **conversational** flagship session: the same PCM streaming, but the
   * channel holds a `gpt-realtime-2` voice model that answers aloud and can be
   * interrupted (model-tiers.md; its input transcription still feeds the IR, so
   * the lowered prompt never depends on the voice model). `mock` is the explicit
   * offline/developer choice: local, no key, no network, canned output (the
   * offline harness can override to it to run without a channel).
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

  // ── audio-back: spoken audio to the human (premium/flagship) ────────────────
  /**
   * Spoken audio back to the human. `off` = silent (standard/rapid); `acks` =
   * short TTS confirmations the channel synthesizes on lowering milestones
   * (premium — e.g. a spoken "sent"); `voice` = native conversational speech
   * from the flagship realtime model (flagship). Absent → `off`.
   */
  audioBack?: "off" | "acks" | "voice";
  /** REST TTS model for `audioBack:"acks"`. Absent → gpt-4o-mini-tts. */
  ttsModel?: string;
  /** TTS voice id (acks). Absent → the model default. */
  ttsVoice?: string;
  /** Conversational realtime model for `audioBack:"voice"`. Absent → gpt-realtime-2.
   *  Budget alternatives: gpt-realtime, gpt-4o-mini-realtime-preview. */
  realtimeVoiceModel?: string;
  /** Conversational voice id (flagship). Absent → the model default (e.g. cedar/marin). */
  realtimeVoice?: string;
  /** Function-calling scope for flagship. `none` = no tools; `submit_intent` = one IR
   *  tool; `page` = the curated page-tools bridge (v2). Absent → none (v1). */
  realtimeTools?: "none" | "submit_intent" | "page";
  /** Reasoning effort for gpt-realtime-2 (flagship). Absent → the model default. */
  realtimeReasoning?: "minimal" | "low" | "medium" | "high";

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
   * Silence gating before a segment is sent to transcription (openai-audio-stack.md):
   * trim dead air / suppress empty segments. Off by default.
   */
  silenceGate?: { enabled: boolean; thresholdDb?: number; minSilenceMs?: number };
  /**
   * Keyword-priming sources — page text, component names, etc. — fed to the
   * transcriber as a bias prompt. Toggled per source; none by default.
   */
  priming?: { sources?: string[] };
  /**
   * Condition/polish passes in the lowering (P2). Slots exist so the pass
   * structure is real even while the passes are stubs. Off by default.
   */
  passes?: { silenceTrim?: boolean; imageDownscale?: boolean };
  // ── the prompt linter (realtime_prompt_linter_design.md) ────────────────────
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
 * `openai` backends (channel-side), so an overlay launched through `aiui claude`
 * works against the channel out of the box. `mock` is never a default here — it
 * is the explicit offline choice a developer opts into (an offline harness
 * overrides these two back to `mock` so it runs with no channel and no key). The
 * `mock*` cadence/typo knobs below only matter once `transcriber: "mock"`.
 */
/** Vanishing ink's slider range, and what the ✒️→💨 chip picks when it flips on. */
export const INK_FADE_MIN_SEC = 1;
export const INK_FADE_MAX_SEC = 10;
export const INK_FADE_DEFAULT_SEC = 6;

export const DEFAULT_INTENT_CONFIG: IntentPipelineConfig = {
  talkMode: "hold",
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
    realtimeVoiceModel: "gpt-realtime-2",
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

// ── the transcription ENGINES (the strip's picker) ───────────────────────────

/**
 * The strip's engine row: which transcription BACKEND runs, presented by its
 * real interaction shape — streaming (live deltas over a session socket) vs
 * request-response (one bounded round-trip per segment) — rather than by a
 * price rung. Each entry is a bundle of fine fields applied as session
 * overrides; explicit config still wins. See docs/guide/transcription.md.
 */
export interface TranscriptionEngine {
  id: string;
  /** The strip label, e.g. "Realtime Whisper". */
  label: string;
  /** The interaction shape, shown beside the label. */
  shape: "streaming" | "request-response";
  /** The pictogram (streaming ⚡ / request-response ⇄ carry the shape). */
  icon: string;
  overrides: Partial<IntentPipelineConfig>;
  /**
   * The config fields THIS engine's wire actually reads — **parameters are
   * per-model, not a standardized set**. Every vendor rejects (or silently
   * ignores) knobs it doesn't own — `delay` is whisper-only, `keyterms` is
   * Scribe-only, `include` logprobs is 4o-only — so each session builder
   * consumes exactly its engine's fields and the rest never touch its wire.
   * This list is the authoritative record of that ownership (and what the
   * docs table renders).
   */
  params: readonly (keyof IntentPipelineConfig)[];
}

export const TRANSCRIPTION_ENGINES: readonly TranscriptionEngine[] = [
  {
    id: "realtime-whisper",
    label: "Realtime Whisper",
    shape: "streaming",
    icon: "⚡",
    overrides: {
      transcriber: "openai-realtime",
      realtimeModel: "gpt-realtime-whisper",
      realtimeDelay: "xhigh",
    },
    params: ["realtimeModel", "realtimeDelay"],
  },
  {
    // Probed live (July 2026): the 4o-transcribe models over the SAME
    // realtime session stream deltas AND return token logprobs — which
    // gpt-realtime-whisper never does, include or not. So this engine is the
    // higher-accuracy streaming rung with the confidence heat map (full 4o;
    // the mini and the REST request-response forms remain config-only).
    // NOTE: `realtimeDelay` is whisper-only — the channel omits it for this
    // model (the wire rejects it).
    id: "gpt4o-transcribe",
    label: "GPT-4o Transcribe",
    shape: "streaming",
    icon: "🎯",
    overrides: { transcriber: "openai-realtime", realtimeModel: "gpt-4o-transcribe" },
    params: ["realtimeModel"], // logprobs are implicit; delay is whisper-only
  },
  {
    id: "scribe-v2",
    label: "Scribe v2",
    shape: "streaming",
    icon: "🎬",
    overrides: { transcriber: "elevenlabs" },
    params: ["keywords"], // Scribe keyterms; timestamps/no_verbatim are built in
  },
];

/** The engine a config is running, for display: the one whose EVERY override
 * field matches (two engines share a transcriber but differ by model). */
export function engineOf(config: IntentPipelineConfig): TranscriptionEngine | undefined {
  return TRANSCRIPTION_ENGINES.find((e) =>
    Object.entries(e.overrides).every(([k, v]) => config[k as keyof IntentPipelineConfig] === v),
  );
}

/** The default tier when none is set: `rapid` (streaming whisper, no voice back). */
export const DEFAULT_TIER: IntentTier = DEFAULT_INTENT_CONFIG.tier ?? "rapid";

/**
 * The fine fields a tier sets — the union of every key across {@link TIER_PRESETS}.
 * Derived (not hand-listed) so it stays in sync as presets change; it is what the
 * tier-switch delta reconciliation re-derives (see `advanced-config.ts`).
 */
export const TIER_CONTROLLED_KEYS: ReadonlySet<string> = new Set(
  Object.values(TIER_PRESETS).flatMap((preset) => Object.keys(preset)),
);

/**
 * Expand a `tier` into the fine fields it sets, layered over the defaults:
 * `{ ...DEFAULT, ...preset }`. Explicit fine fields are layered on top of
 * this by the caller (`effectiveConfig` / the channel's `resolveIntent`), so
 * this is only the "defaults ← preset" part. Legacy tier names expand via
 * {@link LEGACY_TIER_EXPANSIONS}; an unknown tier expands to the bare
 * defaults. Shared by both sides (overlay + channel) so there is one source
 * of truth for what a tier means.
 */
export function expandTier(tier: string | undefined): IntentPipelineConfig {
  const name = tier ?? DEFAULT_TIER;
  const preset = TIER_PRESETS[name as IntentTier] ?? LEGACY_TIER_EXPANSIONS[name] ?? {};
  return { ...DEFAULT_INTENT_CONFIG, ...preset };
}
