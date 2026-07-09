/**
 * The intent pipeline's shared vocabulary: every multimodal act becomes an
 * {@link IntentEvent} on one append-only stream. Every "IR stage" is a pure
 * function over that stream (see engine.ts/composeIntent) — which is the whole
 * point: design the passes by watching them run on real interaction. The
 * inspector panes (debug-ui) render the stream raw; these event shapes
 * are also the fixture format and, from P2, the wire contract.
 *
 * Framework-free and browser-safe by construction — no DOM, no deps. Config
 * lives in {@link ./config}.
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

/**
 * The engine's interaction modes. (Historical note: a `"correct"` mode — the
 * two-box transcript editor — existed until the append-only pivot removed it;
 * `correction` EVENTS remain in the stream vocabulary below so historical
 * traces still fold, but nothing emits them anymore.)
 */
export type Mode = "ink" | "tweak" | "vscode";

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
  /** That cell's definition site (`file:line` — the `cell(...)` call), when stamped. */
  cellLoc?: string;
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

/**
 * One transcribed word, positioned in the SEGMENT'S OWN AUDIO — milliseconds
 * from the segment's first sample (the talk-start instant, since capture
 * begins there) — plus the model's confidence when the vendor reports one.
 * Word timestamps are the precise anchor for compile-time media interleaving
 * (they replace the delta-arrival latency estimate when present), and
 * logprobs drive the preview's confidence heat map.
 */
export interface TranscriptWord {
  text: string;
  startMs?: number;
  endMs?: number;
  logprob?: number;
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
      /** Word-level timestamps + confidence, when the transcriber reports them. */
      words?: TranscriptWord[];
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
      /**
       * Wall-clock of the capture GESTURE (pointerup / S keydown) — not of
       * this event's emission, which trails it by the compositor wait +
       * encode (and by the getDisplayMedia picker on the first shot). The
       * compiler uses it to place the shot INSIDE a still-open segment's
       * text via the `transcript-delta` timeline; absent (legacy streams,
       * idle shots) → arrival-order placement.
       */
      takenAt?: number;
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
       * An on-screen selection riding this turn: text highlighted in the app
       * *before* arming (while armed, drags ink — so the watcher's snapshot is
       * the record of it), or re-selected mid-turn (tweak mode, correct mode).
       * A first-class stream event, interleaved like text and shots: it
       * composes into the prompt AT ITS POSITION and shows as a chip there in
       * the preview. Emitted right after `thread-open` for the pre-arm
       * snapshot, and again on each mid-turn selection.
       *
       * `marker` (`sel_1`, `sel_2`, … — the engine assigns, mirroring
       * `shot_N`) is the selection's identity: a refinement of the SAME
       * selection (nothing contentful in between — the watcher tracking a
       * drag) re-emits under the same marker and the fold keeps the latest
       * payload at the first position (one chip that tracks the drag); once
       * anything else lands, a new selection gets a fresh marker and its own
       * position. Absent only in pre-marker traces (consumers fold those
       * latest-wins, the legacy behavior).
       */
      at: number;
      type: "app-selection";
      marker?: string;
    } & AppSelection)
  | {
      /**
       * Retract exactly one app selection (the chip's ✕ / a cleared watcher):
       * the one named by `marker`. Append-only like everything else: the
       * `app-selection` events stay in the stream and the trace; composition
       * just excludes the marker. A markerless drop (pre-marker traces)
       * retracts the most recent selection, the legacy behavior.
       */
      at: number;
      type: "app-selection-drop";
      marker?: string;
    }
  | ({
      /**
       * Code contributed from another view of the session (the reader's
       * "Add to prompt →", over the session bus). Structured on purpose:
       * `composeIntent` — shared with the channel's lowering — renders it
       * (short → inline sentence, long → fenced block) at compose time, so
       * the preview shows a chip, the trace shows the selection itself, and
       * corrections can never rewrite contributed code as if it were speech.
       *
       * `marker` (`code_1`, `code_2`, … — the engine assigns, mirroring
       * `shot_N`) makes the chip retractable exactly like a shot; absent only
       * in pre-marker traces (those can't be dropped, and nothing crashes).
       */
      at: number;
      type: "code-selection";
      marker?: string;
    } & CodeSelection)
  | {
      /**
       * Retract a code selection from the turn (the chip's ✕ — the same
       * gesture as deleting a screenshot). Append-only like everything else:
       * the `code-selection` event stays in the stream and the trace;
       * `composeIntent` just excludes the marker from the composition.
       */
      at: number;
      type: "code-selection-drop";
      marker: string;
    }
  | { at: number; type: "note"; text: string }
  /**
   * A prompt-linter observation — the realtime model's spoken diagnostic,
   * folded into the stream so the trace and the preview both carry what the
   * linter said. NEVER composed into the prompt: the compiler's fold skips
   * every `linter-*` kind (the linter observes the briefing; it does not
   * write it). `segment` correlates the note to the talk window it lints.
   */
  | { at: number; type: "linter-note"; text: string; segment?: number }
  /**
   * The linter asked to use a tool (e.g. `read_file`) — the request half,
   * recorded first-class so the trace shows exactly what the linter did.
   * Trace/debug material only: the compiler skips it, and the client renders
   * no chip for it (the trace viewer is its surface).
   */
  | { at: number; type: "linter-tool-call"; tool: string; args: Record<string, unknown> }
  /**
   * The tool's answer to a `linter-tool-call` — `summary` is a short human
   * gloss (`"src/x.ts — 4.1KB"` / an error string), never the content (which
   * lives in the trace stage's data). Compiler-skipped like its request.
   */
  | { at: number; type: "linter-tool-result"; tool: string; ok: boolean; summary: string };
