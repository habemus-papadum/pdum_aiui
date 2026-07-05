/**
 * The transcript preview: a popup that shows what the machine thinks you said,
 * as you say it — streaming segment text with tiny inline screenshot thumbnails
 * at the position they were taken.
 *
 * Correct mode (E) is the meta layer: the popup expands and the transcript
 * becomes **selectable text**. Select the wrong words — ordinary text selection,
 * no special gesture — then speak the fix (auto-submits when the segment ends)
 * or type it. The correction micro-pipeline (correct.ts) turns {transcript,
 * selection, instruction} into a V4A patch; when it lands, the preview flashes
 * the inline word-diff (pink deletions / green additions) for a beat before
 * settling on the clean text.
 *
 * Graduated from the workbench. It renders into a light-DOM layer (not a shadow
 * root) precisely so native selection resolves against its text — the
 * hard-won reason correction uses `Selection` instead of a lasso (field-notes).
 */
import {
  applyCorrectionToLines,
  type DiffRun,
  type Engine,
  type IntentEvent,
  wordDiff,
} from "../intent-pipeline";

/** Fallback flash duration when config.diffFlashMs is unset. */
const DEFAULT_DIFF_FLASH_MS = 500;

interface Piece {
  kind: "text" | "shot";
  segment?: number;
  text?: string;
  final?: boolean;
  correction?: boolean;
  marker?: string;
  thumb?: string;
}

export class Preview {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly correctionBar: HTMLDivElement;
  private readonly correctionInput: HTMLInputElement;
  private readonly engine: Engine;
  private pieces: Piece[] = [];
  /** Per-text-piece diff runs, rendered during the post-correction flash. */
  private flash: Map<Piece, DiffRun[]> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private correcting = false;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.createElement("div");
    this.root.className = "mm-preview";
    this.root.innerHTML = `<div class="mm-preview-title">transcript</div>`;
    this.body = document.createElement("div");
    this.body.className = "mm-preview-body";
    this.root.append(this.body);

