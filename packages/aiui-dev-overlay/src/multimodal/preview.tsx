/**
 * The transcript preview: a popup that shows what the machine thinks you said,
 * as you say it — streaming segment text with tiny inline screenshot thumbnails
 * at the position they were taken.
 *

 * Correct mode (E) is a two-box editor over the turn:
 *
 *  - **The top box edits ONE text chunk** — a contiguous run of segments with
 *    no shot in between (the last chunk by default; a picker switches when
 *    there are several). The rendered transcript stays visible above it, so
 *    screenshots never disappear and corrector diffs still flash inline.
 *    Click for a caret, type, select; dictation with the caret here inserts
 *    at the caret. Direct edits become locally-patched `correction` events at
 *    boundaries (send/commit/chunk-switch), so the composed prompt always
 *    includes them and abort can take them back like any other diff.
 *  - **The bottom box is for replacement instructions only** — "curve", or
 *    "it's Vite, not beat". A selection in the TOP box at send time is the
 *    marked span; none → the instruction addresses the whole transcript. To
 *    *insert* text, don't instruct — click the top box and type it.
 *  - **Enter in the bottom box**: with an instruction → send it (the box
 *    clears, "applying fix…" shows, the patch's diff flashes when it lands);
 *    empty → done, commit the edit session and return to ink. Enter in the
 *    top box is just a newline — it's an editor.
 *  - **Escape (anywhere in correct mode) aborts the whole edit**: every diff
 *    applied this session — corrector patches and manual edits alike — is
 *    undone (as real `correction-undo` stream events, so the lowered prompt
 *    agrees), and you're back in ink where you started.
 *
 * Graduated from the workbench. It renders into a light-DOM layer (not a shadow
 * root) precisely so native selection resolves against its text — the
 * hard-won reason correction uses `Selection` instead of a lasso (field-notes).
 *
 * Rendering split (proposal B2.3): the event stream still folds into a plain
 * `Piece[]` on the class (the pure reducer, unchanged), but the transcript
 * BODY is Solid-rendered — a keyed `<For>` over the pieces, so a streaming
 * delta updates one text node instead of rebuilding every span. Signals live
 * INSIDE the render root (Solid 2 signals created outside never propagate —
 * see ui/widget.tsx's WidgetApi pattern); the class writes them from stream
 * events via {@link Preview.publish}. Everything editable stays an imperative
 * island exactly as before — the chunk editor with its caret seeding, the
 * correction bar and its live zone, the chunk picker, the hover peek, and
 * every commit/wait/flash timer keep their own state and clocks (the
 * animation doctrine: Solid renders structure; islands own their time).
 */
import { createFocusTracker } from "@habemus-papadum/aiui-viz/modal";
import { render } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, untrack } from "solid-js";
import {
  applyCorrectionToLines,
  type CorrectionTarget,
  type DiffRun,
  type Engine,
  type IntentEvent,
  wordDiff,
} from "../intent-pipeline";
import { isExtension, LiveDiffText, renderRuns, SETTLE_FLASH_MS } from "./diff-flash";

/** Fallback flash duration when config.diffFlashMs is unset — the house
 * discrete-revision tempo, shared via the modal kit. */
const DEFAULT_DIFF_FLASH_MS = SETTLE_FLASH_MS;

/**
 * How long Enter waits for an in-flight spoken segment's transcript before
 * committing with what's typed. REST transcription lands well inside this;
 * the ceiling keeps an offline channel from wedging the commit.
 */
const COMMIT_SPEECH_WAIT_MS = 4000;

/**
 * The spinner's ceiling: how long "applying fix…" may show before giving up.
 * The correction pipeline's own fallback (plain replacement at 8 s) normally
 * beats this — the ceiling only exists so the bar can never spin forever.
 */
const CORRECTION_APPLY_WAIT_MS = 10_000;

/**
 * The modality's talk plumbing, lent to the correction bar so listening can be
 * hands-free while it is open (see the module doc). All optional — a bare
 * Preview (tests, lab) works keyboard-only.
 */
export interface CorrectionVoiceHooks {
  /** Open the mic / start a talk segment (the bar just opened). */
  start?: () => void;
  /** End the in-flight segment (Enter commits it; Esc discards it). */
  stop?: () => void;
  /** Whether a segment is live right now (Enter decides whether to wait). */
  talking?: () => boolean;
  /**
   * Whether the CURRENT segment has actually heard voice. Hands-free listening
   * keeps a segment open almost continuously, so `talking` alone can't tell
   * "just spoke an instruction" (Enter should wait for its transcript) from
   * "sitting in silence" (an empty-box Enter should commit, not wedge on a
   * transcript that will never come).
   */
  heard?: () => boolean;
}

interface Piece {
  kind: "text" | "shot" | "code-selection" | "app-selection";
  /**
   * The keyed-`<For>` identity: `text:<segment>` / `shot:<marker>` /
   * `sel:<marker>` / `code:<marker>` (and `text:patch:<seq>` for lines a
   * patch introduced). Stable for the piece's whole life, so its DOM row
   * persists across stream events — the point of the Solid port. An
   * app-selection refinement re-emitted under the SAME marker updates its
   * piece in place: one chip at one position, tracking the drag.
   */
  key: string;
  segment?: number;
  text?: string;
  final?: boolean;
  correction?: boolean;
  marker?: string;
  thumb?: string;
  /** A selection piece's locator (`file:line:col` / `file:start-end`). */
  sourceLoc?: string;
  /** A code-selection piece's line count. */
  lines?: number;
}

