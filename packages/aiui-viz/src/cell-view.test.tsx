// @vitest-environment jsdom
/**
 * cell-view.test.tsx — the contract CellView advertises to its children.
 *
 * `CellView` types its children as `(value: Accessor<T>) => JSX.Element` and
 * renders them the moment `state()` is "ready", so every widget in the wild
 * dereferences the accessor immediately (`v().mean`, `v().length`). That is
 * only sound if the invariant below actually holds:
 *
 *     state() === "ready"  ⟹  latest() !== undefined
 *
 * It did not, for *synchronous* computes. A sync cell returns its value
 * straight out of the memo while `setLast` is deferred a microtask (cell.ts),
 * and `settled` starts life `true` — so there is a window where the cell reads
 * "ready" and `latest()` is still `undefined`. Async computes never showed it:
 * `trackPromise` / `commitStream` both `setLast(...)` *before* `setSettled(true)`.
 *
 * Nothing in the repo covered the gap — the demo's cells are all async, and
 * cell-attribution.test.tsx reads its sync cells through the memo rather than
 * `latest()`. The first sync cell rendered through CellView (aiui-test-app's
 * `moments` and `curves`) crashed on first paint.
 */
import { render } from "@solidjs/web";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cell } from "./cell";
import { CellView } from "./cell-view";

const tick = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("CellView + synchronous cells", () => {
  it("keeps latest() in step with state() for a sync compute", () => {
    createRoot((d) => {
      dispose = d;
      const moments = cell(
        () => 4,
        (n) => ({ n, mean: n / 2 }),
        { name: "moments", loc: "m:1" },
      );

      // Both reads happen in the same tick a render effect would have run in.
      expect(moments.state()).toBe("ready");
      expect(moments.latest()).toEqual({ n: 4, mean: 2 });
    });
  });

  it("renders a sync cell's children without handing them undefined", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => {
      const moments = cell(
        () => 4,
        (n) => ({ n, mean: n / 2 }),
        { name: "moments", loc: "m:2" },
      );
      return (
        <CellView of={moments}>
          {/* dereferences immediately, exactly like every real widget */}
          {(m) => <span class="n">{m().n.toLocaleString()}</span>}
        </CellView>
      );
    }, host);

    expect(host.querySelector(".n")?.textContent).toBe("4");
    expect(host.querySelector("[data-cell]")?.getAttribute("data-cell")).toBe("moments");
    expect(host.querySelector(".cell-pending")).toBeNull();

    await tick();
    expect(host.querySelector(".n")?.textContent).toBe("4");
  });

  it("survives a sync cell chained onto a resolving async cell", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => {
      const samples = cell(
        () => 3,
        async (n) => new Float64Array([n, n * 2, n * 3]),
        { name: "samples", loc: "s:1" },
      );
      // deps throw NotReadyError until `samples` resolves — the shape the test
      // app's `moments` and `curves` cells have.
      const stats = cell(
        () => samples(),
        (data) => ({ n: data.length }),
        { name: "stats", loc: "s:2" },
      );
      return <CellView of={stats}>{(s) => <span class="n">{String(s().n)}</span>}</CellView>;
    }, host);

    expect(host.querySelector(".cell-pending")).not.toBeNull(); // held on samples
    await tick();
    await tick();
    expect(host.querySelector(".n")?.textContent).toBe("3");
  });

  it("still shows a value for a sync cell whose deps change", async () => {
    const [k, setK] = createSignal(1);
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => {
      const doubled = cell(
        () => k(),
        (n) => ({ v: n * 2 }),
        { name: "doubled", loc: "d:1" },
      );
      return <CellView of={doubled}>{(c) => <span class="v">{String(c().v)}</span>}</CellView>;
    }, host);

    expect(host.querySelector(".v")?.textContent).toBe("2");
    setK(5);
    await tick();
    expect(host.querySelector(".v")?.textContent).toBe("10");
  });
});

describe("CellView + the held state (the cancel gesture)", () => {
  it("shows the last value quietly — no dim, no stripe — when the deps gate closes", async () => {
    const [capture, setCapture] = createSignal<number | undefined>(1);
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => {
      const analysis = cell(capture, async (n) => ({ peaks: n * 3 }), {
        name: "analysis",
        loc: "a:1",
      });
      return (
        <CellView of={analysis}>{(a) => <span class="peaks">{String(a().peaks)}</span>}</CellView>
      );
    }, host);

    await tick();
    await tick();
    expect(host.querySelector(".peaks")?.textContent).toBe("3");

    // Cancel: the app clears the capture, the gate closes. Before the `held`
    // state this read "refreshing" forever — dimmed value under an
    // indeterminate stripe, indistinguishable from a hung computation.
    setCapture(undefined);
    await tick();

    expect(host.querySelector(".peaks")?.textContent).toBe("3"); // value stands
    expect(host.querySelector("[data-cell-state]")?.getAttribute("data-cell-state")).toBe("held");
    expect(host.querySelector(".cell-body-loading")).toBeNull(); // not dimmed
    expect(host.querySelector(".progress-stripe")).toBeNull(); // no phantom work
  });
});
