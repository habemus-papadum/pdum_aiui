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
import { renderPrompt } from "./render";
import type {
  AppSelection,
  CodeSelection,
  ComposedIntent,
  ComposedItem,
  ComposeOptions,
  IntentEvent,
  LocatedComponent,
  Mode,
  Rect,
  ShotShare,
  TabRecord,
  TranscriptWord,
} from "./types";

export type EngineListener = (event: IntentEvent, engine: Engine) => void;

export class Engine {
  readonly settings: IntentPipelineConfig;
  events: IntentEvent[] = [];
  armed = false;
  mode: Mode = "ink";
  talking = false;
  threadOpen = false;

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

  /** Subscribe to every emitted event. Returns an unsubscribe (hosts whose
   * panels outlive engines — the side panel — must detach; a host whose
   * listeners share the page's lifetime may ignore it). */
  onEvent(listener: EngineListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) {
        this.listeners.splice(i, 1);
      }
    };
  }

  /**
   * Merge a server-produced LINTER event (a note / tool call / result) into
   * the stream. Advisory only: `composeIntent` skips every `linter-*` kind,
   * so ingestion changes the preview's chips and the trace — never the
   * prompt. A lint that arrives after its thread closed is dropped (nothing
   * to advise on anymore).
   */
  ingestLinter(
    event: Extract<
      IntentEvent,
      { type: "linter-note" | "linter-tool-call" | "linter-tool-result" }
    >,
  ): void {
    if (!this.threadOpen) {
      return;
    }
    this.emit(event);
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
    }
    this.emit(this.stamp({ type: "armed", on }));
  }

  /**
   * EXPLICITLY open a turn — the side panel's ⌘B (§13.6: a host where nothing
   * opens implicitly; an implicit-turn host never calls this — its turns open
   * on the first contentful act). No-op unless armed; no-op when a
   * thread is already open. Returns whether a thread is open after the call.
   */
  openTurn(): boolean {
    if (!this.armed) {
      return false;
    }
    this.ensureThread("explicit");
    return this.threadOpen;
  }

  setMode(mode: Mode): void {
    if (!this.armed || mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.emit(this.stamp({ type: "mode", mode }));
  }

  /** Esc, one level at a time: tweak → ink, ink+thread → cancel, → disarm. */
  stepOut(): void {
    if (this.mode !== "ink") {
      this.setMode("ink");
      return;
    }
    if (this.threadOpen) {
      if (this.talking) {
        // Symmetric with send()/setArmed(false): a cancel mid-hold ends the
        // talk too, so `talking` can never outlive its thread — a stuck
        // talking flag made the NEXT gesture flush into the void and toast
        // "transcription needs the channel" on a perfectly healthy channel.
        this.talkEnd();
      }
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

  private ensureThread(trigger: "talk" | "ink" | "shot" | "contribution" | "explicit"): void {
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
   * Replace a segment's transcript WHOLESALE (see the `segment-replace`
   * event's doc): the panel's segment editor speaks this after the user fixes
   * bad STT or pastes text. `words` are the editor's best-effort re-timestamped
   * word timings — they are what lets the compiler REFLOW anchored shots
   * against the new text. No-op when not armed, like every content verb.
   */
  replaceSegment(segment: number, text: string, words?: TranscriptWord[]): void {
    if (!this.armed || !text) {
      return;
    }
    this.emit(
      this.stamp({
        type: "segment-replace",
        segment,
        text,
        ...(words !== undefined ? { words } : {}),
      }),
    );
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
   *
   * With no thread open: an *armed* engine opens one (the extension panel's
   * pull model — "add selection" is a deliberate act, as contentful as a
   * contribution). Ambient watcher updates must not open turns: those callers
   * (the intent client's ambient watcher) pre-filter on `threadOpen`
   * themselves. Unarmed
   * remains a no-op.
   */
  appSelection(selection: AppSelection): boolean {
    if (selection.text === "") {
      return false;
    }
    if (!this.threadOpen) {
      if (!this.armed) {
        return false;
      }
      this.ensureThread("contribution");
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

  send(options: { keepArmed?: boolean } = {}): void {
    if (this.threadOpen) {
      if (this.talking) {
        this.talkEnd();
      }
      this.closeThread("send");
      // Send ends the whole interaction, not just the thread: disarm, so the
      // surfaces (preview, HUD) put themselves away and a re-arm starts a
      // visibly fresh turn. Without this, the armed HUD + retained transcript
      // read as "nothing happened" after Enter. The extension opts OUT
      // (`keepArmed` — §13.6: send keeps you armed; ⌘B starts the next turn).
      if (!options.keepArmed) {
        this.setArmed(false);
      }
    }
  }

  private closeThread(reason: "send" | "cancel" | "timeout"): void {
    this.threadOpen = false;
    this.emit(this.stamp({ type: "thread-close", reason }));
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // SUSPENDED during tweak: the user handed the pointer/keyboard back to
    // the app on purpose — that excursion is not "idle silence", and the open
    // turn must survive it. No special resume plumbing needed: leaving the
    // mode emits a `mode` event, which re-runs this scheduler and re-arms the
    // timer naturally.
    const excursion = this.mode === "tweak";
    if (this.settings.autoEndSec > 0 && this.threadOpen && !this.talking && !excursion) {
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

  transcriptFinal(
    segment: number,
    text: string,
    latencyMs: number,
    model: string,
    words?: TranscriptWord[],
  ): void {
    // (The event's `correction` flag survives in the type for historical
    // traces; nothing sets it since correct mode was removed — append-only.)
    this.emit(
      this.stamp({
        type: "transcript-final",
        segment,
        text,
        latencyMs,
        model,
        ...(words !== undefined && words.length > 0 ? { words } : {}),
      }),
    );
  }

  // ── ink & shots ────────────────────────────────────────────────────────────

  strokeDone(points: number, bounds: Rect): void {
    this.ensureThread("ink");
    this.emit(this.stamp({ type: "stroke", points, bounds }));
  }

  inkCleared(auto: boolean, reason?: "navigation"): void {
    this.emit(this.stamp({ type: "ink-clear", auto, ...(reason !== undefined ? { reason } : {}) }));
  }

  /**
   * Record a same-document navigation (the intent client's navigation
   * watcher). A
   * navigation is context riding a turn, never a turn opener — the
   * `app-selection` rule — so this is a no-op without an open thread. Returns
   * whether an event was recorded.
   */
  navigation(
    from: string,
    to: string,
    kind?: "push" | "replace" | "traverse" | "reload" | "hash",
    /** The destination tab's full record, when the watcher gathered one. */
    tab?: TabRecord,
  ): boolean {
    if (!this.threadOpen) {
      return false;
    }
    this.emit(
      this.stamp({
        type: "navigation",
        from,
        to,
        ...(kind !== undefined ? { kind } : {}),
        ...(tab !== undefined ? { tab } : {}),
      }),
    );
    return true;
  }

  /**
   * Record a tab boundary — the user looked at a different tab mid-turn. A
   * sibling of {@link navigation} (same rule: context riding a turn, a no-op
   * without an open thread), but its own event so the lowering can say "you
   * switched tabs" and carry the two tab identities. Returns whether an event
   * was recorded.
   */
  tabSwitch(
    from: string,
    to: string,
    fromTab?: number,
    toTab?: number,
    /** The destination tab's full record, when the host gathered one. */
    tab?: TabRecord,
  ): boolean {
    if (!this.threadOpen) {
      return false;
    }
    this.emit(
      this.stamp({
        type: "tab-switch",
        from,
        to,
        ...(fromTab !== undefined ? { fromTab } : {}),
        ...(toTab !== undefined ? { toTab } : {}),
        ...(tab !== undefined ? { tab } : {}),
      }),
    );
    return true;
  }

  shotDone(
    rect: Rect,
    components: LocatedComponent[],
    thumb?: string,
    path?: string,
    viewport?: boolean,
    takenAt?: number,
    /** Set by the share's sampler; absent for a deliberate S / D-drag. */
    share?: ShotShare,
    /** `"paste"` when the pixels came from the clipboard, not the screen. */
    origin?: "paste",
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
        // The GESTURE's wall-clock (see the event doc) — capture is async, so
        // this event's own `at` trails the moment the user actually shot.
        ...(takenAt !== undefined ? { takenAt } : {}),
        ...(share !== undefined ? { share } : {}),
        ...(origin !== undefined ? { origin } : {}),
      }),
    );
    return marker;
  }

  /** Retract a shot from the turn (see the `shot-drop` event's doc). */
  dropShot(marker: string): void {
    this.emit(this.stamp({ type: "shot-drop", marker }));
  }

  /**
   * Rehydrate the stream from a recovered turn (HMR/reload turn recovery —
   * the intent client's reload path). Replays each event through the current
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

// ── the compiler: composeIntent and its passes ─────────────────────────────
// (ComposedItem / ComposedIntent / ComposeOptions moved to ./types; the
//  item→text renderer is ./render — see renderPrompt, imported below.)

/**
 * Fold the current thread's events into the composed intent. Pure — the
 * inspector re-runs it on every event, which makes the behavior directly
 * observable while you interact (and trivially unit-testable).
 *
 * Structured as a MULTI-PASS lowering (owner, 2026-07-14 — "as if you're a
 * compiler engineer"), each pass a named function over an explicit IR:
 *
 *  1. **scan** — one walk over the stream collecting every stream-wide fact
 *     later passes consult ({@link StreamFacts}): drops, talk windows, delta
 *     timelines, word timestamps, and segment REPLACEMENTS (latest-wins,
 *     respecting deletes — the segment editor's `segment-replace`).
 *  2. **place** — append items in stream order. A replaced segment's text is
 *     superseded IN PLACE: the item sits where the segment's first placer
 *     (its final, normally) sits, carrying the replacement text.
 *  3. **corrections** — the spoken-correction patches against the
 *     transcript-as-lines (unchanged semantics; `replace` policy only).
 *  4. **interleave** — the timestamp reflow: anchored shots move INSIDE
 *     their segment's text, split at word-timestamp offsets. Replacements
 *     reflow here for free: their re-timestamped words landed in
 *     {@link StreamFacts.wordsBySegment} during the scan.
 *  5. **render** — transcript + the lowered prompt body.
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

  const facts = scanStream(scope);
  const { items, corrections } = placeItems(scope, facts, options);
  applyCorrectionsPass(items, corrections, policy);
  interleavePass(items, facts);
  return renderPrompt(items, corrections, policy, options);
}

/**
 * Pass 1's IR: every stream-wide fact the later passes consult. One walk
 * builds it; nothing after the scan re-reads the raw stream for facts.
 */
interface StreamFacts {
  /** Retracted markers (the preview's ✕) — the place pass skips them. */
  droppedShots: Set<string>;
  droppedSelections: Set<string>;
  droppedCode: Set<string>;
  /** Each segment's talk window (wall-clock bounds) — the interleave's map
   * from a shot's `takenAt` to its segment. */
  windows: Map<number, { start: number; end?: number }>;
  /** Each segment's `transcript-delta` timeline — (arrival, cumulative
   * length) samples the interleave's fallback anchoring reads. */
  deltaTimelines: Map<number, Array<{ at: number; len: number }>>;
  /** Streaming mode: the latest cumulative delta text per segment. */
  lastDeltaText: Map<number, string>;
  /** Segments whose provisional run is superseded (a final arrived — or a
   * replacement did: an edited segment is definitionally not in flight). */
  finalizedSegments: Set<number>;
  /** Segments that have a REAL final in scope (place-position bookkeeping:
   * a replacement places at its segment's first final when one exists). */
  finalsInScope: Set<number>;
  /** Word-level timestamps per segment, latest-wins — the PRECISE interleave
   * anchor. A replacement's re-timestamped words land here, which is what
   * makes the reflow of an edited segment free. */
  wordsBySegment: Map<number, TranscriptWord[]>;
  /** The segment editor's replacements, latest-wins per segment. */
  replacements: Map<number, { text: string; words?: TranscriptWord[] }>;
}

/** Pass 1 — scan: one walk, all facts. */
function scanStream(scope: IntentEvent[]): StreamFacts {
  const facts: StreamFacts = {
    droppedShots: new Set(),
    droppedSelections: new Set(),
    droppedCode: new Set(),
    windows: new Map(),
    deltaTimelines: new Map(),
    lastDeltaText: new Map(),
    finalizedSegments: new Set(),
    finalsInScope: new Set(),
    wordsBySegment: new Map(),
    replacements: new Map(),
  };
  for (const event of scope) {
    if (event.type === "shot-drop") {
      facts.droppedShots.add(event.marker);
    } else if (event.type === "app-selection-drop" && event.marker !== undefined) {
      facts.droppedSelections.add(event.marker);
    } else if (event.type === "code-selection-drop") {
      facts.droppedCode.add(event.marker);
    } else if (event.type === "talk-start") {
      facts.windows.set(event.segment, { start: event.at });
    } else if (event.type === "talk-end") {
      const window = facts.windows.get(event.segment);
      if (window !== undefined) {
        window.end = event.at;
      }
    } else if (event.type === "transcript-delta") {
      const timeline = facts.deltaTimelines.get(event.segment) ?? [];
      timeline.push({ at: event.at, len: event.text.length });
      facts.deltaTimelines.set(event.segment, timeline);
      facts.lastDeltaText.set(event.segment, event.text);
    } else if (event.type === "transcript-final") {
      if (!event.correction) {
        facts.finalizedSegments.add(event.segment);
        facts.finalsInScope.add(event.segment);
      }
      if (event.words !== undefined) {
        facts.wordsBySegment.set(event.segment, event.words);
      }
    } else if (event.type === "segment-replace") {
      // Latest-wins per segment. Words supersede the transcriber's (they
      // re-anchor the interleave); absent words keep the originals — the
      // old anchors are still the best approximation available.
      facts.replacements.set(event.segment, {
        text: event.text,
        ...(event.words !== undefined ? { words: event.words } : {}),
      });
      if (event.words !== undefined) {
        facts.wordsBySegment.set(event.segment, event.words);
      }
      facts.finalizedSegments.add(event.segment);
    }
  }
  return facts;
}

/** Pass 2 — place: items in stream order (replacements supersede in place). */
function placeItems(
  scope: IntentEvent[],
  facts: StreamFacts,
  options: ComposeOptions,
): { items: ComposedItem[]; corrections: ComposedIntent["corrections"] } {
  const items: ComposedItem[] = [];
  const corrections: ComposedIntent["corrections"] = [];
  // App selections are POSITIONAL items, marker-keyed latest-wins: the first
  // event under a marker claims the stream position, and every re-emit under
  // the same marker (a refinement — the watcher tracking a drag) replaces the
  // payload in place. Markerless events (pre-marker traces) share one legacy
  // slot, reproducing the old single-selection latest-wins behavior.
  const LEGACY_SELECTION_KEY = "";
  const selectionByKey = new Map<string, ComposedItem>();
  /** Streaming mode: segments whose provisional run is already in `items`. */
  const provisionalPlaced = new Set<number>();
  /** Replaced segments already placed (first placer wins the position). */
  const replacedPlaced = new Set<number>();

  /** The one text item a replaced segment gets, wherever its first placer
   * sits. Returns true when it placed (or already had) the item. */
  const placeReplaced = (segment: number): boolean => {
    const replacement = facts.replacements.get(segment);
    if (replacement === undefined) {
      return false;
    }
    if (!replacedPlaced.has(segment)) {
      replacedPlaced.add(segment);
      items.push({ kind: "text", text: replacement.text, segment });
    }
    return true;
  };

  for (const event of scope) {
    if (event.type === "transcript-delta") {
      // The words still being spoken, as ONE run claiming the stream position
      // of the segment's first delta — so a shot taken mid-utterance composes
      // after it and the interleave below can split it. Later deltas mutate
      // that run's text rather than appending rows. Nothing here runs unless
      // the caller asked for it, and a finalized segment ignores it entirely:
      // the final's own item is the truth.
      if (!options.streaming || facts.finalizedSegments.has(event.segment)) {
        continue;
      }
      const text = facts.lastDeltaText.get(event.segment) ?? "";
      if (provisionalPlaced.has(event.segment) || text.trim() === "") {
        continue;
      }
      provisionalPlaced.add(event.segment);
      items.push({ kind: "text", text, segment: event.segment, provisional: true });
    } else if (event.type === "transcript-final" && !event.correction) {
      // One item per segment, deliberately unmerged: segments-as-lines is the
      // document shape the correction patches (and the corrector model) see.
      // A REPLACED segment's text supersedes here, in this final's position.
      if (!placeReplaced(event.segment)) {
        items.push({ kind: "text", text: event.text, segment: event.segment });
      }
    } else if (event.type === "segment-replace") {
      // Normally the segment's final placed it already (above). A replacement
      // for a segment with NO final in scope (an edited contribution whose
      // final fell out of the window) places at its own stream position.
      if (!facts.finalsInScope.has(event.segment)) {
        placeReplaced(event.segment);
      }
    } else if (event.type === "app-selection") {
      if (event.marker !== undefined && facts.droppedSelections.has(event.marker)) {
        continue;
      }
      const key = event.marker ?? LEGACY_SELECTION_KEY;
      const next: ComposedItem = {
        kind: "app-selection",
        text: event.text,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        ...(event.cell !== undefined ? { cell: event.cell } : {}),
        ...(event.cellLoc !== undefined ? { cellLoc: event.cellLoc } : {}),
        ...(event.tex !== undefined ? { tex: event.tex } : {}),
        ...(event.url !== undefined ? { url: event.url } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
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
      // Marker'd drops were pre-collected in the scan; a markerless drop
      // (pre-marker traces) retracts the most recent still-carried selection.
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
      !(event.marker !== undefined && facts.droppedCode.has(event.marker))
    ) {
      items.push({
        kind: "code-selection",
        text: event.text,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        ...(event.url !== undefined ? { url: event.url } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
        lines: event.lines ?? event.text.split("\n").length,
        ...(event.marker !== undefined ? { marker: event.marker } : {}),
      });
    } else if (event.type === "navigation") {
      // A positional boundary: everything composed before it happened on
      // `from`, everything after on `to`. Rendering is the compiler's call
      // (renderNavigation, in ./render) — the event travels structured.
      items.push({
        kind: "navigation",
        from: event.from,
        to: event.to,
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
      });
    } else if (event.type === "tab-switch") {
      // The sibling boundary: a different TAB, not the same tab navigating.
      // Same positional attribution; renderTabSwitch (in ./render) phrases it as a switch.
      items.push({
        kind: "tab-switch",
        from: event.from,
        to: event.to,
        ...(event.fromTab !== undefined ? { fromTab: event.fromTab } : {}),
        ...(event.toTab !== undefined ? { toTab: event.toTab } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
      });
    } else if (event.type === "shot" && !facts.droppedShots.has(event.marker)) {
      items.push({
        kind: "shot",
        marker: event.marker,
        thumb: event.thumb,
        path: event.path,
        components: event.components,
        ...(event.viewport ? { viewport: true } : {}),
        ...(event.takenAt !== undefined ? { takenAt: event.takenAt } : {}),
        ...(event.share !== undefined ? { share: event.share } : {}),
        ...(event.origin !== undefined ? { origin: event.origin } : {}),
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
  return { items, corrections };
}

/** Pass 3 — spoken-correction patches against the transcript-as-lines. */
function applyCorrectionsPass(
  items: ComposedItem[],
  corrections: ComposedIntent["corrections"],
  policy: "replace" | "note",
): void {
  if (policy !== "replace" || corrections.length === 0) {
    return;
  }
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

/**
 * Pass 4 — the timestamp interleave: place anchored shots INSIDE their
 * segment's text. A shot taken mid-window used to compose BEFORE that
 * segment's entire text (finals arrive late; position was arrival order).
 * With `takenAt` (the gesture's wall-clock) and the segment's delta
 * timeline, the compiler — the ONLY place allowed to reorder the
 * accumulator — splits the segment's text at the offset the deltas had
 * reached when the shot was taken, nudged to a word boundary. Fallbacks are
 * byte-identical to the old behavior: no takenAt (legacy streams), no
 * matching talk window (an idle shot), or no deltas for the segment → the
 * shot keeps its arrival position.
 *
 * Under `streaming` this runs against the PROVISIONAL run too, so a shot
 * lands in the live transcript as it is taken. The offset is stable as the
 * text grows: `deltaOffsetAt` reads the cumulative length at `takenAt + lag`,
 * and later deltas are all past that instant, so they extend the tail rather
 * than push the shot along.
 *
 * Deltas TRAIL speech by the transcriber's latency, so a naive
 * takenAt-vs-arrival comparison lands the split systematically EARLY —
 * the words you had already spoken at the gesture hadn't arrived yet
 * (observed ~1 s off in practice). {@link deltaLagEstimate} compensates
 * with a per-segment estimate measured from data the stream already
 * carries. Honest scope note: this is a research area, not a solved
 * problem — the estimate is coarse (see the helper's doc), and the right
 * long-term anchor is probably audio-time-aligned transcription.
 */
function interleavePass(items: ComposedItem[], facts: StreamFacts): void {
  const { windows, deltaTimelines, wordsBySegment } = facts;
  const anchoredShots = new Map<number, ComposedItem[]>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "shot" || item.takenAt === undefined) {
      continue;
    }
    const segment = segmentContaining(windows, item.takenAt);
    if (segment === undefined || !deltaTimelines.has(segment)) {
      continue;
    }
    if (!items.some((t) => t.kind === "text" && t.segment === segment)) {
      continue; // the segment never produced text — nothing to split
    }
    items.splice(i, 1);
    anchoredShots.set(segment, [item, ...(anchoredShots.get(segment) ?? [])]);
  }
  if (anchoredShots.size === 0) {
    return;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const target = items[i];
    if (target.kind !== "text" || target.segment === undefined) {
      continue;
    }
    const shots = anchoredShots.get(target.segment);
    if (shots === undefined) {
      continue;
    }
    const text = target.text ?? "";
    const timeline = deltaTimelines.get(target.segment) ?? [];
    const lag = deltaLagEstimate(windows.get(target.segment), timeline);
    const words = wordsBySegment.get(target.segment);
    const windowStart = windows.get(target.segment)?.start;
    // Oldest shot first; each split offset is nudged to the end of the word
    // it lands in (and past a sentence end just ahead), so a screenshot
    // never interrupts a word — and rarely a sentence. Word timestamps,
    // when present, anchor exactly; the delta-timeline lag estimate is the
    // fallback.
    const placed: ComposedItem[] = [];
    // A provisional run stays provisional on both sides of the split — the
    // preview renders every run of a still-streaming segment dim, whether or
    // not a screenshot cut it in two.
    const run = (text: string): ComposedItem => ({
      kind: "text",
      text,
      segment: target.segment,
      ...(target.provisional ? { provisional: true } : {}),
    });
    let consumed = 0;
    for (const shot of shots.sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0))) {
      const exact =
        words !== undefined && windowStart !== undefined
          ? wordOffsetAt(text, words, windowStart, shot.takenAt ?? 0)
          : undefined;
      const offset = nudgeToBoundary(
        text,
        exact ?? deltaOffsetAt(timeline, (shot.takenAt ?? 0) + lag),
      );
      const head = text.slice(consumed, Math.max(consumed, offset)).trim();
      if (head !== "") {
        placed.push(run(head));
      }
      placed.push(shot);
      consumed = Math.max(consumed, offset);
    }
    const tail = text.slice(consumed).trim();
    if (tail !== "") {
      placed.push(run(tail));
    }
    items.splice(i, 1, ...placed);
  }
}

// ── the timestamp interleave's pure helpers ──────────────────────────────────

/**
 * How long after a talk window closes a shot still anchors to that segment
 * (placed after its text). Finals arrive well after the release; without
 * this grace a shot taken in that gap composes BEFORE the words it followed
 * (the event beat the final into the stream).
 */
const POST_WINDOW_ANCHOR_GRACE_MS = 3000;

/**
 * The delta-lag fallback/ceiling, in ms. `at` stamps are wall-clock
 * milliseconds by wire contract, so absolute bounds are legitimate here.
 */
const DEFAULT_DELTA_LAG_MS = 800;
const MAX_DELTA_LAG_MS = 2000;

/** The segment whose talk window contains `at` — or whose window closed
 * within {@link POST_WINDOW_ANCHOR_GRACE_MS} before it (the latest match
 * wins; an in-window match beats a post-window one). */
function segmentContaining(
  windows: ReadonlyMap<number, { start: number; end?: number }>,
  at: number,
): number | undefined {
  let found: number | undefined;
  let trailing: number | undefined;
  for (const [segment, window] of windows) {
    if (at >= window.start && (window.end === undefined || at <= window.end)) {
      found = segment;
    } else if (
      window.end !== undefined &&
      at > window.end &&
      at - window.end <= POST_WINDOW_ANCHOR_GRACE_MS
    ) {
      trailing = segment;
    }
  }
  return found ?? trailing;
}

/**
 * Estimate how far this segment's deltas TRAILED the speech they
 * transcribe, from data the stream already carries. Two observable anchors:
 *
 *  - **tail** — the last words are spoken at the window close (talk-end);
 *    the delta carrying them arrives one speech→text latency later. Clean:
 *    no onset contamination.
 *  - **head** — speech starts around the window open; the first delta
 *    arrives one latency later. Contaminated by the user's speech-onset
 *    delay (and the transcriber's warm-up), so it OVERestimates.
 *
 * Prefer the tail when it is measurable (deltas usually straggle past the
 * release), fall back to the head, then to a fixed default; clamp to a sane
 * band. Research note (deliberately unsolved here): the right long-term
 * anchor is per-word audio-offset alignment, which no vendor exposes today.
 */
function deltaLagEstimate(
  window: { start: number; end?: number } | undefined,
  timeline: ReadonlyArray<{ at: number; len: number }>,
): number {
  const first = timeline[0]?.at;
  const last = timeline[timeline.length - 1]?.at;
  if (window === undefined || first === undefined || last === undefined) {
    return DEFAULT_DELTA_LAG_MS;
  }
  const tail = window.end !== undefined ? last - window.end : Number.NEGATIVE_INFINITY;
  const head = first - window.start;
  const measured = tail > 0 ? tail : head;
  if (measured <= 0) {
    return DEFAULT_DELTA_LAG_MS;
  }
  return Math.min(measured, MAX_DELTA_LAG_MS);
}

/**
 * The cumulative text length the segment's deltas had reached by `at` — the
 * split offset a shot taken at that moment anchors to. Deltas carry
 * CUMULATIVE text, so the last sample at-or-before `at` is the answer; no
 * sample yet → 0 (the shot precedes the segment's words).
 */
function deltaOffsetAt(timeline: ReadonlyArray<{ at: number; len: number }>, at: number): number {
  let len = 0;
  for (const sample of timeline) {
    if (sample.at > at) {
      break;
    }
    len = sample.len;
  }
  return len;
}

/**
 * The EXACT interleave anchor: how many characters of `text` had been SPOKEN
 * by wall-clock `at`, from the transcriber's word timestamps. A word's
 * startMs is relative to the segment's first audio sample (the talk-start
 * instant, `windowStart`); the offset is the length of the words spoken
 * strictly before `at`, located against `text` by matching the words in
 * order (vendor word text and the final text can differ in spacing — the
 * search is per-word, tolerant). Undefined when no word carries a timestamp
 * (the caller falls back to the delta-timeline estimate).
 */
function wordOffsetAt(
  text: string,
  words: ReadonlyArray<TranscriptWord>,
  windowStart: number,
  at: number,
): number | undefined {
  let offset: number | undefined;
  let cursor = 0;
  for (const word of words) {
    if (word.startMs === undefined || word.text.trim() === "") {
      continue;
    }
    const found = text.indexOf(word.text, cursor);
    if (found === -1) {
      continue; // final text diverged from this word — keep aligning on the rest
    }
    if (windowStart + word.startMs > at) {
      return offset ?? 0; // this word was spoken after the gesture
    }
    cursor = found + word.text.length;
    offset = cursor;
  }
  return offset;
}

/** How far past the word end the boundary nudge will reach for a sentence
 * end. Small on purpose: snapping a shot past a whole clause would move it
 * further from the gesture than the latency error it exists to absorb. */
const SENTENCE_SNAP_CHARS = 24;

/**
 * Advance an offset to the end of the word it lands in (never split a
 * word) — and, when a sentence ends within {@link SENTENCE_SNAP_CHARS}
 * ahead, on past it: dictation pauses (and shots) cluster at sentence
 * boundaries, so the nearby period is more often the true seam than the
 * mid-sentence word the latency math landed on. Forward-only — never pull
 * a shot before words already spoken.
 */
function nudgeToBoundary(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  if (offset >= text.length) {
    return text.length;
  }
  let i = offset;
  while (i < text.length && !/\s/.test(text[i])) {
    i++;
  }
  // Already standing on a sentence seam? Stop. The lookahead below exists to
  // finish the sentence the gesture landed INSIDE — never to skip over a whole
  // one, which would carry the shot further from the gesture than the latency
  // error the nudge absorbs. (An offset landing exactly after "…a demo." would
  // otherwise swallow the next short sentence whole.)
  if (/[.!?]["')\]]?$/.test(text.slice(0, i))) {
    return i;
  }
  const ahead = text.slice(i, i + SENTENCE_SNAP_CHARS);
  const sentence = ahead.match(/^(.*?[.!?]["')\]]?)(\s|$)/);
  if (sentence !== null) {
    return i + sentence[1].length;
  }
  return i;
}
