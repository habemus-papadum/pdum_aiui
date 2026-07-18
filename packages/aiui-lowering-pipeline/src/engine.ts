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
import type {
  AppSelection,
  CodeSelection,
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
