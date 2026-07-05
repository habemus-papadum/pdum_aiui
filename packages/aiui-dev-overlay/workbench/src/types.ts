/**
 * The workbench's shared vocabulary: everything the overlay does becomes an
 * {@link IntentEvent} on one append-only stream. The inspector renders the
 * stream raw, and every "IR stage" is a pure function over it (see
 * engine.ts/composeIntent) — which is the whole point of the workbench:
 * design the passes by watching them run on real interaction.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A component found under a screenshot rect via `data-source` annotations. */
export interface LocatedComponent {
  component: string;
  /** `path/to/file.ts:line` — what the locator plugin will emit in real apps. */
  source: string;
  /** Viewport bbox at capture time. */
  rect: Rect;
}

export type Mode = "ink" | "correct";

export type IntentEvent =
  | { at: number; type: "armed"; on: boolean }
  | { at: number; type: "mode"; mode: Mode }
  | { at: number; type: "thread-open"; trigger: "talk" | "ink" | "shot" }
  | { at: number; type: "thread-close"; reason: "send" | "cancel" | "timeout" }
  | { at: number; type: "talk-start"; segment: number }
  | { at: number; type: "talk-end"; segment: number; ms: number }
  | { at: number; type: "transcript-delta"; segment: number; text: string }
  | {
      at: number;
      type: "transcript-final";
      segment: number;
      text: string;
      latencyMs: number;
      model: string;
      /** Set when this segment was spoken while a correction target was lassoed. */
      correction?: boolean;
    }
  | { at: number; type: "stroke"; points: number; bounds: Rect }
  | { at: number; type: "ink-clear"; auto: boolean }
  | {
      at: number;
      type: "shot";
      /**
       * Ordinal token, e.g. "shot_1" — identifier-shaped on purpose: the
       * lowered prompt places `{shot_1}` in the body and the path in a
       * same-named meta key (Option C in
       * archive/channel-attachment-path-encoding.md; meta keys allow no
       * hyphens).
       */
      marker: string;
      rect: Rect;
      components: LocatedComponent[];
      /** Data-URL thumbnail (absent when no capture stream was granted). */
      thumb?: string;
      /** Absolute path of the saved PNG on disk (the thing the prompt hands the session). */
      path?: string;
    }
  | {
      at: number;
      type: "correction";
      /** Character range in the rendered transcript at selection time. */
      from: number;
      to: number;
      original: string;
      instruction: string;
      via: "speech" | "typed";
      /**
       * The V4A patch the correction micro-pipeline produced (see patch.ts /
       * correct.ts). Absent when the pipeline failed — appliers then fall
       * back to replacing `original` with `instruction`.
       */
      patch?: string;
      /** Corrector model + its latency, for the timing pane. */
      model?: string;
      latencyMs?: number;
    }
  | { at: number; type: "note"; text: string };

/** Every contested interaction-design choice is a setting, not a decision. */
export interface WorkbenchSettings {
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
  /** Which correction micro-pipeline runs (see correct.ts). */
  corrector: "mock" | "openai";
  /** Chat model that emits the correction patch (when corrector = openai). */
  correctionModel: string;
}

export const DEFAULT_SETTINGS: WorkbenchSettings = {
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
};
