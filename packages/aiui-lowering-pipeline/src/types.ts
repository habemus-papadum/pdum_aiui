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

/**
 * How the screen share decides when to sample.
 *
 *  - `"smart"` (the default): a frame goes out only when the human has touched
 *    the page since the last one — a press, a key, a wheel, a drag, a stroke
 *    (local or from the iPad). Sitting still and narrating costs nothing. The
 *    cadence is a *ceiling*, not a metronome.
 *  - `"continuous"`: a frame every cadence tick regardless. Honest when the
 *    screen is changing without you (a running simulation), expensive always.
 *
 * Both modes ride the compiled prompt so the agent knows which it is reading.
 */
export type VideoCaptureMode = "smart" | "continuous";

/**
 * A shot's provenance when it came from the screen share's sampler rather than
 * a deliberate S / D-drag gesture. Its presence is what tells the compiler to
 * render the frame as part of a sequence.
 */
export interface ShotShare {
  /** The share's ordinal — `1` is the first V of the turn (`vid_1`). */
  ordinal: number;
  /** The mode in force when this frame was sampled. */
  mode: VideoCaptureMode;
  /** Milliseconds from the share's first frame — the frame's timestamp. */
  offsetMs: number;
}

export type IntentEvent =
  | { at: number; type: "armed"; on: boolean }
  | { at: number; type: "mode"; mode: Mode }
  | {
      at: number;
      type: "thread-open";
      trigger: "talk" | "ink" | "shot" | "contribution" | "explicit";
    }
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
  | {
      /**
       * Replace a segment's transcript WHOLESALE — the panel's segment
       * editor (fixing bad STT, pasting text) speaks this. The compiler
       * treats it as latest-wins IN PLACE: the segment's text item keeps its
       * stream position, its text (and word timestamps, when provided —
       * best-effort re-timestamped by the editor) are superseded, and the
       * timestamp interleave then reflows any anchored shots against the new
       * words. The original transcript stays in the stream for the trace,
       * exactly like a dropped shot.
       */
      at: number;
      type: "segment-replace";
      segment: number;
      text: string;
      words?: TranscriptWord[];
    }
  | { at: number; type: "stroke"; points: number; bounds: Rect }
  | {
      at: number;
      type: "ink-clear";
      auto: boolean;
      /**
       * Why the ink went away, when a cause beyond the user's ✕ / the fade is
       * worth recording. `"navigation"`: the page SPA-navigated and strokes
       * must not float over a route they weren't drawn on — the logged strokes
       * stay in the stream (correctly attributed by their position before the
       * `navigation` event); screenshots remain the durable form of deixis.
       */
      reason?: "navigation";
    }
  | {
      /**
       * The page navigated **within the same document** mid-turn — an SPA
       * router push, a hash jump to a section, a back/forward traversal (the
       * overlay's navigation watcher, navigation.ts). Context riding a turn,
       * never a turn opener (the `app-selection` rule): emitted only while a
       * thread is open. Ordering in the log is the attribution: strokes,
       * shots, and selections before this event belong to `from`, after it to
       * `to` — which also makes the stream self-describing after the hello's
       * one-shot `location.href` snapshot goes stale.
       *
       * This is the first of the context-boundary family — the host that
       * drives real tabs adds the `tab-switch` sibling below.
       */
      at: number;
      type: "navigation";
      /** `location.href` before. */
      from: string;
      /** `location.href` after. */
      to: string;
      /** How it happened, when the watcher could cheaply attribute it. */
      kind?: "push" | "replace" | "traverse" | "reload" | "hash";
    }
  | {
      /**
       * The user changed WHICH TAB they are looking at mid-turn — a different
       * boundary from `navigation` (same tab navigating in place). Its own
       * event so the compiler can phrase "you switched tabs" distinctly from
       * "the page navigated", and so the tab identities travel: `fromTab`/
       * `toTab` are the driver's tab handles (CDP targetId-derived ids / MV3
       * `chrome.tabs` ids), `from`/`to` the two tabs' `location.href`. Like
       * `navigation`, it is context riding a turn — emitted only while a thread
       * is open, and its POSITION is the attribution (content above it belongs
       * to the tab you left). See docs/proposals/browser-extension-intent-tool.md §2.
       */
      at: number;
      type: "tab-switch";
      /** `location.href` of the tab left behind. */
      from: string;
      /** `location.href` of the tab switched to. */
      to: string;
      /** The driver's handle for the tab left behind, when known. */
      fromTab?: number;
      /** The driver's handle for the tab switched to, when known. */
      toTab?: number;
    }
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
      /**
       * Where the pixels came from, when NOT a screen capture: `"paste"` =
       * the user pasted an image into the turn (the panel's segment editor /
       * end-of-turn paste). Same marker space, same disk blob, same
       * `takenAt` anchoring — but the lowering labels it a pasted image, so
       * the model never mistakes clipboard content for what was on screen.
       */
      origin?: "paste";
      /** Data-URL thumbnail (absent when no capture stream was granted). */
      thumb?: string;
      /** Absolute path of the saved image on disk (the thing the prompt hands the session). */
      path?: string;
      /**
       * Present when the screen share's sampler took this frame rather than a
       * human pressing S. Sampled frames are shots in every other respect —
       * same marker space, same disk blob, same labeled injection into the
       * linter, same `takenAt` anchoring — so the model sees one kind of
       * image, and this descriptor says which of them came from a sequence.
       */
      share?: ShotShare;
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
       * The screen share toggled (V). While on, the client samples the
       * display-capture stream on a cadence and each sampled frame enters the
       * turn as an ordinary **shot** — same marker space, same disk blob, same
       * injection into the live linter. So this event is not the frames; it is
       * the bracket around them, and it records the terms the sequence was
       * taken under.
       */
      at: number;
      type: "video-share";
      on: boolean;
      /** The share's ordinal (`1` = the turn's first V), on the `on` event. */
      ordinal?: number;
      /** Which sampling discipline was in force. */
      mode?: VideoCaptureMode;
      /** The cadence ceiling in ms (the HUD's slider). */
      cadenceMs?: number;
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

