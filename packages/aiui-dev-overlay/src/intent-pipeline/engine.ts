/**
 * The intent engine: one append-only event stream plus the little state
 * machine around it (armed, mode, talking, thread). UI surfaces (ink canvas,
 * shot tool, audio, preview, inspector) call the verbs; everything they need
 * to render they learn back from the stream. That inversion is deliberate —
 * it forces every interaction to be expressible as events, which is exactly
 * the shape the real protocol will need.
 *
 * Thread lifecycle (the design under test):
 *  - a thread OPENS implicitly on the first contentful act while armed
 *    (talk-start, stroke, or shot) — there is no "begin" gesture;
 *  - it CLOSES explicitly on Enter (send) or Esc (cancel), or — policy,
 *    default off — after `autoEndSec` of idle silence;
 *  - a send also DISARMS: Enter ends the interaction, and re-arming starts
 *    a visibly fresh turn.
 */
import { DEFAULT_INTENT_CONFIG, type IntentPipelineConfig } from "./config";
import { applyCorrectionToLines } from "./patch";
import type {
  AppSelection,
  CodeSelection,
  IntentEvent,
  LocatedComponent,
  Mode,
  Rect,
} from "./types";

export type EngineListener = (event: IntentEvent, engine: Engine) => void;

export interface CorrectionTarget {
  from: number;
  to: number;
  original: string;
  /** The transcript-line window the fix is scoped to (the active chunk). */
  scope?: { fromLine: number; toLine: number };
}

export class Engine {
  readonly settings: IntentPipelineConfig;
  events: IntentEvent[] = [];
  armed = false;
  mode: Mode = "ink";
  talking = false;
  threadOpen = false;
  /** Set while correct mode has a lassoed range awaiting its instruction. */
  correctionTarget: CorrectionTarget | undefined;

  private listeners: EngineListener[] = [];
  private segmentCounter = 0;
  private shotCounter = 0;
  private selCounter = 0;
  private codeCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(settings: Partial<IntentPipelineConfig> = {}, now: () => number = () => Date.now()) {
    this.settings = { ...DEFAULT_INTENT_CONFIG, ...settings };
    this.now = now;
  }

  onEvent(listener: EngineListener): void {
    this.listeners.push(listener);
  }

