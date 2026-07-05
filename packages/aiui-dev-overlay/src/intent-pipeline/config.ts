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
  // ── the visible toggles (were WorkbenchSettings) ───────────────────────────
  /** Space bar behavior: hold-to-talk (walkie-talkie) or press-to-toggle. */
  talkMode: "hold" | "toggle";
  /** Seconds until ink strokes fade out; 0 = persist until cleared. */
  inkFadeSec: number;
  /** Auto-end the thread after this many silent/idle seconds; 0 = explicit Enter only. */
  autoEndSec: number;
  /** Which transcriber runs. */
  transcriber: "mock" | "openai";
  /** OpenAI transcription model (when transcriber = openai). */
  model: string;
  /** Mock: per-word cadence in ms. */
  mockWordMs: number;
  /** Mock: probability [0..1] a word is mangled — fuel for correction mode. */
  mockTypoRate: number;
  /** What a correction does: rewrite the transcript, or ride along as a note. */
  correctionPolicy: "replace" | "note";
  /** Which correction micro-pipeline runs (see the corrector seam). */
  corrector: "mock" | "openai";
  /** Chat model that emits the correction patch (when corrector = openai). */
  correctionModel: string;

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
}

export const DEFAULT_INTENT_CONFIG: IntentPipelineConfig = {
  talkMode: "hold",
  inkFadeSec: 6,
  autoEndSec: 0,
  transcriber: "mock",
  model: "gpt-4o-mini-transcribe",
  mockWordMs: 140,
  mockTypoRate: 0.07,
  correctionPolicy: "replace",
  corrector: "mock",
  correctionModel: "gpt-4o-mini",
  arming: { key: "`", enabled: true },
};
