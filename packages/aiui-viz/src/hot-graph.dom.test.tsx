// @vitest-environment jsdom
/**
 * hot-graph.dom.test.tsx — the first-paint contract of `hotCellGraph`.
 *
 * A graph module is imported by `main.tsx`, which then calls `render()` in the
 * SAME synchronous tick. Solid 2.0 commits signal writes transactionally, so a
 * box that *stored* the graph in a signal reads back `undefined` for the whole
 * of that tick — which is why every hand-rolled version of this ritual had a
 * `<Show when={graph()} fallback="building dataflow graph…">` wrapper, and why
 * seismos had a `never()` throw to satisfy the impossible-undefined type.
 *
 * `hotCellGraph` keeps the graph in a plain field and uses a version signal
 * only for notification, so `graph()` is correct on the first read. These tests
 * pin that down (`of={graph().x}` on first paint) and pin down that a hot swap
 * still re-renders through the same accessor.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { cell } from "./cell";
import { CellView } from "./cell-view";
import { disposeDurable } from "./durable";
import { hotCellGraph } from "./hot-graph";

const tick = () => new Promise((r) => setTimeout(r, 0));

let host: HTMLElement | undefined;
let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  host?.remove();
  unmount = host = undefined;
  disposeDurable("aiui:graph:dom");
});

function mount(component: () => unknown) {
  host = document.createElement("div");
  document.body.append(host);
  unmount = render(component as never, host);
  return host;
}

describe("hotCellGraph in the DOM", () => {
  it("serves the graph on the same tick it is built — no <Show> guard needed", () => {
    // This mirrors main.tsx: import the graph module, then render immediately.
    const graph = hotCellGraph("dom", () => ({ label: "sample A1" }));
    const el = mount(() => <p>{graph().label}</p>);
    expect(el.textContent).toBe("sample A1"); // NOT "" and NOT a crash
  });

  it("renders `of={graph().cell}` through CellView on first paint", async () => {
    const graph = hotCellGraph("dom", () => ({
      spectrum: cell(
        () => ({}),
        () => ({ peak: 42 }),
      ),
    }));
    const el = mount(() => (
      <CellView of={graph().spectrum} label="loading">
        {(v) => <span>peak {v().peak}</span>}
      </CellView>
    ));
    await tick();
    expect(el.textContent).toContain("peak 42");
    // The attribution wrapper CellView renders is present.
    expect(el.querySelector(".cell-body")).not.toBeNull();
  });

  it("re-renders consumers when a hot edit swaps the graph", async () => {
    const graph = hotCellGraph("dom", () => ({ label: "before" }));
    const el = mount(() => <p>{graph().label}</p>);
    expect(el.textContent).toBe("before");

    // The graph module re-evaluates: same key, new build.
    hotCellGraph("dom", () => ({ label: "after" }));
    await tick();

    // The component captured the ORIGINAL accessor and still sees the new graph.
    expect(el.textContent).toBe("after");
  });
});