  private emit(event: IntentEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event, this);
    }
    this.bumpIdleTimer();
  }

  private stamp<T extends Omit<IntentEvent, "at">>(event: T): T & { at: number } {
    return { at: this.now(), ...event } as T & { at: number };
  }

  // ── arming & modes ─────────────────────────────────────────────────────────

  setArmed(on: boolean): void {
    if (on === this.armed) {
      return;
    }
    this.armed = on;
    if (!on) {
      if (this.talking) {
        this.talkEnd();
      }
      if (this.threadOpen) {
        this.closeThread("cancel");
      }
      this.mode = "ink";
      this.correctionTarget = undefined;
    }
    this.emit(this.stamp({ type: "armed", on }));
  }

  setMode(mode: Mode): void {
    if (!this.armed || mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (mode !== "correct") {
      this.correctionTarget = undefined;
    }
    this.emit(this.stamp({ type: "mode", mode }));
  }

  /** Esc, one level at a time: correct → ink, tweak → ink, ink+thread → cancel, → disarm. */
  stepOut(): void {
    if (this.mode === "correct" || this.mode === "tweak") {
      this.setMode("ink");
      return;
    }
    if (this.threadOpen) {
      this.closeThread("cancel");
      return;
    }
    this.setArmed(false);
  }

  // ── thread ─────────────────────────────────────────────────────────────────

  /**
   * The turn's app selection, read once at thread-open (set by the modality —
   * it returns the selection watcher's current snapshot). Whatever was
   * highlighted on the page when the turn's first contentful act happened
   * becomes the turn's opening `app-selection` event, so the transcript
   * *begins* with the selection chip and pre-arm selections can never be lost
   * to a send-time read.
   */
  selectionProvider?: () => AppSelection | undefined;

  private ensureThread(trigger: "talk" | "ink" | "shot" | "contribution"): void {
    if (this.threadOpen || !this.armed) {
      return;
    }
    this.threadOpen = true;
    this.emit(this.stamp({ type: "thread-open", trigger }));
    const selection = this.selectionProvider?.();
    if (selection !== undefined && selection.text !== "") {
      this.emitAppSelection(selection);
    }
  }

  /**
   * Ingest text contributed from ANOTHER view of the session (a code selection
   * from the reader, over the session bus) as content in the current turn. Opens
   * the thread if armed, then emits it as a `transcript-final` so it composes
   * into the prompt exactly like spoken text and shows in the preview. No-op when
   * not armed — a contribution needs an armed turn to join. Returns the segment
   * number it was recorded under, or undefined.
   */
  contribute(text: string): number | undefined {
    if (!this.armed || !text) {
      return undefined;
    }
    this.ensureThread("contribution");
    const segment = ++this.segmentCounter;
    // Deliberately NOT flagged as a correction (unlike transcriptFinal's
    // correct-mode guard): a contribution is always content.
    this.emit(
      this.stamp({ type: "transcript-final", segment, text, latencyMs: 0, model: "contribution" }),
    );
    return segment;
  }

  /**
   * Ingest a code selection contributed from ANOTHER view of the session (the
   * reader's "Add to prompt →"). Same lifecycle as {@link contribute} — opens
   * the thread if armed, no-op when not — but emits the structured
   * `code-selection` event instead of pre-rendered text: how it reads in the
   * prompt is `composeIntent`'s decision, made at lowering time. Returns the
   * assigned marker (`code_N` — the chip's retraction handle), or undefined.
   */
  codeSelection(selection: CodeSelection): string | undefined {
    if (!this.armed || selection.text === "") {
      return undefined;
    }
    this.ensureThread("contribution");
    const marker = `code_${++this.codeCounter}`;
    this.emit(this.stamp({ type: "code-selection", marker, ...selection }));
    return marker;
  }

  /** Retract a code selection from the turn (the chip's ✕ — see the event doc). */
  dropCodeSelection(marker: string): void {
    this.emit(this.stamp({ type: "code-selection-drop", marker }));
  }

  /**
   * Events that give the next app selection its own stream position: once one
   * of these lands after the turn's last `app-selection`, a new snapshot is a
   * NEW selection (fresh marker, its own chip) rather than a refinement of
   * the last (same marker, the fold keeps the latest payload) — the rule that
   * lets the watcher track a drag without spamming chips.
   */
  private static isContentful(event: IntentEvent): boolean {
    return (
      event.type === "talk-start" ||
      event.type === "transcript-delta" ||
      (event.type === "transcript-final" && !event.correction) ||
      event.type === "stroke" ||
      event.type === "shot" ||
      event.type === "code-selection"
    );
  }

  /** The marker for the next app-selection: reuse the last one while nothing
   * contentful (or a drop) has intervened — see {@link Engine.isContentful}. */
  private nextSelectionMarker(): string {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === "thread-open") {
        break;
      }
      if (event.type === "app-selection") {
        if (event.marker !== undefined) {
          return event.marker; // a refinement of the same selection
        }
        break; // markerless (replayed pre-marker stream): start fresh
      }
      if (event.type === "app-selection-drop" || Engine.isContentful(event)) {
        break;
      }
    }
    return `sel_${++this.selCounter}`;
  }

  private emitAppSelection(selection: AppSelection): void {
    this.emit(
      this.stamp({ type: "app-selection", marker: this.nextSelectionMarker(), ...selection }),
    );
  }

  /**
   * Record an app selection mid-thread (the page selection changed while the
   * thread was open — tweak mode, correct mode, any live watcher update). A
   * positional stream event like text and shots: a NEW selection appends its
   * own chip; successive refinements with nothing contentful in between ride
   * the SAME marker (the fold keeps the latest — one chip tracking the drag).
   * The thread-open capture itself goes through {@link selectionProvider}.
   * No-op without an open thread — an app selection rides a turn, never
   * opens one.
   */
  appSelection(selection: AppSelection): boolean {
    if (!this.threadOpen || selection.text === "") {
      return false;
    }
    this.emitAppSelection(selection);
    return true;
  }

  /**
   * Retract one app selection (a chip's ✕ / a cleared watcher): the given
   * marker, or — when none is passed — the turn's most recent still-carried
   * selection. Returns false (emitting nothing) when there is no thread or
   * nothing left to retract.
   */
  appSelectionDrop(marker?: string): boolean {
    if (!this.threadOpen) {
      return false;
    }
    const target = marker ?? this.lastCarriedSelectionMarker();
    if (target === undefined) {
      return false;
    }
    this.emit(this.stamp({ type: "app-selection-drop", marker: target }));
    return true;
  }

  /** The marker of the turn's most recent app-selection not already dropped. */
  private lastCarriedSelectionMarker(): string | undefined {
    const dropped = new Set<string>();
    let candidate: string | undefined;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === "thread-open") {
        break;
      }
      if (event.type === "app-selection-drop" && event.marker !== undefined) {
        dropped.add(event.marker);
      } else if (
        event.type === "app-selection" &&
        event.marker !== undefined &&
        !dropped.has(event.marker)
      ) {
        candidate = event.marker;
        break;
      }
    }
    return candidate;
  }

  send(): void {
    if (this.threadOpen) {
      if (this.talking) {
        this.talkEnd();
      }
      this.closeThread("send");
      // Send ends the whole interaction, not just the thread: disarm, so the
      // surfaces (preview, HUD) put themselves away and a re-arm starts a
      // visibly fresh turn. Without this, the armed HUD + retained transcript
      // read as "nothing happened" after Enter.
      this.setArmed(false);
    }
  }

  private closeThread(reason: "send" | "cancel" | "timeout"): void {
    this.threadOpen = false;
    this.correctionTarget = undefined;
    this.emit(this.stamp({ type: "thread-close", reason }));
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // SUSPENDED during tweak (§B.5): the user handed the pointer/keyboard back
    // to the app on purpose — adjusting a slider is not "idle silence", and the
    // open turn must survive the excursion. No special resume plumbing needed:
    // leaving tweak emits a `mode` event, which re-runs this scheduler and
    // re-arms the timer naturally.
    if (this.settings.autoEndSec > 0 && this.threadOpen && !this.talking && this.mode !== "tweak") {
      this.idleTimer = setTimeout(() => {
        if (this.threadOpen && !this.talking) {
          this.closeThread("timeout");
        }
      }, this.settings.autoEndSec * 1000);
    }
  }

  // ── talk ───────────────────────────────────────────────────────────────────

  private talkStartedAt = 0;

  talkStart(): number | undefined {
    if (!this.armed || this.talking) {
      return undefined;
    }
    this.ensureThread("talk");
    this.talking = true;
    this.talkStartedAt = this.now();
    const segment = ++this.segmentCounter;
    this.emit(this.stamp({ type: "talk-start", segment }));
    return segment;
  }

  talkEnd(): void {
    if (!this.talking) {
      return;
    }
    this.talking = false;
    this.emit(
      this.stamp({
        type: "talk-end",
        segment: this.segmentCounter,
        ms: this.now() - this.talkStartedAt,
      }),
    );
  }

  transcriptDelta(segment: number, text: string): void {
    this.emit(this.stamp({ type: "transcript-delta", segment, text }));
  }

  transcriptFinal(segment: number, text: string, latencyMs: number, model: string): void {
    // A segment spoken in correct mode (or at a selected target) belongs to
    // the correction, not the content — flag it so composition excludes it.
    // It does NOT auto-submit: the spoken words land in the correction input
    // (where typing and talking coexist) and Enter is the single commit
    // gesture, so any lassoed target stays set until commit or dismissal.
    if (this.correctionTarget || this.mode === "correct") {
      this.emit(
        this.stamp({ type: "transcript-final", segment, text, latencyMs, model, correction: true }),
      );
      return;
    }
    this.emit(this.stamp({ type: "transcript-final", segment, text, latencyMs, model }));
  }

  // ── ink & shots ────────────────────────────────────────────────────────────

  strokeDone(points: number, bounds: Rect): void {
    this.ensureThread("ink");
    this.emit(this.stamp({ type: "stroke", points, bounds }));
  }

  inkCleared(auto: boolean): void {
    this.emit(this.stamp({ type: "ink-clear", auto }));
  }

  shotDone(
    rect: Rect,
    components: LocatedComponent[],
    thumb?: string,
    path?: string,
    viewport?: boolean,
  ): string {
    this.ensureThread("shot");
    // Identifier-shaped (underscore) so the marker doubles as an attachment id.
    const marker = `shot_${++this.shotCounter}`;
    this.emit(
      this.stamp({
        type: "shot",
        marker,
        rect,
        components,
        thumb,
        path,
        ...(viewport ? { viewport: true } : {}),
      }),
    );
    return marker;
  }

  /** Retract a shot from the turn (see the `shot-drop` event's doc). */
  dropShot(marker: string): void {
    this.emit(this.stamp({ type: "shot-drop", marker }));
  }

  /**
   * Toggle the realtime submode's screen share (V). Turning it *on* opens a
   * thread like any other contentful act — the share is a first act of the turn
   * — and either edge records a `video-share` event so the trace shows exactly
   * when the live model could see the screen. The client-side sampler
   * (video.ts) streams the frames; this verb only marks the boundaries.
   */
  videoShare(on: boolean): void {
    if (on) {
      this.ensureThread("shot");
    }
    this.emit(this.stamp({ type: "video-share", on }));
  }

  // ── corrections (the meta layer) ───────────────────────────────────────────

  /**
   * The correction micro-pipeline hook (set by main.ts): receives the target
   * + instruction, asks a Corrector for a patch, then calls
   * {@link correction} with the diff. Without a hook (unit tests), the
   * instruction becomes a plain replacement correction directly.
   */
  correctionPipeline?: (
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
  ) => void;

  setCorrectionTarget(target: CorrectionTarget | undefined): void {
    this.correctionTarget = target;
  }

  /** Route an instruction for a target into the pipeline (or straight through). */
  submitCorrection(target: CorrectionTarget, instruction: string, via: "speech" | "typed"): void {
    if (this.correctionPipeline) {
      this.correctionPipeline(target, instruction, via);
    } else {
      this.correction(target, instruction, via);
    }
  }

  /**
   * Undo the most recent still-active correction of the current thread (an
   * Escape in the correction box). Emits a `correction-undo` event — the
   * stream stays append-only; compose pops the correction from the applied
   * set. Returns false (and emits nothing) when there is nothing to undo,
   * which is the caller's cue to step out instead.
   */
  undoCorrection(): boolean {
    let start = -1;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === "thread-open") {
        start = i;
        break;
      }
    }
    let active = 0;
    for (const event of start === -1 ? this.events : this.events.slice(start)) {
      if (event.type === "correction") {
        active += 1;
      } else if (event.type === "correction-undo") {
        active -= 1;
      }
    }
    if (active <= 0) {
      return false;
    }
    this.emit(this.stamp({ type: "correction-undo" }));
    return true;
  }

  correction(
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
    diff?: { patch: string; model: string; latencyMs: number },
  ): void {
    this.emit(
      this.stamp({
        type: "correction",
        from: target.from,
        to: target.to,
        original: target.original,
        instruction,
        via,
        ...(target.scope !== undefined ? { scope: target.scope } : {}),
        patch: diff?.patch,
        model: diff?.model,
        latencyMs: diff?.latencyMs,
      }),
    );
  }

  /**
   * Rehydrate the stream from a recovered turn (HMR/reload turn recovery — see
   * the overlay's turn-store.ts). Replays each event through the current
   * listeners so UI surfaces (preview, HUD) rebuild and the modality re-opens
   * its socket, but WITHOUT re-stamping timestamps or arming idle timers (these
   * events already happened). Restores the id counters from the log so new
   * segments/shots can't collide with recovered ones, and leaves the engine
   * armed with the given thread state. Talking is never resumed (the recording
   * died with the page).
   */
  replay(
    events: IntentEvent[],
    state: { threadOpen: boolean; mode?: Mode } = { threadOpen: false },
  ): void {
    this.events = [];
    this.armed = true;
    this.talking = false;
    this.threadOpen = state.threadOpen;
    this.mode = state.mode ?? "ink";
    this.correctionTarget = undefined;
    let maxSegment = 0;
    let maxShot = 0;
    let maxSel = 0;
    let maxCode = 0;
    const ordinal = (marker: string, prefix: string): number => {
      const n = Number(marker.replace(prefix, ""));
      return Number.isFinite(n) ? n : 0;
    };
    for (const event of events) {
      this.events.push(event);
      const segment = (event as { segment?: unknown }).segment;
      if (typeof segment === "number") {
        maxSegment = Math.max(maxSegment, segment);
      }
      if (event.type === "shot") {
        maxShot = Math.max(maxShot, ordinal(event.marker, "shot_"));
      } else if (event.type === "app-selection" && event.marker !== undefined) {
        maxSel = Math.max(maxSel, ordinal(event.marker, "sel_"));
      } else if (event.type === "code-selection" && event.marker !== undefined) {
        maxCode = Math.max(maxCode, ordinal(event.marker, "code_"));
      }
      for (const listener of this.listeners) {
        listener(event, this);
      }
    }
    this.segmentCounter = maxSegment;
    this.shotCounter = maxShot;
    this.selCounter = maxSel;
    this.codeCounter = maxCode;
  }
}