/**
 * The imperative seam into the render root: plain setters over signals
 * created INSIDE the component (see the module doc). `tick` is the stream
 * clock — every published change bumps it, and the body's derived views
 * (per-piece text, flash runs, the mark window, the editing highlight)
 * re-read the class state under it; memo equality keeps untouched pieces'
 * DOM writes at zero.
 */
interface PreviewViewApi {
  setPieces(next: Piece[]): void;
  tick(): void;
}

export class Preview {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly correctionBar: HTMLDivElement;
  private readonly correctionInput: HTMLTextAreaElement;
  private readonly engine: Engine;
  private readonly voice: CorrectionVoiceHooks;
  private pieces: Piece[] = [];
  /** Uniquifier for pieces without a natural key (patch-added lines, markerless
   * selections from pre-marker streams). */
  private pieceSeq = 0;
  /** Per-text-piece diff runs, rendered during the post-correction flash.
   * Island state, NOT a signal: the settle timer below owns its clock and the
   * render root only re-reads it on {@link publish}'s tick. */
  private flash: Map<Piece, DiffRun[]> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private correcting = false;
  /** Enter pressed while a spoken segment was still in flight — send when
   * its transcript lands (or {@link COMMIT_SPEECH_WAIT_MS} gives up). */
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The correction bar's streaming-speech line (see the constructor). */
  private readonly correctionLiveHost: HTMLDivElement;
  private readonly correctionLive: LiveDiffText;
  /** The "applying fix…" spinner line, shown between send and the patch landing. */
  private readonly waitHost: HTMLDivElement;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Escape's undo stack: one entry per applied correction, holding what the
   * pieces looked like *before* it. LIFO — Esc pops back one diff at a time,
   * animated, all the way to the original document. Cleared when correct mode
   * (or the thread) ends; the matching stream-level truth is the
   * `correction-undo` event (see engine.undoCorrection).
   */
  private undoStack: Array<{
    order: Piece[];
    texts: Map<Piece, string | undefined>;
    added: Piece[];
  }> = [];
  /** The hover enlargement/peek, when one is up (fixed-position, body-attached). */
  private peek: HTMLElement | undefined;
  /** Correct mode's chunk editor (the rendered body stays visible above it). */
  private readonly editArea: HTMLTextAreaElement;
  /** The chunk picker row (visible only when the turn has >1 text chunk). */
  private readonly chunkPicker: HTMLDivElement;
  /** Which text chunk the editor holds; -1 = the last (the default). */
  private editChunk = -1;
  /** Which box last held focus — where a dictated final folds in. Tracked
   * state, never a DOM query (the kit's rule: activeElement lies during
   * transitions — focus steals, blur-before-click ordering). */
  private readonly focus = createFocusTracker<"top" | "bottom">("bottom");
  /** Corrections applied during THIS correct-mode session (abort undoes them all). */
  private sessionCorrections = 0;
  /** Setters captured from inside the render root (see {@link PreviewViewApi}). */
  private readonly view: PreviewViewApi;
  private readonly disposeRender: () => void;

