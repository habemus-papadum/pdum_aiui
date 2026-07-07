/**
 * The intent pipeline's configuration — one object, deliberately wider than any
 * UI. It began as the workbench's `WorkbenchSettings` (every contested
 * interaction-design choice as a knob, argued by toggling) and graduates here
 * as a **superset**: the same visible toggles, plus research knobs that ship
 * without UI so they can be measured before they are designed for.
 *
 * Plumbing (implemented in P2/P3, not here): the **client-side** knobs ride the
 * modality options (`aiuiDevOverlay({ intent: {...} })` → widget); the
 * **server-side** knobs (real transcription/correction models, silence gating,
 * priming) live in the channel's config; the hello frame carries the client's
 * view so a trace records the whole configuration. The lab (workbench) exposes
 * everything by default via its settings drawer + a raw-JSON advanced panel;
 * the shipping overlay exposes a curated few. Same type throughout.
 *
 * Framework-free, browser-safe, no deps — like everything in this folder.
 */

export interface IntentPipelineConfig {
  // ── the tier dial (the cost-sized preset over the fine fields below) ────────
  /**
   * Cost-sized preset that expands into the fine fields; explicit fine fields
   * win. Five values — `mock` (offline, keyless, $0) plus four paid rungs that
   * ascend in cost and richness: `standard` (cheap REST, today's default),
   * `rapid` (streaming STT, ~2× faster final), `premium` (rapid + spoken TTS
   * acks), `flagship` (a `gpt-realtime-2` voice model that answers aloud). The
   * preset fills the fine fields *above* the defaults but *below* anything set
   * explicitly (Vite `intent` ∪ panel/agent overrides). Absent → `standard`
   * (reproduces today's REST-mini default exactly). See `TIER_PRESETS` +
   * `expandTier`, and docs/guide/intent-overlay.md §Tiers.
   */
  tier?: "mock" | "standard" | "rapid" | "premium" | "flagship" | "live-gemini" | "live-openai";

  // ── the visible toggles (were WorkbenchSettings) ───────────────────────────
  /** Space bar behavior: hold-to-talk (walkie-talkie) or press-to-toggle. */
  talkMode: "hold" | "toggle";
  /** Seconds until ink strokes fade out; 0 = persist until cleared. */
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
   * workbench lab overrides to it so it runs without a channel).
   */
  transcriber: "mock" | "openai" | "openai-realtime" | "openai-voice";
  /** OpenAI transcription model (when transcriber = openai). */
  model: string;
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
  /** What a correction does: rewrite the transcript, or ride along as a note. */
  correctionPolicy: "replace" | "note";
  /**
   * Which correction micro-pipeline runs (see the corrector seam). Defaults to
   * `openai` — the real, channel-side corrector; `mock` is the explicit
   * offline/developer choice (a local string-replace patch, no key, no network).
   */
  corrector: "mock" | "openai";
  /** Chat model that emits the correction patch (when corrector = openai). */
  correctionModel: string;

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
  /**
   * How long the post-correction pink/green word-diff flash stays up before the
   * clean render. Absent → the built-in default (500 ms).
   */
  diffFlashMs?: number;
  /**
   * How screenshots render in the lowered prompt: an indented `<screenshot>`
   * XML block (absent → `"xml"`, the default — Claude-family models attend
   * reliably to tags and it stays human-readable), or `"text"` for the plain
   * bracket block. A lowering choice, read channel-side off the hello.
   */
  shotFormat?: "xml" | "text";

  // ── the realtime submode (transcription-and-realtime-submodes.md) ──────────
  /**
   * Which submode the turn runs. `transcription` (absent → the default) is
   * document assembly — everything above. `realtime` holds a live
   * conversational session channel-side (Gemini Live / GPT realtime): the
   * model hears the mic continuously, sees labeled shots (and, per
   * `video-share`, ~1 fps screen frames), and COMPOSES the prompt itself via
   * a `submit_intent` function call (interleaved text/image segments); the
   * channel re-attaches withheld shot metadata when resolving it.
   */
  submode?: "transcription" | "realtime";
  /** Realtime engine. `gemini` (video-capable, the reference) or `openai`. */
  liveVendor?: "gemini" | "openai";
  /** Realtime model id. Absent → the vendor default (see the tier presets). */
  liveModel?: string;
}