// ── the first IR pass, pure ──────────────────────────────────────────────────

export interface ComposedItem {
  kind: "text" | "shot" | "code-selection" | "app-selection";
  text?: string;
  /** The item's stream identity (`shot_N` / `sel_N` / `code_N`) — absent for
   * text runs and for selections from pre-marker traces. */
  marker?: string;
  thumb?: string;
  path?: string;
  components?: LocatedComponent[];
  /** True for a whole-viewport shot (renders with no element metadata). */
  viewport?: boolean;
  /** A selection item's locator (`file:line:col` / `file:start-end`). */
  sourceLoc?: string;
  /** A code-selection item's line count. */
  lines?: number;
  /** An app-selection item's producing dataflow cell (`data-cell`). */
  cell?: string;
  /** An app-selection item's TeX source (selected rendered mathematics). */
  tex?: string;
}

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
   * as `[screenshot: <path> (elements: …)]` — path (relativized against
   * {@link ComposeOptions.cwd} when given), located elements, and their cell
   * frontier, all in the text where the image belongs. This replaced the
   * Option-C `{shot_n}` token + meta-map scheme: the indirection cost a hint
   * line and a metadata block the agent had to correlate, for structure
   * nothing downstream actually consumed (`meta` only ever became text
   * attributes on the rendered channel tag).
   */
  prompt: string;
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
   * How screenshots render in the body: an indented `<screenshot>` XML block
   * (default — Claude-family models attend reliably to tags, and it stays
   * human-readable), or the plain-text bracket block. See {@link renderShot}.
   */
  shotFormat?: "xml" | "text";
}

