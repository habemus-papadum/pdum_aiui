/**
 * The transcript preview — the **read-only render of the incremental
 * compiler's accumulator**.
 *
 * The compiler (`composeIntent`) folds the append-only event stream; at every
 * point it holds the current compiled content — the *prompt accumulator*.
 * This popup renders exactly that: `composeIntent(events).items`, re-derived
 * after every engine event, plus a **provisional tail** for the segment still
 * streaming (its `transcript-delta` text, rendered dim until the final
 * lands). What you see is what will be sent, by construction — the preview
 * and the committed prompt share one fold and can no longer disagree.
 *
 * Read-only on purpose (the append-only pivot): there is no editor, no
 * correction bar, no lasso — a correction is *spoken*, new content the
 * compiler reconciles. **Only the compiler may reorder** the accumulator
 * (e.g. a timestamp-nudged screenshot); this view just repaints what the
 * fold produced. The keyed `<For>` keeps one DOM row per item
 * (`text:<segment>` / `shot:<marker>` / `sel:<marker>` / `code:<marker>`),
 * so appends stream in and an item whose content changes updates its own
 * row.
 *
 * Interactive affordances that survive (they are stream events, not edits):
 * a shot thumbnail's hover peek and its ✕ (`shot-drop`), a selection pill's
 * peek and ✕ (`app-selection-drop` / `code-selection-drop`).
 *
 * Renders into a light-DOM layer (not a shadow root) so native selection
 * resolves against its text — you can copy from the transcript. Solid
 * renders structure; the peeks stay imperative islands (the animation
 * doctrine).
 */
import { render } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, untrack } from "solid-js";
import {
  type ComposedItem,
  composeIntent,
  type Engine,
  type IntentEvent,
} from "../intent-pipeline";
import { LiveDiffText } from "./diff-flash";

/** One rendered row of the accumulator: a composed item plus its stable key. */
interface Piece {
  item: ComposedItem;
  key: string;
  /** True for the provisional delta tail (streaming segment, no final yet). */
  provisional?: boolean;
  /** A linter note riding the stream (💡 chip) — never composed content. */
  linter?: { text: string; segment?: number };
}

/** The imperative seam into the render root (signals live INSIDE it). */
interface PreviewViewApi {
  setPieces(next: Piece[]): void;
}

/** A composed item's keyed-`<For>` identity (stable across re-folds). */
function keyOf(item: ComposedItem, index: number): string {
  switch (item.kind) {
    case "text":
      return item.segment !== undefined ? `text:${item.segment}` : `text:@${index}`;
    case "shot":
      return `shot:${item.marker ?? `@${index}`}`;
    case "app-selection":
      return `sel:${item.marker ?? `@${index}`}`;
    case "code-selection":
      return `code:${item.marker ?? `@${index}`}`;
  }
}