  constructor(engine: Engine, voice: CorrectionVoiceHooks = {}) {
    this.engine = engine;
    this.voice = voice;
    this.root = document.createElement("div");
    this.root.className = "mm-preview";
    this.root.innerHTML = `<div class="mm-preview-title">transcript</div>`;
    this.body = document.createElement("div");
    this.body.className = "mm-preview-body";
    this.root.append(this.body);
    const { view, dispose } = this.mountBody();
    this.view = view;
    this.disposeRender = dispose;

    // Correct mode's chunk editor. It deliberately holds ONE contiguous run
    // of text (a "chunk" — consecutive segments with no shot between them),
    // not the whole document: structured content never enters a textarea, so
    // screenshots stay visible in the rendered body above, and a manual edit
    // is always a clean lines→lines patch over one chunk.
    this.chunkPicker = document.createElement("div");
    this.chunkPicker.className = "mm-chunk-picker";
    this.chunkPicker.style.display = "none";
    this.chunkPicker.addEventListener("click", (e) => {
      const chip = (e.target as Element | null)?.closest("[data-chunk]");
      if (chip) {
        this.selectChunk(Number(chip.getAttribute("data-chunk")));
      }
    });
    this.root.append(this.chunkPicker);
    this.editArea = document.createElement("textarea");
    this.editArea.className = "mm-edit-area";
    this.editArea.style.display = "none";
    this.editArea.addEventListener("focus", () => {
      this.focus.set("top");
    });
    this.editArea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.abortEdit();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.correctionInput.focus();
      }
      // Enter is a newline here — the top box is an editor, not a command line.
    });
    this.root.append(this.editArea);

    this.correctionBar = document.createElement("div");
    this.correctionBar.className = "mm-correction-bar";
    this.correctionBar.style.display = "none";
    // The live zone: streamed speech renders here (with revision flashes) while
    // you talk, then folds into the textarea on the segment's final — so the
    // stream never fights the caret in the editable field.
    this.correctionLiveHost = document.createElement("div");
    this.correctionLiveHost.className = "mm-correction-live";
    this.correctionBar.append(this.correctionLiveHost);
    this.correctionLive = new LiveDiffText(this.correctionLiveHost);
    // A textarea, not an input: typing and talking coexist here, so the field
    // must behave like a real editor — Shift+Enter newlines, arrows, spaces
    // (Space is NOT a talk gesture in the bar; the mic is already live).
    this.correctionInput = document.createElement("textarea");
    this.correctionInput.rows = 2;
    this.correctionInput.placeholder =
      "type or say a fix — Enter applies it · empty Enter finishes · Esc undoes the last fix";
    this.correctionBar.append(this.correctionInput);
    this.waitHost = document.createElement("div");
    this.waitHost.className = "mm-correction-wait";
    this.waitHost.hidden = true;
    this.waitHost.textContent = "applying fix…";
    this.correctionBar.append(this.waitHost);
    this.root.append(this.correctionBar);
    this.correctionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); // Shift+Enter keeps the default newline
        e.stopPropagation();
        this.onEnter();
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        // Esc aborts the WHOLE edit session — every applied diff undone.
        this.abortEdit();
      }
      if (e.key === "Tab") {
        e.preventDefault(); // Tab hops to the document editor (and back)
        e.stopPropagation();
        this.editArea.focus();
      }
    });
    this.correctionInput.addEventListener("focus", () => {
      this.focus.set("bottom");
    });

    engine.onEvent((event) => this.apply(event));
  }

  setCorrectMode(on: boolean): void {
    if (on === this.correcting) {
      return; // renderHud calls this on every event — entry work must run once
    }
    this.correcting = on;
    this.root.classList.toggle("correcting", on);
    if (on) {
      // Enter the editor: the rendered transcript (with its thumbnails) stays
      // visible; below it, the LAST text chunk opens for editing (the picker
      // switches chunks), then the instruction box, focused and listening.
      this.sessionCorrections = 0;
      this.editChunk = -1;
      this.editArea.style.display = "block";
      this.seedEditArea();
      this.correctionBar.style.display = "flex";
      this.correctionInput.focus();
      this.focus.set("bottom");
      if (!this.voice.talking?.()) {
        this.voice.start?.();
      }
      return;
    }
    // Leaving by any route other than the bar's own gestures (E toggled,
    // disarm): manual edits are kept — fold them in before tearing down.
    if (this.correctionBar.style.display !== "none") {
      this.syncManualEdits();
      this.teardownBar();
    } else {
      this.publish();
    }
  }

  // ── the correction bar's lifecycle ───────────────────────────────────────
  // Three commands (the interaction pattern):
  //  1. Enter with an instruction → SEND it: the box clears, the spinner shows,
  //     the patch comes back and flashes its diff (bar stays open for more).
  //  2. Enter with an empty box (not spinning) → DONE: commit the whole edit
  //     session and return to ink.
  //  3. Escape → UNDO the last applied diff (animated), one per press, back to
  //     the original document; with nothing left to undo, it backs out.

  private onEnter(): void {
    if (!this.waitHost.hidden) {
      return; // a fix is still applying — Enter waits its turn
    }
    if (this.correctionInput.value.trim() === "") {
      // Empty box: commit — UNLESS the live segment has actually heard voice,
      // in which case the words just haven't transcribed yet and Enter means
      // "send what I said". (`talking` alone can't discriminate: hands-free
      // listening keeps a silent segment open the whole time the bar is up.)
      const spokeSomething = (this.voice.talking?.() ?? false) && (this.voice.heard?.() ?? false);
      if (!spokeSomething) {
        this.commitEdit();
        return;
      }
    }
    // The corrector must see the document as edited — fold manual edits into
    // the stream first (they apply instantly, as a locally-built patch).
    this.syncManualEdits();
    this.requestSend();
  }

  /** Send now, or — with a spoken segment still in flight — end it first and
   * send once its transcript has landed in the input. */
  private requestSend(): void {
    if (this.voice.talking?.()) {
      this.voice.stop?.();
      this.commitTimer ??= setTimeout(() => {
        this.commitTimer = undefined;
        this.sendNow(); // transcript never came — send what's typed
      }, COMMIT_SPEECH_WAIT_MS);
      return;
    }
    this.sendNow();
  }

  private sendNow(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    // The marked span, if any, is whatever is selected in the TOP box right
    // now; none → an EMPTY span, the corrector prompt's whole-document
    // description mode. (Sending the full text as the "selected span" taught
    // the model inverted semantics — "keep the first sentence" deleted it —
    // and made patches huge and fragile.)
    // Every fix is scoped to the ACTIVE CHUNK: the corrector model sees only
    // its lines, and "replace across everything" means across this chunk —
    // never across an image boundary into text the user isn't looking at.
    const scope = this.selectedChunkWindow();
    let target: CorrectionTarget | undefined;
    const selStart = this.editArea.selectionStart ?? 0;
    const selEnd = this.editArea.selectionEnd ?? 0;
    if (selEnd > selStart) {
      const original = this.editArea.value.slice(selStart, selEnd).trim();
      if (original !== "") {
        target = { from: selStart, to: selEnd, original, ...(scope ? { scope } : {}) };
      }
    }
    if (!target && this.editArea.value.trim() !== "") {
      target = { from: 0, to: 0, original: "", ...(scope ? { scope } : {}) };
    }
    const instruction = this.correctionInput.value.trim();
    this.correctionInput.value = "";
    this.correctionLive.clear();
    if (target && instruction) {
      this.startWaiting();
      this.engine.submitCorrection(target, instruction, "typed");
    }
    // The bar stays open (more fixes may follow) and listening resumes.
    if (this.correcting && !this.voice.talking?.()) {
      this.voice.start?.();
    }
    this.correctionInput.focus();
  }

  /** Empty-box Enter: done — keep everything, back to where the turn was. */
  private commitEdit(): void {
    this.syncManualEdits();
    this.teardownBar();
    this.engine.setMode("ink"); // no-ops if something already moved us
  }

  /**
   * Escape: abort the WHOLE edit session. Every diff applied since correct
   * mode opened — corrector patches and manual edits alike — is undone via
   * real `correction-undo` events (each animating its restore), then the
   * editor tears down and the mode returns to ink. Un-synced typing in the
   * top box is simply discarded with the teardown.
   */
  abortEdit(): void {
    let remaining = this.sessionCorrections;
    while (remaining > 0 && this.engine.undoCorrection()) {
      remaining -= 1;
    }
    this.teardownBar();
    this.engine.setMode("ink");
  }

  private teardownBar(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    this.stopWaiting();
    this.undoStack = [];
    this.sessionCorrections = 0;
    this.voice.stop?.(); // an in-flight segment's late transcript is dropped
    this.correctionInput.value = "";
    this.correctionLive.clear();
    this.correctionBar.style.display = "none";
    this.editArea.style.display = "none";
    this.chunkPicker.style.display = "none";
    this.publish();
  }

  // ── the top box: one text chunk as an editable textarea ────────────────────
  // A chunk is a contiguous run of text pieces (segments across any number of
  // pauses/Space presses) with no shot in between. Editing chunk-at-a-time
  // sidesteps rich-document editing entirely: shots never vanish into a
  // textarea, and every manual edit is a clean lines→lines patch that stays
  // inside one chunk.

  /** Contiguous runs of text pieces, split by shots. */
  private textChunks(): Piece[][] {
    const chunks: Piece[][] = [];
    let current: Piece[] = [];
    for (const piece of this.pieces) {
      if (piece.kind === "text") {
        current.push(piece);
      } else if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  /** The selected chunk index, clamped (-1 and out-of-range → the last). */
  private selectedChunkIndex(): number {
    const count = this.textChunks().length;
    if (count === 0) {
      return -1;
    }
    return this.editChunk >= 0 && this.editChunk < count ? this.editChunk : count - 1;
  }

  /** The pieces of the chunk under edit ([] when the turn has no text yet). */
  private selectedChunk(): Piece[] {
    const index = this.selectedChunkIndex();
    return index === -1 ? [] : this.textChunks()[index];
  }

  /**
   * The active chunk's window over the transcript's TEXT-ITEM line sequence
   * ([fromLine, toLine)) — the coordinates `composeIntent`'s docLines use, so
   * a correction scoped here means the same lines on both sides of the wire.
   */
  private selectedChunkWindow(): { fromLine: number; toLine: number } | undefined {
    const chunks = this.textChunks();
    const index = this.selectedChunkIndex();
    if (index === -1) {
      return undefined;
    }
    let fromLine = 0;
    for (let i = 0; i < index; i++) {
      fromLine += chunks[i].length;
    }
    return { fromLine, toLine: fromLine + chunks[index].length };
  }

  /** Switch the editor to another chunk (folding pending edits first). */
  private selectChunk(index: number): void {
    if (index === this.selectedChunkIndex()) {
      return;
    }
    this.syncManualEdits(); // a chunk switch is a boundary, like send/commit
    this.editChunk = index;
    this.seedEditArea();
    this.editArea.focus();
  }

  /** The selected chunk's lines into the editor, preserving the caret. */
  private seedEditArea(): void {
    const caret = this.editArea.selectionStart ?? 0;
    this.editArea.value = this.selectedChunk()
      .map((p) => p.text ?? "")
      .join("\n");
    const at = Math.min(caret, this.editArea.value.length);
    this.editArea.setSelectionRange(at, at);
    this.renderChunkPicker();
    this.publish(); // the body highlights the chunk under edit
  }

  /** One chip per chunk; hidden while the turn has fewer than two. */
  private renderChunkPicker(): void {
    const chunks = this.textChunks();
    if (!this.correcting || chunks.length < 2) {
      this.chunkPicker.style.display = "none";
      return;
    }
    this.chunkPicker.style.display = "flex";
    const active = this.selectedChunkIndex();
    this.chunkPicker.replaceChildren(
      ...chunks.map((chunk, i) => {
        const chip = document.createElement("span");
        chip.className = `mm-chunk-chip${i === active ? " active" : ""}`;
        chip.setAttribute("data-chunk", String(i));
        const words = (chunk[0]?.text ?? "").split(/\s+/).slice(0, 3).join(" ");
        chip.textContent = `${i + 1} · ${words}${words.length < (chunk[0]?.text ?? "").length ? "…" : ""}`;
        return chip;
      }),
    );
  }

  /**
   * Fold direct edits (typed or dictated into the top box) into the stream as
   * a locally-patched correction: one V4A hunk replacing the edited CHUNK's
   * lines (context-anchored, so it lands wherever the chunk sits in the
   * document), so the composed prompt includes manual edits and abort can
   * undo them exactly like corrector patches. No-ops when nothing changed, or
   * when the chunk has no text to patch (a patch can't create text ex nihilo).
   */
  private syncManualEdits(): void {
    const oldLines = this.selectedChunk().map((p) => p.text ?? "");
    if (oldLines.length === 0 || oldLines.every((l) => l === "")) {
      return;
    }
    const newLines = this.editArea.value.split("\n");
    if (oldLines.join("\n") === newLines.join("\n")) {
      return;
    }
    const patch = [
      "*** Begin Patch",
      "*** Update File: transcript",
      "@@",
      ...oldLines.map((l) => `-${l}`),
      ...newLines.map((l) => `+${l}`),
      "*** End Patch",
    ].join("\n");
    this.engine.correction({ from: 0, to: 0, original: "" }, "(manual edit)", "typed", {
      patch,
      model: "manual",
      latencyMs: 0,
    });
  }

  /** The spinner between sending an instruction and its patch landing. */
  private startWaiting(): void {
    this.waitHost.hidden = false;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
    }
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined;
      // The pipeline's own fallback (plain replacement) beats this in normal
      // operation; the ceiling only exists so the bar can't spin forever.
      this.stopWaiting();
    }, CORRECTION_APPLY_WAIT_MS);
  }

  private stopWaiting(): void {
    this.waitHost.hidden = true;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
  }

  /** Escape: restore the pieces to their pre-correction state, animated. */
  private undoLast(): void {
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }
    this.stopWaiting();
    this.flash ??= new Map();
    // Rebuild: the snapshot order (texts restored), plus anything the user
    // added after the correction (kept, in its current relative order), minus
    // the pieces the correction itself introduced.
    const added = new Set(entry.added);
    const later = this.pieces.filter((p) => !entry.order.includes(p) && !added.has(p));
    for (const piece of entry.order) {
      const oldText = entry.texts.get(piece);
      if (piece.kind === "text" && oldText !== undefined && oldText !== piece.text) {
        this.flash.set(piece, wordDiff(piece.text ?? "", oldText));
        piece.text = oldText;
      }
    }
    this.pieces = [...entry.order, ...later];
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.flash = undefined;
      this.publish();
    }, this.engine.settings.diffFlashMs ?? DEFAULT_DIFF_FLASH_MS);
    this.publish();
  }

  /** A dictated final folds into whichever box last held the caret. */
  private insertIntoCorrection(text: string): void {
    if (this.correctionBar.style.display === "none" || text === "") {
      return; // editor dismissed while the segment was in flight — drop it
    }
    const input = this.focus.last() === "top" ? this.editArea : this.correctionInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const sep = before !== "" && !/\s$/.test(before) ? " " : "";
    input.value = before + sep + text + input.value.slice(end);
    const caret = start + sep.length + text.length;
    input.setSelectionRange(caret, caret);
    input.focus();
  }

  // ── event stream → pieces ───────────────────────────────────────────────────

  private apply(event: IntentEvent): void {
    switch (event.type) {
      case "thread-open":
        this.pieces = [];
        break;
      case "thread-close":
        // Clear on EVERY close, send included. The transcript used to survive
        // a send, so the next arm resurrected the previous turn's text and
        // thumbs — reading as "my send did nothing". thread-open also clears,
        // but only fires on the first contentful act, one beat too late.
        this.pieces = [];
        this.undoStack = [];
        this.stopWaiting();
        break;
      case "app-selection": {
        // Marker-keyed, like the fold: a refinement under the same marker
        // updates its piece IN PLACE (the chip keeps its stream position and
        // the peek reads the fresh payload); a new marker appends a new chip.
        // Markerless events (pre-marker streams) share one latest-wins piece,
        // the legacy single-selection behavior.
        const key = `sel:${event.marker ?? "legacy"}`;
        const existing = this.pieces.find((p) => p.kind === "app-selection" && p.key === key);
        if (existing !== undefined) {
          existing.text = event.text;
          existing.sourceLoc = event.sourceLoc;
        } else {
          this.pieces.push({
            kind: "app-selection",
            key,
            text: event.text,
            ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
            ...(event.marker !== undefined ? { marker: event.marker } : {}),
          });
        }
        break;
      }
      case "app-selection-drop":
        if (event.marker !== undefined) {
          this.pieces = this.pieces.filter(
            (p) => !(p.kind === "app-selection" && p.marker === event.marker),
          );
        } else {
          // Markerless (pre-marker stream): retract the most recent chip.
          for (let i = this.pieces.length - 1; i >= 0; i--) {
            if (this.pieces[i].kind === "app-selection") {
              this.pieces.splice(i, 1);
              break;
            }
          }
        }
        break;
      case "code-selection":
        this.pieces.push({
          kind: "code-selection",
          key: `code:${event.marker ?? ++this.pieceSeq}`,
          text: event.text,
          ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
          lines: event.lines ?? event.text.split("\n").length,
          ...(event.marker !== undefined ? { marker: event.marker } : {}),
        });
        break;
      case "code-selection-drop":
        this.pieces = this.pieces.filter(
          (p) => !(p.kind === "code-selection" && p.marker === event.marker),
        );
        break;
      case "transcript-delta": {
        // Speech in correct mode streams into the bar's live zone, not the
        // transcript — the same routing rule as the final's correction flag
        // (target or not: the box is where correct-mode words belong).
        if (this.correcting && this.correctionBar.style.display !== "none") {
          this.correctionLive.update(event.text);
          return; // the live zone renders itself; no piece re-render needed
        }
        const piece = this.textPiece(event.segment);
        this.reviseText(piece, event.text);
        break;
      }
      case "transcript-final": {
        const piece = this.textPiece(event.segment);
        this.reviseText(piece, event.text);
        piece.final = true;
        piece.correction = event.correction;
        if (event.correction) {
          // Spoken in correct mode: not content — the words belong to the
          // bar. Insert at the caret (typing coexists), and if Enter already
          // fired, this is the transcript it was waiting on — send now.
          this.pieces = this.pieces.filter((p) => p !== piece);
          this.correctionLive.clear();
          this.insertIntoCorrection(event.text);
          if (this.commitTimer) {
            this.sendNow();
          }
        }
        break;
      }
      case "correction": {
        // The patch landed: apply to the pieces (the rendered body — visible
        // above the editor — flashes the diff inline), count it for abort,
        // refresh the chunk editor, and stop the spinner. The editor stays
        // open — more fixes may follow; empty-box Enter finishes.
        const applied = this.applyCorrection(event);
        if (applied && this.correcting) {
          this.sessionCorrections += 1;
          this.seedEditArea();
        }
        this.stopWaiting();
        break;
      }
      case "correction-undo":
        this.undoLast();
        if (this.correcting) {
          this.sessionCorrections = Math.max(0, this.sessionCorrections - 1);
          this.seedEditArea();
        }
        break;
      case "shot":
        this.pieces.push({
          kind: "shot",
          key: `shot:${event.marker}`,
          marker: event.marker,
          thumb: event.thumb,
        });
        break;
      case "shot-drop":
        this.pieces = this.pieces.filter((p) => !(p.kind === "shot" && p.marker === event.marker));
        break;
      default:
        break;
    }
    this.publish();
  }

  private textPiece(segment: number): Piece {
    let piece = this.pieces.find((p) => p.kind === "text" && p.segment === segment);
    if (!piece) {
      piece = { kind: "text", key: `text:${segment}`, segment, text: "" };
      this.pieces.push(piece);
    }
    return piece;
  }

  /**
   * Update a piece's text, flashing the word-diff when the new text *revises*
   * what was already shown (a streaming model rewriting its partial
   * hypothesis, or a final that disagrees with its last delta). Extensions —
   * the ordinary streaming case — never flash, or every delta would strobe.
   * Streaming revisions settle faster than correction-patch flashes: the next
   * delta is already coming.
   */
  private reviseText(piece: Piece, next: string): void {
    const before = piece.text ?? "";
    piece.text = next;
    if (before === "" || before === next || isExtension(before, next)) {
      return;
    }
    this.flash ??= new Map();
    this.flash.set(piece, wordDiff(before, next));
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    const settle = Math.min(450, this.engine.settings.diffFlashMs ?? DEFAULT_DIFF_FLASH_MS);
    this.flashTimer = setTimeout(() => {
      this.flash = undefined;
      this.publish();
    }, settle);
  }

  /** Apply the patch to the pieces and stage the pink/green flash. */
  private applyCorrection(event: Extract<IntentEvent, { type: "correction" }>): boolean {
    if (this.engine.settings.correctionPolicy !== "replace") {
      return false;
    }
    const textPieces = this.pieces.filter((p) => p.kind === "text");
    const before = textPieces.map((p) => p.text ?? "");
    const { lines, applied } = applyCorrectionToLines(before, event);
    if (!applied) {
      return false;
    }
    // Escape's undo entry: the pieces (and their texts) as they were before
    // this diff; `added` collects pieces the patch itself introduces below.
    const undoEntry = {
      order: [...this.pieces],
      texts: new Map(this.pieces.map((p) => [p, p.text])),
      added: [] as Piece[],
    };
    this.undoStack.push(undoEntry);
    this.flash = new Map();
    for (let i = 0; i < Math.min(textPieces.length, lines.length); i++) {
      if (before[i] !== lines[i]) {
        this.flash.set(textPieces[i], wordDiff(before[i], lines[i]));
      }
      textPieces[i].text = lines[i];
    }
    if (lines.length > textPieces.length) {
      const extra: Piece = {
        kind: "text",
        key: `text:patch:${++this.pieceSeq}`,
        text: lines.slice(textPieces.length).join(" "),
        final: true,
      };
      this.pieces.push(extra);
      undoEntry.added.push(extra);
      this.flash.set(extra, wordDiff("", extra.text ?? ""));
    } else if (lines.length < textPieces.length) {
      for (const gone of textPieces.slice(lines.length)) {
        this.pieces = this.pieces.filter((p) => p !== gone);
      }
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.flash = undefined;
      this.publish();
    }, this.engine.settings.diffFlashMs ?? DEFAULT_DIFF_FLASH_MS);
    return true;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  /** Drop the peek and the render root (the modality calls this on unmount). */
  dispose(): void {
    this.hidePeek();
    this.disposeRender();
  }

  /**
   * Push the class-held view-model into the render root's signals — the
   * Solid-era `render()`: one snapshot per stream event, DOM updates on the
   * next flush. Only called from stream events, timers, and user gestures
   * (never from inside the render root — writes in owned scopes throw).
   */
  private publish(): void {
    // A re-render can remove the hovered thumb; its peek would linger on the
    // body with no mouseleave to clear it (the old full-teardown render hid
    // it every event — keep that exact behavior).
    this.hidePeek();
    this.view.setPieces([...this.pieces]);
    this.view.tick();
  }

  /**
   * Mount the Solid body: a keyed `<For>` over the pieces. Each piece keeps
   * one DOM row for its whole life ({@link Piece.key}); per-row memos re-read
   * the class state on every {@link publish} tick but their equality gates
   * the DOM writes, so a streaming delta touches exactly one text node — the
   * point of the port (no more `replaceChildren` teardown per event).
   */
  private mountBody(): { view: PreviewViewApi; dispose: () => void } {
    let view: PreviewViewApi | undefined;
    const PreviewBody = () => {
      // Signals INSIDE the render root; the class writes through `view`.
      const [pieces, setPieces] = createSignal<Piece[]>([]);
      const [rev, setRev] = createSignal(0);
      view = { setPieces, tick: () => setRev((n) => n + 1) };

      // The lasso target (setCorrectionTarget emits no event — the mark
      // lands on the next stream tick, exactly as the old render did).
      const target = createMemo(() => {
        rev();
        return this.engine.correctionTarget;
      });
      // The chunk currently in the editor, highlighted while correcting.
      const editing = createMemo(() => {
        rev();
        pieces();
        return this.correcting ? new Set(this.selectedChunk()) : undefined;
      });
      // Per-text-piece offsets over the joined transcript (the mark window's
      // coordinates and the spans' data-off, spaces counted as before).
      const offsets = createMemo(() => {
        rev();
        const map = new Map<Piece, number>();
        let offset = 0;
        for (const piece of pieces()) {
          if (piece.kind === "text") {
            map.set(piece, offset);
            offset += (piece.text ?? "").length + 1; // the joining space
          }
        }
        return map;
      });
      // Follow the stream: pin the scroll after every published change
      // (effects run post-flush, when the DOM has the new content).
      createEffect(
        () => rev(),
        () => {
          this.body.scrollTop = this.body.scrollHeight;
        },
      );

      /** One streaming text segment: class/text/mark/flash all reactive. */
      const textRow = (piece: Piece) => {
        const text = createMemo(() => {
          rev();
          return piece.text ?? "";
        });
        const cls = createMemo(() => {
          rev();
          const base = piece.final ? "mm-seg final" : "mm-seg";
          // `editing` marks the chunk currently in the editor.
          return editing()?.has(piece) ? `${base} editing` : base;
        });
        const off = createMemo(() => offsets().get(piece) ?? 0);
        const runs = createMemo(() => {
          rev();
          return this.flash?.get(piece);
        });
        const content = () => {
          const flashRuns = runs();
          if (flashRuns) {
            // The flash view: deletions struck pink, additions green (shared
            // renderer — the same visual language as every other diff moment).
            return Array.from(renderRuns(flashRuns).childNodes);
          }
          const value = text();
          const t = target();
          const offset = off();
          if (t && t.from < offset + value.length && t.to > offset) {
            const from = Math.max(0, t.from - offset);
            const to = Math.min(value.length, t.to - offset);
            return [value.slice(0, from), <mark>{value.slice(from, to)}</mark>, value.slice(to)];
          }
          return value;
        };
        return (
          <>
            <span class={cls()} data-off={String(off())}>
              {content()}
            </span>{" "}
          </>
        );
      };

      return (
        <For each={pieces()} keyed={(piece) => piece.key}>
          {(item) => {
            // A deliberate one-shot read (hence untrack): identity per key
            // is stable — the reducer mutates pieces in place — so this row
            // callback runs once per piece's life and `kind` never changes.
            const piece = untrack(item);
            if (piece.kind === "shot") {
              return this.renderShot(piece);
            }
            if (piece.kind === "code-selection" || piece.kind === "app-selection") {
              // A minimal pill at the piece's stream position; the hover peek
              // (and the ✕) carry the substance. Built once per piece — an
              // app-selection refinement mutates the piece in place, and the
              // hover handlers read it fresh.
              return this.renderSelectionPiece(piece);
            }
            return textRow(piece);
          }}
        </For>
      );
    };
    const dispose = render(PreviewBody, this.body);
    if (!view) {
      throw new Error("preview body render did not capture its setters");
    }
    return { view, dispose };
  }

  /**
   * One shot in the transcript flow: the thumbnail (or the degraded no-pixels
   * chip), a hover **peek** (a fixed-position enlargement — the body is a
   * scroll container, so an absolutely-positioned child would clip), and a
   * hover **✕** that retracts the shot from the turn via {@link Engine.dropShot}
   * — took the wrong screenshot, remove it before sending. An imperative
   * island: built once per shot piece, its listeners live as long as its row.
   */
  private renderShot(piece: Piece): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "mm-thumb-wrap";
    if (piece.thumb) {
      const img = document.createElement("img");
      img.src = piece.thumb;
      img.className = "mm-thumb";
      img.title = piece.marker ?? "";
      wrap.append(img);
      wrap.addEventListener("mouseenter", () => this.showPeek(wrap, piece.thumb ?? ""));
      wrap.addEventListener("mouseleave", () => this.hidePeek());
    } else {
      const chip = document.createElement("span");
      chip.className = "mm-thumb-chip";
      chip.textContent = `📷 ${piece.marker}`;
      wrap.append(chip);
    }
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mm-thumb-x";
    drop.title = `remove ${piece.marker} from this turn`;
    drop.textContent = "✕";
    drop.addEventListener("click", (event) => {
      event.stopPropagation();
      this.hidePeek();
      if (piece.marker) {
        this.engine.dropShot(piece.marker);
      }
    });
    wrap.append(drop);
    return wrap;
  }

  /**
   * One selection — app or code — in the transcript flow: a MINIMAL pill (the
   * same footprint as a shot's degraded chip; glyph + marker distinguishes
   * the two kinds — `⌖ sel_1` on-screen, `⧉ code_1` from the reader), a hover
   * **peek** (the mm-thumb-peek pattern: a floating card with the source
   * location and the selected text, CSS-clamped — the full text stays in the
   * DOM and the title), and a hover **✕** (the mm-thumb-x pattern) that
   * retracts exactly THIS selection from the turn through the engine, so the
   * drop streams to the channel like a shot-drop. An imperative island built
   * once per piece; app-selection refinements mutate the piece in place and
   * every hover reads it fresh.
   */
  private renderSelectionPiece(piece: Piece): HTMLElement {
    const isCode = piece.kind === "code-selection";
    const wrap = document.createElement("span");
    wrap.className = "mm-thumb-wrap";
    const chip = document.createElement("span");
    chip.className = `mm-sel-chip ${isCode ? "mm-sel-code" : "mm-sel-app"}`;
    chip.textContent = `${isCode ? "⧉" : "⌖"} ${piece.marker ?? (isCode ? "code" : "sel")}`;
    const title = (): string =>
      piece.sourceLoc !== undefined
        ? `${piece.sourceLoc}\n${piece.text ?? ""}`
        : (piece.text ?? "");
    chip.title = title();
    wrap.append(chip);
    wrap.addEventListener("mouseenter", () => {
      chip.title = title(); // refreshed: a refinement may have superseded it
      this.showSelectionPeek(wrap, piece);
    });
    wrap.addEventListener("mouseleave", () => this.hidePeek());
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mm-thumb-x";
    drop.title = `remove this ${isCode ? "code selection" : "selection"} from this turn`;
    drop.textContent = "✕";
    drop.addEventListener("click", (event) => {
      event.stopPropagation();
      this.hidePeek();
      if (isCode) {
        if (piece.marker) {
          this.engine.dropCodeSelection(piece.marker);
        }
      } else {
        this.engine.appSelectionDrop(piece.marker);
      }
    });
    wrap.append(drop);
    return wrap;
  }

  private showPeek(anchor: HTMLElement, src: string): void {
    this.hidePeek();
    const peek = document.createElement("img");
    peek.className = "mm-thumb-peek";
    peek.src = src;
    this.placePeek(anchor, peek);
  }

  /** The selection peek: loc + full text, clamped by CSS (never JS-truncated). */
  private showSelectionPeek(anchor: HTMLElement, piece: Piece): void {
    this.hidePeek();
    const peek = document.createElement("div");
    peek.className = "mm-sel-peek";
    if (piece.sourceLoc !== undefined) {
      const loc = document.createElement("div");
      loc.className = "mm-sel-peek-loc";
      loc.textContent = piece.sourceLoc;
      peek.append(loc);
    }
    const text = document.createElement("div");
    text.className = "mm-sel-peek-text";
    text.textContent = piece.text ?? "";
    peek.append(text);
    this.placePeek(anchor, peek);
  }

  /** Fixed-position, body-attached — the body is a scroll container, so an
   * absolutely-positioned child would clip (the mm-thumb-peek lesson). */
  private placePeek(anchor: HTMLElement, peek: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    peek.style.left = `${Math.max(8, rect.left)}px`;
    peek.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    document.body.append(peek);
    this.peek = peek;
  }

  private hidePeek(): void {
    this.peek?.remove();
    this.peek = undefined;
  }
}