/**
 * Fold the current thread's events into the composed intent. Pure — the
 * inspector re-runs it on every event, which makes the pass's behavior
 * directly observable while you interact (and trivially unit-testable).
 *
 * Correction semantics under `replace`: each correction rewrites the *first*
 * remaining occurrence of its original text (ranges were lassoed against a
 * live preview; original-text anchoring survives earlier rewrites better
 * than absolute offsets). Under `note`, corrections append as instructions
 * for the downstream lowering model instead.
 */
export function composeIntent(
  events: IntentEvent[],
  policy: "replace" | "note" = "replace",
  options: ComposeOptions = {},
): ComposedIntent {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);

  // Retracted shots and selections (the preview's ✕) never reach the
  // composition — the events themselves stay in the stream, so the trace
  // still shows them. Drops are keyed by marker: each retracts exactly one.
  const droppedShots = new Set<string>();
  const droppedSelections = new Set<string>();
  const droppedCode = new Set<string>();
  for (const event of scope) {
    if (event.type === "shot-drop") {
      droppedShots.add(event.marker);
    } else if (event.type === "app-selection-drop" && event.marker !== undefined) {
      droppedSelections.add(event.marker);
    } else if (event.type === "code-selection-drop") {
      droppedCode.add(event.marker);
    }
  }

  const items: ComposedItem[] = [];
  const corrections: ComposedIntent["corrections"] = [];
  // App selections are POSITIONAL items, marker-keyed latest-wins: the first
  // event under a marker claims the stream position, and every re-emit under
  // the same marker (a refinement — the watcher tracking a drag) replaces the
  // payload in place. Markerless events (pre-marker traces) share one legacy
  // slot, reproducing the old single-selection latest-wins behavior.
  const LEGACY_SELECTION_KEY = "";
  const selectionByKey = new Map<string, ComposedItem>();
  for (const event of scope) {
    if (event.type === "transcript-final" && !event.correction) {
      // One item per segment, deliberately unmerged: segments-as-lines is the
      // document shape the correction patches (and the corrector model) see.
      items.push({ kind: "text", text: event.text });
    } else if (event.type === "app-selection") {
      if (event.marker !== undefined && droppedSelections.has(event.marker)) {
        continue;
      }
      const key = event.marker ?? LEGACY_SELECTION_KEY;
      const next: ComposedItem = {
        kind: "app-selection",
        text: event.text,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        ...(event.cell !== undefined ? { cell: event.cell } : {}),
        ...(event.tex !== undefined ? { tex: event.tex } : {}),
        ...(event.marker !== undefined ? { marker: event.marker } : {}),
      };
      const existing = selectionByKey.get(key);
      if (existing !== undefined) {
        items[items.indexOf(existing)] = next; // supersede in place
      } else {
        items.push(next);
      }
      selectionByKey.set(key, next);
    } else if (event.type === "app-selection-drop") {
      // Marker'd drops were pre-collected above; a markerless drop (pre-marker
      // traces) retracts the most recent still-carried selection.
      if (event.marker === undefined) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === "app-selection") {
            selectionByKey.delete(items[i].marker ?? LEGACY_SELECTION_KEY);
            items.splice(i, 1);
            break;
          }
        }
      }
    } else if (
      event.type === "code-selection" &&
      !(event.marker !== undefined && droppedCode.has(event.marker))
    ) {
      items.push({
        kind: "code-selection",
        text: event.text,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        lines: event.lines ?? event.text.split("\n").length,
        ...(event.marker !== undefined ? { marker: event.marker } : {}),
      });
    } else if (event.type === "shot" && !droppedShots.has(event.marker)) {
      items.push({
        kind: "shot",
        marker: event.marker,
        thumb: event.thumb,
        path: event.path,
        components: event.components,
        ...(event.viewport ? { viewport: true } : {}),
      });
    } else if (event.type === "correction") {
      corrections.push({
        original: event.original,
        instruction: event.instruction,
        applied: false,
        patch: event.patch,
        ...(event.scope !== undefined ? { scope: event.scope } : {}),
      });
    } else if (event.type === "correction-undo") {
      // Escape in the correction box: pop the most recent still-active
      // correction. Order matters — corrections apply sequentially, so only
      // LIFO undo keeps the remaining stack coherent.
      corrections.pop();
    }
  }

  if (policy === "replace" && corrections.length) {
    // Corrections are patches against the transcript-as-lines (one text run
    // per line — the same document shape the corrector model saw).
    const textIndexes = items
      .map((item, index) => (item.kind === "text" ? index : -1))
      .filter((index) => index !== -1);
    let lines = textIndexes.map((index) => items[index].text ?? "");
    for (const correction of corrections) {
      const result = applyCorrectionToLines(lines, correction);
      lines = result.lines;
      correction.applied = result.applied;
    }
    // Map lines back onto the interleave: 1:1 while both last, extra lines
    // append as a trailing run, vanished lines drop their runs.
    for (let k = 0; k < Math.min(lines.length, textIndexes.length); k++) {
      items[textIndexes[k]].text = lines[k];
    }
    if (lines.length > textIndexes.length) {
      items.push({ kind: "text", text: lines.slice(textIndexes.length).join(" ") });
    } else if (lines.length < textIndexes.length) {
      const dropped = new Set(textIndexes.slice(lines.length));
      for (let index = items.length - 1; index >= 0; index--) {
        if (dropped.has(index)) {
          items.splice(index, 1);
        }
      }
    }
  }

  const components = items.flatMap((item) => item.components ?? []);
  const transcript = items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join(" ")
    .trim();

  const promptParts: string[] = [];
  for (const item of items) {
    if (item.kind === "text" && item.text) {
      promptParts.push(item.text);
    } else if (item.kind === "shot" && item.marker) {
      promptParts.push(renderShot(item, options));
    } else if (item.kind === "code-selection") {
      promptParts.push(renderCodeSelection(item));
    } else if (item.kind === "app-selection") {
      promptParts.push(renderAppSelection(item));
    }
  }
  if (policy === "note") {
    for (const correction of corrections) {
      promptParts.push(`(transcription fix: "${correction.original}" → ${correction.instruction})`);
    }
  }

  return {
    transcript,
    items,
    corrections,
    components,
    prompt: promptParts.join(" ").trim(),
    meta: {},
  };
}