/**
 * The shipped defaults. Transcription and correction default to the **real**
 * `openai` backends (channel-side), so an overlay launched through `aiui claude`
 * works against the channel out of the box. `mock` is never a default here — it
 * is the explicit offline choice a developer opts into (the workbench lab
 * overrides these two back to `mock` so it runs with no channel and no key). The
 * `mock*` cadence/typo knobs below only matter once `transcriber: "mock"`.
 */
export const DEFAULT_INTENT_CONFIG: IntentPipelineConfig = {
  talkMode: "hold",
  inkFadeSec: 0,
  autoEndSec: 0,
  transcriber: "openai",
  model: "gpt-4o-mini-transcribe",
  mockWordMs: 140,
  mockTypoRate: 0.07,
  correctionPolicy: "replace",
  corrector: "openai",
  correctionModel: "gpt-4o-mini",
  audioBack: "off",
  arming: { key: "`", enabled: true },
};

// ── the tier presets (the cost-sized dial → fine fields) ─────────────────────

/** The five tier values. `standard` is the default (absent tier → standard). */
export type IntentTier = NonNullable<IntentPipelineConfig["tier"]>;

/**
 * Each tier as a `Partial<IntentPipelineConfig>` of the fine fields it sets. A
 * blank (absent key) means "not set by this preset" — it inherits
 * {@link DEFAULT_INTENT_CONFIG}. This is the expansion table in
 * `handoff/model-tiers.md` §"The expansion table". Explicit fine fields (Vite
 * `intent` ∪ panel/agent overrides) still win over these — see
 * {@link expandTier} and `effectiveConfig`.
 *
 * The rungs, cheapest first:
 *  - `mock`     — offline dev: mock STT + mock corrector, $0.
 *  - `standard` — cheap REST STT (gpt-4o-mini-transcribe) + gpt-4o-mini. Today's default.
 *  - `rapid`    — streaming STT (gpt-realtime-whisper): ~2× faster final, no voice back.
 *  - `premium`  — rapid + spoken TTS acks (gpt-4o-mini-tts).
 *  - `flagship` — a gpt-realtime-2 voice model that answers aloud + barge-in.
 */
export const TIER_PRESETS: Record<IntentTier, Partial<IntentPipelineConfig>> = {
  mock: {
    transcriber: "mock",
    corrector: "mock",
    audioBack: "off",
  },
  standard: {
    transcriber: "openai",
    model: "gpt-4o-mini-transcribe",
    corrector: "openai",
    correctionModel: "gpt-4o-mini",
    audioBack: "off",
  },
  rapid: {
    transcriber: "openai-realtime",
    realtimeModel: "gpt-realtime-whisper",
    corrector: "openai",
    correctionModel: "gpt-4o-mini",
    audioBack: "off",
  },
  premium: {
    transcriber: "openai-realtime",
    realtimeModel: "gpt-realtime-whisper",
    corrector: "openai",
    correctionModel: "gpt-4o-mini",
    audioBack: "acks",
    ttsModel: "gpt-4o-mini-tts",
  },
  flagship: {
    transcriber: "openai-voice",
    corrector: "openai",
    correctionModel: "gpt-4o-mini",
    audioBack: "voice",
    realtimeVoiceModel: "gpt-realtime-2",
    realtimeVoice: "cedar",
    realtimeTools: "none",
  },
  // The realtime submode's rungs: the model IS the composer (submit_intent).
  // Gemini is the reference engine (video-capable, manual-VAD verified — see
  // archive/gemini-live-spike.mjs); OpenAI degrades to labeled shots only.
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

/** The default tier when none is set: `standard` reproduces today's behavior exactly. */
export const DEFAULT_TIER: IntentTier = DEFAULT_INTENT_CONFIG.tier ?? "standard";

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
 * `{ ...DEFAULT, ...TIER_PRESETS[tier] }`. Explicit fine fields are layered on
 * top of this by the caller (`effectiveConfig` / the channel's `resolveIntent`),
 * so this is only the "defaults ← preset" part. An unknown tier expands to the
 * bare defaults. Shared by both sides (overlay + channel) so there is one source
 * of truth for what a tier means.
 */
export function expandTier(tier: string | undefined): IntentPipelineConfig {
  const preset = TIER_PRESETS[(tier ?? DEFAULT_TIER) as IntentTier] ?? {};
  return { ...DEFAULT_INTENT_CONFIG, ...preset };
}