// ── the composed IR: composeIntent's output (folded from the stream above) ────
//
// These shapes live here, beside IntentEvent, so the compiler (engine.ts) and
// the item→text renderer (render.ts) can both depend on them without importing
// each other — engine.ts → render.ts → types.ts stays acyclic.

export interface ComposedItem {
  kind: "text" | "shot" | "code-selection" | "app-selection" | "navigation" | "tab-switch";
  text?: string;
  /** A navigation / tab-switch item's `location.href` before / after the boundary. */
  from?: string;
  to?: string;
  /** A tab-switch item's driver tab handles (the tab left / the tab entered). */
  fromTab?: number;
  toTab?: number;
  /** A text item's source segment ordinal — the accumulator view's stable key. */
  segment?: number;
  /** The item's stream identity (`shot_N` / `sel_N` / `code_N`) — absent for
   * text runs and for selections from pre-marker traces. */
  marker?: string;
  thumb?: string;
  path?: string;
  components?: LocatedComponent[];
  /** True for a whole-viewport shot (renders with no element metadata). */
  viewport?: boolean;
  /** A shot item's capture-gesture wall-clock (see the shot event's doc). */
  takenAt?: number;
  /** Set when this shot is a frame sampled by a video share (see {@link ShotShare}). */
  share?: ShotShare;
  /** `"paste"` when the image came from the clipboard (labeled in the prompt). */
  origin?: "paste";
  /** A selection item's locator (`file:line:col` / `file:start-end`). */
  sourceLoc?: string;
  /** A selection item's page `location.href` — rendered as the `<tab>` record. */
  url?: string;
  /** A code-selection item's line count. */
  lines?: number;
  /** An app-selection item's producing dataflow cell (`data-cell`). */
  cell?: string;
  /** That cell's definition site (`file:line` — the `cell(...)` call), when stamped. */
  cellLoc?: string;
  /** An app-selection item's TeX source (selected rendered mathematics). */
  tex?: string;
  /**
   * A text run the transcriber has not finalized: the still-streaming
   * segment's cumulative `transcript-delta` text. Only ever produced under
   * {@link ComposeOptions.streaming}, which only the preview passes — the
   * committed prompt is built from finals alone. Survives the timestamp
   * interleave's split, so a run either side of a mid-utterance shot stays
   * marked provisional.
   */
  provisional?: boolean;
}