export class Preview {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly engine: Engine;
  /** Cumulative delta text per still-streaming segment (cleared on its final). */
  private readonly deltaTail = new Map<number, string>();
  /**
   * The latest fold's pieces by key. Every re-fold produces NEW item objects,
   * but the row islands are built once per key — they read the CURRENT item
   * through this map, so a superseding app-selection refinement (same
   * marker, fresh payload) shows fresh on the next hover.
   */
  private readonly latestByKey = new Map<string, Piece>();
  /** The hover enlargement/peek, when one is up (fixed-position, body-attached). */
  private peek: HTMLElement | undefined;
  /** Locally dismissed lint chips (the chip's ✕ — a view choice, no event). */
  private readonly dismissedLints = new Set<string>();
  private readonly view: PreviewViewApi;
  private readonly disposeRender: () => void;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.createElement("div");
    this.root.className = "mm-preview";
    this.root.innerHTML = `<div class="mm-preview-title">transcript</div>`;
    this.body = document.createElement("div");
    this.body.className = "mm-preview-body";
    this.root.append(this.body);
    const { view, dispose } = this.mountBody();
    this.view = view;
    this.disposeRender = dispose;
    engine.onEvent((event) => this.apply(event));
  }

  /** Fold one engine event into the delta-tail state, then re-derive. */
  private apply(event: IntentEvent): void {
    switch (event.type) {
      case "transcript-delta":
        this.deltaTail.set(event.segment, event.text);
        break;
      case "transcript-final":
        this.deltaTail.delete(event.segment);
        break;
      case "thread-open":
      case "thread-close":
        this.deltaTail.clear();
        this.dismissedLints.clear();
        break;
      default:
        break;
    }
    this.publish();
  }

  /**
   * The accumulator, as rendered pieces: the compiler's items (one fold —
   * the same call the send path makes) plus the provisional tail for any
   * segment still streaming deltas.
   */
  private derivePieces(): Piece[] {
    if (!this.engine.threadOpen) {
      return []; // the accumulator is per-turn; between turns it is empty
    }
    const items = composeIntent(this.engine.events, "replace").items;
    // Uniquify repeated keys: the compiler may split one segment's text
    // around a timestamp-anchored shot, yielding several text items for the
    // same segment — each occurrence gets its own stable row.
    const seen = new Map<string, number>();
    const pieces: Piece[] = items.map((item, index) => {
      const base = keyOf(item, index);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { item, key: n === 0 ? base : `${base}#${n}` };
    });
    // Provisional tails: streaming segments the fold has no final for yet.
    const finalized = new Set(
      items.filter((i) => i.kind === "text" && i.segment !== undefined).map((i) => i.segment),
    );
    for (const [segment, text] of this.deltaTail) {
      if (!finalized.has(segment) && text.trim() !== "") {
        pieces.push({
          item: { kind: "text", text, segment },
          key: `text:${segment}`,
          provisional: true,
        });
      }
    }
    // Linter notes: advisory chips the compiler never composes — appended
    // after the content (the lint is about the latest pause). Scanned from
    // the thread's events since the fold deliberately skips them.
    const events = this.engine.events;
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "thread-open") {
        start = i;
        break;
      }
    }
    for (let i = start; i < events.length; i++) {
      const event = events[i];
      if (event.type !== "linter-note") {
        continue;
      }
      const key = `lint:${event.at}:${i}`;
      if (this.dismissedLints.has(key)) {
        continue;
      }
      pieces.push({
        item: { kind: "text", text: event.text },
        key,
        linter: {
          text: event.text,
          ...(event.segment !== undefined ? { segment: event.segment } : {}),
        },
      });
    }
    return pieces;
  }

  /** Drop the peek and the render root (the modality calls this on unmount). */
  dispose(): void {
    this.hidePeek();
    this.disposeRender();
  }

  private publish(): void {
    // A re-render can remove the hovered thumb; its peek would linger with no
    // mouseleave to clear it.
    this.hidePeek();
    const pieces = this.derivePieces();
    this.latestByKey.clear();
    for (const piece of pieces) {
      this.latestByKey.set(piece.key, piece);
    }
    this.view.setPieces(pieces);
  }

  /**
   * Mount the Solid body: a keyed `<For>` over the accumulator pieces. Each
   * key keeps one DOM row; a re-fold that changes an item's content swaps
   * the row's reactive reads without tearing down its siblings.
   */
  private mountBody(): { view: PreviewViewApi; dispose: () => void } {
    let view: PreviewViewApi | undefined;
    const PreviewBody = () => {
      const [pieces, setPieces] = createSignal<Piece[]>([]);
      view = { setPieces };

      // Follow the stream: pin the scroll after every published change
      // (effects run post-flush, when the DOM has the new content).
      createEffect(
        () => pieces(),
        () => {
          this.body.scrollTop = this.body.scrollHeight;
        },
      );

      /**
       * One text run of the accumulator (final or provisional tail) — an
       * imperative island around the kit's {@link LiveDiffText}: extensions
       * render clean, and any REVISION — a streaming self-correction, a
       * final disagreeing with its last delta, or (later) the compiler
       * reordering/splitting a segment — flashes the word-diff and settles.
       * The diff animation doctrine: Solid renders structure; the island
       * owns its clock.
       */
      const textRow = (key: string) => {
        const host = document.createElement("span");
        const live = new LiveDiffText(host);
        const current = createMemo(() => pieces().find((p) => p.key === key));
        createEffect(
          () => ({
            text: current()?.item.text ?? "",
            provisional: current()?.provisional === true,
          }),
          ({ text, provisional }) => {
            host.className = provisional ? "mm-seg" : "mm-seg final";
            live.update(text);
          },
        );
        return <>{host} </>;
      };

      return (
        <For each={pieces()} keyed={(piece) => piece.key}>
          {(item) => {
            // One-shot read (hence untrack): a key's `kind` never changes,
            // so the row shape is decided once; content stays reactive via
            // the key-scoped memos above / fresh piece reads in the islands.
            const piece = untrack(item);
            if (piece.linter !== undefined) {
              return this.renderLinterChip(piece);
            }
            if (piece.item.kind === "shot") {
              return this.renderShot(piece);
            }
            if (piece.item.kind === "code-selection" || piece.item.kind === "app-selection") {
              return this.renderSelectionPiece(piece);
            }
            return textRow(piece.key);
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
   * One linter note — a 💡 chip in the accumulator flow. READ-ONLY advice:
   * the compiler never composes it, so the chip's ✕ is a purely LOCAL
   * dismissal (no stream event; the note stays in the chronicle and the
   * trace). Hover peeks the full text (the chip clips it).
   */
  private renderLinterChip(piece: Piece): HTMLElement {
    const note = piece.linter as { text: string; segment?: number };
    const wrap = document.createElement("span");
    wrap.className = "mm-thumb-wrap";
    const chip = document.createElement("span");
    chip.className = "mm-lint-chip";
    const clipped = note.text.length > 42 ? `${note.text.slice(0, 42)}…` : note.text;
    chip.textContent = `💡 ${clipped}`;
    chip.title = note.text;
    wrap.append(chip);
    wrap.addEventListener("mouseenter", () => {
      const peek = document.createElement("div");
      peek.className = "mm-sel-peek";
      const text = document.createElement("div");
      text.className = "mm-sel-peek-text";
      text.textContent = note.text;
      peek.append(text);
      this.hidePeek();
      this.placePeek(wrap, peek);
    });
    wrap.addEventListener("mouseleave", () => this.hidePeek());
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mm-thumb-x";
    drop.title = "dismiss this lint (local only)";
    drop.textContent = "✕";
    drop.addEventListener("click", (event) => {
      event.stopPropagation();
      this.hidePeek();
      this.dismissedLints.add(piece.key);
      this.publish();
    });
    wrap.append(drop);
    return wrap;
  }

  /**
   * One shot in the accumulator flow: the thumbnail (or the degraded
   * no-pixels chip), a hover **peek** (fixed-position — the body is a scroll
   * container, so an absolutely-positioned child would clip), and a hover
   * **✕** that retracts the shot from the turn via {@link Engine.dropShot}.
   * An imperative island: built once per key, listeners live as long as the
   * row.
   */
  private renderShot(piece: Piece): HTMLElement {
    const item = piece.item;
    const wrap = document.createElement("span");
    wrap.className = "mm-thumb-wrap";
    if (item.thumb) {
      const img = document.createElement("img");
      img.src = item.thumb;
      img.className = "mm-thumb";
      img.title = item.marker ?? "";
      wrap.append(img);
      wrap.addEventListener("mouseenter", () => this.showPeek(wrap, item.thumb ?? ""));
      wrap.addEventListener("mouseleave", () => this.hidePeek());
    } else {
      const chip = document.createElement("span");
      chip.className = "mm-thumb-chip";
      chip.textContent = `📷 ${item.marker}`;
      wrap.append(chip);
    }
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mm-thumb-x";
    drop.title = `remove ${item.marker} from this turn`;
    drop.textContent = "✕";
    drop.addEventListener("click", (event) => {
      event.stopPropagation();
      this.hidePeek();
      if (item.marker) {
        this.engine.dropShot(item.marker);
      }
    });
    wrap.append(drop);
    return wrap;
  }

  /**
   * One selection — app or code — in the accumulator flow: a MINIMAL pill
   * (glyph + marker: `⌖ sel_1` on-screen, `⧉ code_1` from another view), a
   * hover **peek** (source location + selected text, CSS-clamped), and a
   * hover **✕** that retracts exactly THIS selection through the engine, so
   * the drop streams to the channel like a shot-drop. Built once per key; a
   * refinement re-fold updates the underlying item and hover reads it fresh.
   */
  private renderSelectionPiece(piece: Piece): HTMLElement {
    const isCode = piece.item.kind === "code-selection";
    const current = (): ComposedItem => this.latestByKey.get(piece.key)?.item ?? piece.item;
    const wrap = document.createElement("span");
    wrap.className = "mm-thumb-wrap";
    const chip = document.createElement("span");
    chip.className = `mm-sel-chip ${isCode ? "mm-sel-code" : "mm-sel-app"}`;
    chip.textContent = `${isCode ? "⧉" : "⌖"} ${piece.item.marker ?? (isCode ? "code" : "sel")}`;
    const title = (): string => {
      const item = current();
      return item.sourceLoc !== undefined
        ? `${item.sourceLoc}\n${item.text ?? ""}`
        : (item.text ?? "");
    };
    chip.title = title();
    wrap.append(chip);
    wrap.addEventListener("mouseenter", () => {
      chip.title = title(); // refreshed: a refinement may have superseded it
      this.showSelectionPeek(wrap, current());
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
        if (piece.item.marker) {
          this.engine.dropCodeSelection(piece.item.marker);
        }
      } else {
        this.engine.appSelectionDrop(piece.item.marker);
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
  private showSelectionPeek(anchor: HTMLElement, item: ComposedItem): void {
    this.hidePeek();
    const peek = document.createElement("div");
    peek.className = "mm-sel-peek";
    if (item.sourceLoc !== undefined) {
      const loc = document.createElement("div");
      loc.className = "mm-sel-peek-loc";
      loc.textContent = item.sourceLoc;
      peek.append(loc);
    }
    const text = document.createElement("div");
    text.className = "mm-sel-peek-text";
    text.textContent = item.text ?? "";
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
