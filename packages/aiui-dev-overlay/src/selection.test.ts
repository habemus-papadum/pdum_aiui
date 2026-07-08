// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSelectionWatcher, type SelectionWatcher } from "./selection";

/** Select a text node's contents (or an element's) and make it the live selection. */
function select(node: Node, start = 0, end?: number): void {
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, start);
    range.setEnd(node, end ?? node.textContent?.length ?? 0);
  } else {
    range.selectNodeContents(node);
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** jsdom never fires selectionchange on programmatic selection — do it by hand. */
function fireSelectionChange(): void {
  document.dispatchEvent(new Event("selectionchange"));
}

let watcher: SelectionWatcher | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe("installSelectionWatcher", () => {
  it("snapshots a non-collapsed selection with source-loc and cell attribution", () => {
    document.body.innerHTML = `
      <section data-cell="catalog" data-cell-loc="src/model/graph.ts:77">
        <p data-source-loc="src/ui/App.tsx:32:9">reaction-diffusion on the GPU is fun</p>
      </section>`;
    const p = document.querySelector("p") as HTMLElement;
    watcher = installSelectionWatcher();
    expect(watcher.snapshot()).toBeUndefined();

    select(p.firstChild as Text, 0, 18); // "reaction-diffusion"
    fireSelectionChange();
    vi.advanceTimersByTime(150);

    const snap = watcher.snapshot();
    expect(snap?.text).toBe("reaction-diffusion");
    expect(snap?.sourceLoc).toBe("src/ui/App.tsx:32:9");
    expect(snap?.cell).toBe("catalog");
    // The cell's DEFINITION site (data-cell-loc), not its rendering JSX.
    expect(snap?.cellLoc).toBe("src/model/graph.ts:77");
    expect(snap?.url).toBe(location.href);
    // jsdom has no Range.getClientRects, so rects degrade to [].
    expect(snap?.rects).toEqual([]);
  });

  it("debounces: no snapshot until the delay elapses", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    watcher = installSelectionWatcher({ debounceMs: 150 });
    select(document.querySelector("p")?.firstChild as Text, 0, 5);
    fireSelectionChange();
    vi.advanceTimersByTime(100);
    expect(watcher.snapshot()).toBeUndefined();
    vi.advanceTimersByTime(60);
    expect(watcher.snapshot()?.text).toBe("hello");
  });

  it("calls onChange when a snapshot is captured and when it is cleared", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    const changes: Array<string | undefined> = [];
    watcher = installSelectionWatcher({ onChange: (s) => changes.push(s?.text) });
    select(document.querySelector("p")?.firstChild as Text, 0, 5);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    watcher.clear();
    expect(changes).toEqual(["hello", undefined]);
  });

  it("survives the focus steal: an emptied selection does not drop the snapshot", () => {
    document.body.innerHTML = `<p>keep this selection</p><textarea></textarea>`;
    watcher = installSelectionWatcher();
    select(document.querySelector("p")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text).toBe("keep this selection");

    // Moving focus into a textarea empties the document selection (verified in
    // jsdom too). The next selectionchange must NOT clear the snapshot.
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    window.getSelection()?.removeAllRanges();
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text).toBe("keep this selection");
  });

  it("ignores collapsed selections", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    watcher = installSelectionWatcher();
    const text = document.querySelector("p")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 3);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()).toBeUndefined();
  });

  it("clear() drops the current snapshot (the chip's ✕)", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    watcher = installSelectionWatcher();
    select(document.querySelector("p")?.firstChild as Text, 0, 5);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()).toBeDefined();
    watcher.clear();
    expect(watcher.snapshot()).toBeUndefined();
  });

  it("ignores selections inside an ignored node (the widget's own host)", () => {
    document.body.innerHTML = `<div id="host"><p>widget-internal text</p></div>`;
    const host = document.getElementById("host") as HTMLElement;
    watcher = installSelectionWatcher({ ignoreWithin: [host] });
    select(host.querySelector("p")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()).toBeUndefined();
  });

  it("expires a snapshot after the TTL", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    watcher = installSelectionWatcher({ ttlMs: 1000 });
    select(document.querySelector("p")?.firstChild as Text, 0, 5);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text).toBe("hello");
    vi.advanceTimersByTime(1001);
    expect(watcher.snapshot()).toBeUndefined();
  });

  it("caps text at 2000 chars", () => {
    const long = "x".repeat(3000);
    document.body.innerHTML = `<p>${long}</p>`;
    watcher = installSelectionWatcher();
    select(document.querySelector("p")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text.length).toBe(2000);
  });

  it("stops listening after dispose()", () => {
    document.body.innerHTML = `<p>hello world</p>`;
    const w = installSelectionWatcher();
    w.dispose();
    select(document.querySelector("p")?.firstChild as Text, 0, 5);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(w.snapshot()).toBeUndefined();
  });
});

describe("equation recovery", () => {
  it("recovers TeX from a data-tex wrapper", () => {
    document.body.innerHTML = `<span data-tex="\\partial u/\\partial t"><span>∂u/∂t</span></span>`;
    watcher = installSelectionWatcher();
    const inner = document.querySelector("span span") as HTMLElement;
    select(inner.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.tex).toBe("\\partial u/\\partial t");
  });

  it("falls back to the KaTeX MathML annotation when there is no data-tex", () => {
    // A hand-built KaTeX-shaped render: visible glyph span + MathML annotation.
    document.body.innerHTML = `
      <span class="katex">
        <span class="katex-html" aria-hidden="true">∂u/∂t</span>
        <span class="katex-mathml">
          <math><semantics><annotation encoding="application/x-tex">\\partial u/\\partial t</annotation></semantics></math>
        </span>
      </span>`;
    watcher = installSelectionWatcher();
    const glyphs = document.querySelector(".katex-html") as HTMLElement;
    select(glyphs.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.tex).toBe("\\partial u/\\partial t");
  });

  it("leaves tex undefined for ordinary prose", () => {
    document.body.innerHTML = `<p>ordinary prose</p>`;
    watcher = installSelectionWatcher();
    select(document.querySelector("p")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    const snap = watcher.snapshot();
    expect(snap).toBeDefined();
    expect(snap?.tex).toBeUndefined();
  });
});

describe("addIgnored (late-mounted overlay layers)", () => {
  it("ignores selections inside a node added after the watcher was installed", () => {
    document.body.innerHTML = `<p>app text</p><div id="layers"><span>overlay text</span></div>`;
    watcher = installSelectionWatcher();
    const layers = document.querySelector("#layers") as HTMLElement;

    // Before the ignore: a selection in the layers IS captured.
    select(layers.querySelector("span")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text).toBe("overlay text");

    // After: it no longer replaces the snapshot (the app selection survives).
    watcher.clear();
    select(document.querySelector("p")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    watcher.addIgnored(layers);
    select(layers.querySelector("span")?.firstChild as Text);
    fireSelectionChange();
    vi.advanceTimersByTime(150);
    expect(watcher.snapshot()?.text).toBe("app text");
  });
});