/**
 * A typed region of the rendered `prompt` string — the structure the renderer
 * already knows, handed to consumers (the trace hero) so they annotate the raw
 * text instead of re-discovering it with a regex. `[start, end)` are character
 * offsets into {@link ComposedIntent.prompt}. Body spans are produced by
 * `renderPrompt` (render.ts); the channel prepends a `preamble` span and shifts
 * the body spans when it wraps the body in its context preamble.
 */
export type PromptSpan =
  | {
      kind: "shot";
      start: number;
      end: number;
      marker: string;
      /** The image's RAW disk path — deliberately NOT the cwd-relativized form
       * the prompt *text* shows: consumers (the hero's blob/preview routes)
       * need the real path, and can derive the basename either way. */
      path?: string;
      thumb?: string;
      viewport?: boolean;
      origin?: "paste";
      share?: ShotShare;
      components: LocatedComponent[];
    }
  | {
      kind: "app-selection";
      start: number;
      end: number;
      marker?: string;
      sourceLoc?: string;
      cell?: string;
      cellLoc?: string;
      tex?: string;
      url?: string;
    }
  | {
      kind: "code-selection";
      start: number;
      end: number;
      marker?: string;
      sourceLoc?: string;
      lines?: number;
      url?: string;
    }
  | { kind: "navigation" | "tab-switch"; start: number; end: number; from: string; to: string }
  | { kind: "preamble"; start: number; end: number };

export interface ComposedIntent {
  /** Transcript with `replace`-policy corrections applied. */
  transcript: string;
  /** Chronological interleave of text runs, shots, and selections (app + code). */
  items: ComposedItem[];
  corrections: Array<{
    original: string;
    instruction: string;
    applied: boolean;
    patch?: string;
    /** The chunk window the fix was scoped to (see the correction event). */
    scope?: { fromLine: number; toLine: number };
  }>;
  components: LocatedComponent[];
  /**
   * The lowered body: prose with each screenshot **inlined at its position**
   * as a `[screenshot located at <path>]` bracket line plus, when elements
   * were located, a `<screenshot-metadata>` XML block — path (relativized
   * against {@link ComposeOptions.cwd} when given), located elements, and
   * their cell frontier, all in the text where the image belongs. This
   * replaced the Option-C `{shot_n}` token + meta-map scheme: the indirection
   * cost a hint line and a metadata block the agent had to correlate, for
   * structure nothing downstream actually consumed (`meta` only ever became
   * text attributes on the rendered channel tag).
   */
  prompt: string;
  /**
   * Offset-annotated structure over {@link prompt}: shots, on-screen and code
   * selections, navigation/tab boundaries, and — once the channel wraps the
   * body — the context preamble. Consumers (the trace hero) render the raw
   * prompt and overlay hover-previews / source hyperlinks / a de-emphasized
   * preamble from these instead of re-parsing the string. Purely additive: the
   * `prompt` text is byte-identical whether or not anyone reads `spans`.
   */
  spans: PromptSpan[];
  /**
   * Retained for wire/API compatibility; shots no longer populate it (their
   * paths and element info are inlined in {@link prompt}).
   */
  meta: Record<string, string>;
}

/** Options for {@link composeIntent}. */
export interface ComposeOptions {
  /**
   * The agent's working directory: screenshot paths AND source locations
   * under it render relative (shorter, stable across machines); paths outside
   * it stay absolute. Only the channel passes this — the browser has no cwd
   * and its compose is a preview, not the committed prompt.
   */
  cwd?: string;
  /**
   * Compose a **provisional** text run for each segment that has `transcript
   * -delta`s but no final yet — the words you are still speaking. Off by
   * default, and the channel never turns it on: what gets sent is built from
   * finals alone, so in-flight words never reach a prompt or a paid call.
   *
   * The **transcript preview** turns it on, and gets one thing for free that
   * it used to fake: with a text run to anchor against, the existing
   * timestamp interleave (below) drops a mid-utterance screenshot **where it
   * was taken**, live, instead of stacking shots ahead of the segment until
   * the final arrives and reorders everything at once. Streaming transcribers
   * (ElevenLabs Scribe, OpenAI realtime, Gemini Live) carry the deltas that
   * make this possible; a whole-segment REST transcriber has none, so its
   * shots keep their arrival position, exactly as before.
   */
  streaming?: boolean;
}