// ── selection rendering (the deferred decision) ──────────────────────────────

/** At or below this many characters a selection is inlined; above, fenced. */
export const SHORT_SELECTION_CHARS = 240;

/**
 * One contributed code selection, rendered at its position in the prose. The
 * short/long rule (formerly the bus host's `contributionToText`, now a compose
 * pass so the decision happens at LOWERING time): a **short** selection is
 * inlined — "Regarding `file:line`: `code`" — the location and the code right
 * in the sentence; a **long** one becomes a fenced block under its location
 * header, set apart from the prose like a multi-line screenshot block.
 */
function renderCodeSelection(item: ComposedItem): string {
  const text = item.text ?? "";
  const loc = item.sourceLoc !== undefined ? `\`${item.sourceLoc}\`` : "the selection";
  if (text.trim().length <= SHORT_SELECTION_CHARS) {
    return `Regarding ${loc}: \`${text.trim()}\``;
  }
  const n = item.lines ?? text.split("\n").length;
  return `\nRegarding ${loc} (${n} lines):\n\`\`\`\n${text}\n\`\`\`\n`;
}

/**
 * One on-screen (app) selection, rendered at its position in the prose — the
 * same short/long rule code selections use, worded for page text rather than
 * source: a **short** selection is inlined — `Regarding the on-screen
 * selection "…" (authored at file:line:col)` — and a **long** one becomes a
 * fenced block under the same header. The attribution parenthetical (the
 * authored-at locator, the producing cell, the TeX source of selected
 * mathematics) keeps the wording the context preamble used, now placed where
 * the selection actually sits in the stream. (The preamble path —
 * `selectionSections` in the channel's prompt-context — remains only for the
 * text modality's send-time `context` chunk.)
 */
