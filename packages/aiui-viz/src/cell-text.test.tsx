// @vitest-environment jsdom
/**
 * cell-text.test.tsx — the quiet reader: "…" until the first value, the
 * value's text after, the last value kept through a refresh, and the
 * attribution stamps CellView also writes.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cell } from "./cell";
import { CellText } from "./cell-text";
import { cellHarness, tick, whenReady } from "./testing";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("CellText", () => {
  it("renders the fallback until the first value, then the value's text, stamped", async () => {
    const [n, setN] = createSignal(2);
    let resolve!: (v: number) => void;
    const h = cellHarness(() => ({
      doubled: cell(
        () => ({ n: n() }),
        ({ n }) =>
          new Promise<number>((r) => {
            resolve = () => r(n * 2);
          }),
        { name: "doubled" },
      ),
    }));
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      // Braced: a LONE component between two text runs is the pinned JSX
      // compiler's insertion-marker bug (frontend-hard-won.md) — it would
      // render at the end of the paragraph and fail the whole-line assert.
      () => <p>twice is {<CellText of={h.cells.doubled}>{(v) => `${v}`}</CellText>} today</p>,
      host,
    );
    const span = host.querySelector(".cell-text") as HTMLElement;
    expect(span.textContent).toBe("…");
    expect(span.dataset.cell).toBe("doubled");
    expect(span.dataset.cellState).toBe("pending");
    expect(host.textContent).toBe("twice is … today"); // the line stays whole — no chrome

    resolve(0);
    await whenReady(h.cells.doubled);
    await tick();
    expect(span.textContent).toBe("4");
    expect(span.dataset.cellState).toBe("ready");

    // A refresh keeps the last value on screen (quiet), then follows the new one.
    setN(5);
    await tick();
    expect(span.textContent).toBe("4");
    resolve(0);
    await whenReady(h.cells.doubled);
    await tick();
    expect(span.textContent).toBe("10");
    h.dispose();
  });

  it("takes a custom fallback and an extra class", () => {
    const [go] = createSignal(false);
    const h = cellHarness(() => ({
      // Held from birth: deps return false, so the cell never runs.
      never: cell(
        () => (go() ? { go: true } : false),
        () => 1,
        { name: "never" },
      ),
    }));
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => (
        <CellText of={h.cells.never} class="quiet" fallback="soon">
          {(v) => `${v}`}
        </CellText>
      ),
      host,
    );
    const span = host.querySelector(".cell-text") as HTMLElement;
    expect(span.className).toBe("cell-text quiet");
    expect(span.textContent).toBe("soon");
    expect(span.dataset.cellState).toBe("unresolved");
    h.dispose();
  });
});