    this.correctionBar = document.createElement("div");
    this.correctionBar.className = "mm-correction-bar";
    this.correctionBar.style.display = "none";
    this.correctionInput = document.createElement("input");
    this.correctionInput.placeholder = "type the fix — or hold Space and say it";
    this.correctionBar.append(this.correctionInput);
    this.root.append(this.correctionBar);
    this.correctionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        const target = this.engine.correctionTarget;
        const instruction = this.correctionInput.value.trim();
        if (target && instruction) {
          this.engine.setCorrectionTarget(undefined);
          this.engine.submitCorrection(target, instruction, "typed");
          this.correctionInput.value = "";
          this.correctionBar.style.display = "none";
        }
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        this.engine.setCorrectionTarget(undefined);
        this.correctionBar.style.display = "none";
        this.render();
      }
    });

    // Ordinary text selection is the targeting gesture in correct mode.
    this.body.addEventListener("pointerup", () => {
      if (this.correcting) {
        // Let the browser finalize the selection first.
        setTimeout(() => this.captureSelection(), 0);
      }
    });

    engine.onEvent((event) => this.apply(event));
  }

  setCorrectMode(on: boolean): void {
    this.correcting = on;
    this.root.classList.toggle("correcting", on);
    if (!on) {
      this.correctionBar.style.display = "none";
      this.engine.setCorrectionTarget(undefined);
      this.render();
    }
  }

  // ── selection → correction target ──────────────────────────────────────────

  private captureSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!this.body.contains(range.startContainer) || !this.body.contains(range.endContainer)) {
      return;
    }
    const from = this.offsetOf(range.startContainer, range.startOffset);
    const to = this.offsetOf(range.endContainer, range.endOffset);
    if (from === undefined || to === undefined || to <= from) {
      return;
    }
    const original = this.renderedText().slice(from, to).trim();
    if (!original) {
      return;
    }
    selection.removeAllRanges(); // the highlight takes over from here
    this.engine.setCorrectionTarget({ from, to, original });
    this.correctionBar.style.display = "flex";
    this.correctionInput.focus();
    this.render();
  }

  /** Absolute offset (in renderedText space) of a point inside the body. */
  private offsetOf(node: Node, nodeOffset: number): number | undefined {
    const span = (node instanceof Element ? node : node.parentElement)?.closest?.(
      ".mm-seg",
    ) as HTMLElement | null;
    if (!span) {
      return undefined;
    }
    const base = Number(span.dataset.off ?? "0");
    let local = 0;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text === node) {
        local += nodeOffset;
        break;
      }
      local += text.textContent?.length ?? 0;
    }
    return base + local;
  }

  // ── event stream → pieces ───────────────────────────────────────────────────

  private apply(event: IntentEvent): void {
    switch (event.type) {
      case "thread-open":
        this.pieces = [];
        break;
      case "thread-close":
        if (event.reason !== "send") {
          this.pieces = [];
        }
        break;
      case "transcript-delta": {
        const piece = this.textPiece(event.segment);
        piece.text = event.text;
        break;
      }
      case "transcript-final": {
        const piece = this.textPiece(event.segment);
        piece.text = event.text;
        piece.final = true;
        piece.correction = event.correction;
        if (event.correction) {
          // The spoken fix becomes a correction event; it isn't content.
          this.pieces = this.pieces.filter((p) => p !== piece);
        }
        break;
      }
      case "correction":
        this.applyCorrection(event);
        this.correctionBar.style.display = "none";
        break;
      case "shot":
        this.pieces.push({ kind: "shot", marker: event.marker, thumb: event.thumb });
        break;
      default:
        break;
    }
    this.render();
  }

  private textPiece(segment: number): Piece {
    let piece = this.pieces.find((p) => p.kind === "text" && p.segment === segment);
    if (!piece) {
      piece = { kind: "text", segment, text: "" };
      this.pieces.push(piece);
    }
    return piece;
  }

  /** Apply the patch to the pieces and stage the pink/green flash. */
  private applyCorrection(event: Extract<IntentEvent, { type: "correction" }>): void {
    if (this.engine.settings.correctionPolicy !== "replace") {
      return;
    }
    const textPieces = this.pieces.filter((p) => p.kind === "text");
    const before = textPieces.map((p) => p.text ?? "");
    const { lines, applied } = applyCorrectionToLines(before, event);
    if (!applied) {
      return;
    }
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
        text: lines.slice(textPieces.length).join(" "),
        final: true,
      };
      this.pieces.push(extra);
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
      this.render();
    }, this.engine.settings.diffFlashMs ?? DEFAULT_DIFF_FLASH_MS);
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  private render(): void {
    this.body.replaceChildren();
    const target = this.engine.correctionTarget;
    let offset = 0;
    for (const piece of this.pieces) {
      if (piece.kind === "shot") {
        if (piece.thumb) {
          const img = document.createElement("img");
          img.src = piece.thumb;
          img.className = "mm-thumb";
          img.title = piece.marker ?? "";
          this.body.append(img);
        } else {
          const chip = document.createElement("span");
          chip.className = "mm-thumb-chip";
          chip.textContent = `📷 ${piece.marker}`;
          this.body.append(chip);
        }
        continue;
      }
      const text = piece.text ?? "";
      const span = document.createElement("span");
      span.className = piece.final ? "mm-seg final" : "mm-seg";
      span.dataset.off = String(offset);
      const runs = this.flash?.get(piece);
      if (runs) {
        // The flash view: deletions struck pink, additions green.
        for (const run of runs) {
          const part = document.createElement("span");
          part.className = run.kind === "same" ? "" : `mm-diff-${run.kind}`;
          part.textContent = `${run.text} `;
          span.append(part);
        }
      } else if (target && target.from < offset + text.length && target.to > offset) {
        const from = Math.max(0, target.from - offset);
        const to = Math.min(text.length, target.to - offset);
        span.append(document.createTextNode(text.slice(0, from)));
        const mark = document.createElement("mark");
        mark.textContent = text.slice(from, to);
        span.append(mark);
        span.append(document.createTextNode(text.slice(to)));
      } else {
        span.textContent = text;
      }
      this.body.append(span);
      this.body.append(document.createTextNode(" "));
      offset += text.length + 1; // the joining space
    }
    this.body.scrollTop = this.body.scrollHeight;
  }

  /** All rendered text, in the same offset space selections resolve into. */
  private renderedText(): string {
    return this.pieces
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join(" ");
  }
}