function renderAppSelection(item: ComposedItem): string {
  const attribution: string[] = [];
  if (item.sourceLoc !== undefined) {
    attribution.push(`authored at ${item.sourceLoc}`);
  }
  if (item.cell !== undefined) {
    attribution.push(`produced by cell ${item.cell}`);
  }
  if (item.tex !== undefined) {
    attribution.push(`rendered mathematics — TeX source: ${item.tex}`);
  }
  const attr = attribution.length > 0 ? ` (${attribution.join("; ")})` : "";
  const text = (item.text ?? "").trim();
  if (text.length <= SHORT_SELECTION_CHARS) {
    return `Regarding the on-screen selection "${text}"${attr}`;
  }
  return `\nRegarding this on-screen selection${attr}:\n\`\`\`\n${text}\n\`\`\`\n`;
}

// ── shot rendering (the inline block) ────────────────────────────────────────

/** Cells listed per element before collapsing behind `cells-omitted`/"+N more". */
const MAX_CELLS_IN_PROMPT = 4;

/**
 * One shot, inlined as a block at its position in the prose. Two styles,
 * chosen by {@link ComposeOptions.shotFormat}:
 *
 * `"xml"` (the default — Claude-family models attend reliably to XML tags,
 * and the indented form stays perfectly readable for a human):
 *
 *   <screenshot path=".aiui-cache/traces/…/shot_1.png">
 *     <element name="Legend" source="src/Legend.tsx:30:2">
 *       <cell name="colorScale" source="src/Legend.tsx:41:8"/>
 *       <cell name="ticks"/>
 *     </element>
 *   </screenshot>
 *
 * `"text"` (the plain-prose alternative, same content):
 *
 *   [screenshot: .aiui-cache/traces/…/shot_1.png
 *     Legend @ src/Legend.tsx:30:2 — cells: colorScale @ src/Legend.tsx:41:8, ticks
 *   ]
 *
 * Everything is relativized against `cwd` — the image path *and* every
 * source location. Viewport shots render as a single self-closing tag /
 * one-liner with no element info by design; a `within` anchor (the drag
 * enclosed nothing) is marked so the agent knows it's context, not framing.
 */
