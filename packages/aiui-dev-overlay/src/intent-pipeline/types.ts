/**
 * The intent pipeline's shared vocabulary: every multimodal act becomes an
 * {@link IntentEvent} on one append-only stream. Every "IR stage" is a pure
 * function over that stream (see engine.ts/composeIntent) — which is the whole
 * point: design the passes by watching them run on real interaction. The
 * inspector (in the workbench lab) renders the stream raw; these event shapes
 * are also the fixture format and, from P2, the wire contract.
 *
 * Framework-free and browser-safe by construction — no DOM, no deps. Config
 * (the old `WorkbenchSettings`) lives in {@link ./config}.
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
