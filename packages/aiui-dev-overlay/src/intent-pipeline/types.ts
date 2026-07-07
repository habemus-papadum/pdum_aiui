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

/** One dataflow cell surfaced with a located component (see {@link LocatedComponent.cells}). */
export interface LocatedCell {
  name: string;
  /** `path/to/file.ts:line:col` when the cell element carries its own stamp. */
  source?: string;
}

/**
 * A component a region screenshot located via the `data-source-loc` /
 * `data-cell` annotations. The locator keeps only the **highest annotated
 * elements fully enclosed by the rect** — the things the user framed, not
 * everything the rect grazes — or, when the rect encloses nothing annotated
 * (a drag inside one big component), the innermost annotated element
 * *containing* the rect, marked `containment: "within"`.
 */
export interface LocatedComponent {
  component: string;
  /** `path/to/file.ts:line` — what the locator plugin will emit in real apps. */
  source: string;
  /** Viewport bbox at capture time. */
  rect: Rect;
  /**
   * The element's direct-cell frontier: the topmost `data-cell` descendants
   * (no other cell between them and this element). Deliberately one level —
   * enough of a handle into the dataflow graph for an agent to start from;
   * deeper cells are the agent's own journey.
   */
  cells?: LocatedCell[];
  /** How the rect relates to this element; absent means `"enclosed"`. */
  containment?: "enclosed" | "within";
}

export type Mode = "ink" | "correct" | "tweak";

/**
 * The payload of an `app-selection` event: what the user had highlighted on
 * the page when the turn opened (the overlay's selection watcher snapshots it
 * — see the overlay's selection.ts). The raw text plus the same DOM-contract
 * attribution the screenshot locator reads (`data-source-loc` / `data-cell`).
 */
export interface AppSelection {
  /** The selected text, trimmed and capped by the watcher. */
  text: string;
  /** `data-source-loc` (`file:line:col`) of the selection's start element. */
  sourceLoc?: string;
  /** `data-cell` (dataflow node) of the selection's start element. */
  cell?: string;
  /** TeX source when the selection is rendered mathematics. */
  tex?: string;
  /** `location.href` of the page the selection was made on. */
  url?: string;
}

/**
 * The payload of a `code-selection` event: code selected in another view of
 * the session (e.g. a VS Code bridge) and contributed to the turn. Kept structured
 * — raw text plus locator — so the LOWERING decides how it renders into the
 * prompt; the contributing view makes no formatting decisions.
 */
export interface CodeSelection {
  /** The selected code, verbatim. */
  text: string;
  /** `file:line:col` (or `file:startLine-endLine`) locator, if known. */
  sourceLoc?: string;
  /** The contributing view's `location.href`. */
  url?: string;
  /** Line count (derived from `text` when omitted). */
  lines?: number;
}

export type IntentEvent =
  | { at: number; type: "armed"; on: boolean }
  | { at: number; type: "mode"; mode: Mode }
  | { at: number; type: "thread-open"; trigger: "talk" | "ink" | "shot" | "contribution" }
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
      /**
       * True for a whole-viewport shot (S). Viewport shots deliberately skip
       * the locator and render with no element metadata — "everything" is not
       * a useful point of reference.
       */
      viewport?: boolean;
      /** Data-URL thumbnail (absent when no capture stream was granted). */
      thumb?: string;
      /** Absolute path of the saved PNG on disk (the thing the prompt hands the session). */
      path?: string;
    }
  | {
      /**
       * Retract a shot from the turn (the preview thumbnail's ✕). Append-only
       * like everything else: the shot event (and any uploaded bytes) stay in
       * the stream and the trace; `composeIntent` — shared with the channel's
       * lowering — just excludes the marker from the composition.
       */
      at: number;
      type: "shot-drop";
      marker: string;
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
       * The window of transcript lines (text items, [fromLine, toLine)) this
       * correction is scoped to — the chunk that was active in the editor.
       * The corrector model sees ONLY these lines and the plain-replacement
       * fallback searches only inside them; absent → the whole transcript
       * (pre-chunk-editor events, and the engine-level tests).
       */
      scope?: { fromLine: number; toLine: number };
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
  | {
      /**
       * Undo the most recent still-active correction (LIFO — a stack pop).
       * Append-only like everything else: the correction event stays in the
       * stream and the trace; `composeIntent` — shared with the channel's
       * lowering — pops it from the applied set, so the preview AND the
       * lowered prompt agree about what Escape took back.
       */
      at: number;
      type: "correction-undo";
    }
  | {
      /**
       * The realtime submode's screen share toggled (V). While on, the client
       * samples the display-capture stream at ~1 fps into `video` chunks —
       * unlabeled ambient context for the live model (deliberate shots stay
       * the referenceable artifacts). An event so the trace shows exactly
       * when the model could see the screen.
       */
      at: number;
      type: "video-share";
      on: boolean;
    }
  | ({
      /**
       * The on-screen selection riding this turn: text highlighted in the app
       * *before* arming (while armed, drags ink — so the watcher's snapshot is
       * the record of it). Emitted right after `thread-open`, so the turn's
       * transcript *begins* with the selection chip; re-emitted (last wins)
       * when the page selection changes while the thread is open. Lowered by
       * the channel into the prompt's context preamble (the same wording the
       * `text-concat` selection block uses), never the body: it is context
       * about the intent, not the intent itself.
       */
      at: number;
      type: "app-selection";
    } & AppSelection)
  | {
      /**
       * Retract the turn's app selection (the chip's ✕ / a cleared watcher).
       * Append-only like everything else: prior `app-selection` events stay in
       * the stream and the trace; composition just stops carrying one.
       */
      at: number;
      type: "app-selection-drop";
    }
  | ({
      /**
       * Code contributed from another view of the session (the reader's
       * "Add to prompt →", over the session bus). Structured on purpose:
       * `composeIntent` — shared with the channel's lowering — renders it
       * (short → inline sentence, long → fenced block) at compose time, so
       * the preview shows a chip, the trace shows the selection itself, and
       * corrections can never rewrite contributed code as if it were speech.
       */
      at: number;
      type: "code-selection";
    } & CodeSelection)
  | { at: number; type: "note"; text: string };