function renderShot(item: ComposedItem, options: ComposeOptions): string {
  return (options.shotFormat ?? "xml") === "xml"
    ? renderShotXml(item, options.cwd)
    : renderShotText(item, options.cwd);
}

function renderShotXml(item: ComposedItem, cwd: string | undefined): string {
  const attrs: string[] = [];
  if (item.path) {
    attrs.push(`path="${escapeXml(relativizePath(item.path, cwd))}"`);
  } else {
    // No file on disk (capture denied/unavailable) — the reference still helps.
    attrs.push(`marker="${escapeXml(item.marker ?? "")}"`, `missing="image not captured"`);
  }
  if (item.viewport) {
    attrs.push(`view="full-viewport"`);
    return `<screenshot ${attrs.join(" ")}/>`;
  }
  const components = item.components ?? [];
  if (components.length === 0) {
    return `<screenshot ${attrs.join(" ")}/>`;
  }
  const lines = components.map((c) => {
    const el: string[] = [`name="${escapeXml(c.component)}"`];
    if (c.source && c.source !== "unknown") {
      el.push(`source="${escapeXml(relativizePath(c.source, cwd))}"`);
    }
    if (c.containment === "within") {
      el.push(`containment="within"`);
    }
    const cells = c.cells ?? [];
    if (cells.length > MAX_CELLS_IN_PROMPT) {
      el.push(`cells-omitted="${cells.length - MAX_CELLS_IN_PROMPT}"`);
    }
    if (cells.length === 0) {
      return `  <element ${el.join(" ")}/>`;
    }
    const kids = cells.slice(0, MAX_CELLS_IN_PROMPT).map((cell) => {
      const src = cell.source ? ` source="${escapeXml(relativizePath(cell.source, cwd))}"` : "";
      return `    <cell name="${escapeXml(cell.name)}"${src}/>`;
    });
    return [`  <element ${el.join(" ")}>`, ...kids, "  </element>"].join("\n");
  });
  // Multi-line blocks get a blank line's worth of separation from the prose
  // around them; the single-line forms (viewport, no elements) read fine
  // inline mid-sentence and stay there.
  return `\n${[`<screenshot ${attrs.join(" ")}>`, ...lines, "</screenshot>"].join("\n")}\n`;
}

function renderShotText(item: ComposedItem, cwd: string | undefined): string {
  const head = item.path
    ? `[screenshot: ${relativizePath(item.path, cwd)}`
    : `[screenshot ${item.marker} — image not captured`;
  if (item.viewport) {
    return `${head} (full viewport)]`;
  }
  const components = item.components ?? [];
  if (components.length === 0) {
    return `${head}]`;
  }
  const refs = components.map((c) => {
    const where = c.source && c.source !== "unknown" ? ` @ ${relativizePath(c.source, cwd)}` : "";
    const anchor = c.containment === "within" ? "within " : "";
    let ref = `  ${anchor}${c.component}${where}`;
    const cells = c.cells ?? [];
    if (cells.length > 0) {
      const shown = cells
        .slice(0, MAX_CELLS_IN_PROMPT)
        .map((cell) =>
          cell.source ? `${cell.name} @ ${relativizePath(cell.source, cwd)}` : cell.name,
        );
      const more = cells.length - MAX_CELLS_IN_PROMPT;
      ref += ` — cells: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
    }
    return ref;
  });
  // Same separation rule as the XML form: multi-line blocks stand apart.
  return `\n${[head, ...refs, "]"].join("\n")}\n`;
}

/**
 * Render a path relative to `cwd` when it lives under it; otherwise keep it
 * absolute (a path outside the agent's tree relativized would be a lie).
 * Works on `file:line:col` source locations too (prefix logic). Pure string
 * logic — this module stays browser-safe.
 */
function relativizePath(path: string, cwd: string | undefined): string {
  if (!cwd) {
    return path;
  }
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** Minimal XML attribute escaping (paths and names are attribute values). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
