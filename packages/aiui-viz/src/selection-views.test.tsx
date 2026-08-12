// @vitest-environment jsdom
/**
 * selection-views.test.tsx — named cross-filter views: the save/load/remove
 * roundtrip over real selection dimensions, completeness (nulls stored and
 * applied), persistence across store re-creation (localStorage is the point),
 * the four derived actions, and the widget driving the same code path.
 */
import { render } from "@solidjs/web";
import { Selection } from "@uwdata/mosaic-core";
import { afterEach, describe, expect, it } from "vitest";
import { actionByName, clearControlSurface } from "./control";
import { disposeDurable } from "./durable";
import { clearSelectionDimRegistry, selectionDim } from "./mosaic-selection";
import { scope } from "./scope";
import { SelectionViewsBar, selectionViews } from "./selection-views";
import { tick } from "./testing";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
  disposeDurable("views:vx");
  for (const key of clearSelectionDimRegistry().durableKeys) disposeDurable(key);
  for (const key of clearControlSurface().durableKeys) disposeDurable(key);
});

const vx = () => scope("vx");

function declareDims() {
  const sel = Selection.crossfilter();
  const mag = selectionDim({
    name: "mag",
    scope: vx(),
    kind: "interval",
    targets: [{ selection: sel, field: "mag" }],
  });
  const type = selectionDim({
    name: "type",
    scope: vx(),
    kind: "point",
    targets: [{ selection: sel, field: "type" }],
  });
  return { sel, mag, type };
}

describe("selectionViews: the store", () => {
  it("saves COMPLETE state (nulls included) and load reproduces it exactly", async () => {
    const { sel, mag, type } = declareDims();
    const store = selectionViews({ scope: vx() });

    mag.set({ lo: 5, hi: 6 });
    await tick();
    const saved = store.save("fives");
    expect(saved.values).toEqual({ "vx/mag": { lo: 5, hi: 6 }, "vx/type": null });

    // Move to a different state — including a filter the view must CLEAR.
    mag.set({ lo: 8 });
    type.set(["eruption"]);
    await tick();
    expect(sel.clauses).toHaveLength(2);

    const { applied, missing } = store.load("fives");
    expect(applied).toEqual({ "vx/mag": { lo: 5, hi: 6 }, "vx/type": null });
    expect(missing).toEqual([]);
    await tick();
    expect(mag.get()).toEqual({ lo: 5, hi: 6 });
    expect(type.get()).toBeNull();
    expect(sel.clauses).toHaveLength(1); // the type filter was cleared by the load
  });

  it("persists across store re-creation (localStorage), and remove deletes", () => {
    declareDims();
    const first = selectionViews({ scope: vx() });
    first.save("a");
    first.save("b");
    disposeDurable("views:vx"); // a page reload's worth of forgetting

    const second = selectionViews({ scope: vx() });
    expect(second.names()).toEqual(["a", "b"]);
    expect(second.remove("a")).toBe(true);
    expect(second.remove("a")).toBe(false);
    expect(second.names()).toEqual(["b"]);
  });

  it("throws on an unknown view, listing what IS saved; tolerates corrupt storage", () => {
    declareDims();
    const store = selectionViews({ scope: vx() });
    store.save("real");
    expect(() => store.load("ghost")).toThrow(/no view "ghost" — saved views: real/);

    localStorage.setItem("aiui:views:vx", "{not json");
    expect(store.names()).toEqual([]); // corruption reads as empty, never throws
  });

  it("load reports snapshot entries whose dimension no longer exists", () => {
    declareDims();
    const store = selectionViews({ scope: vx() });
    localStorage.setItem(
      "aiui:views:vx",
      JSON.stringify({
        v: 1,
        views: { old: { savedAt: "2026-01-01T00:00:00Z", values: { "vx/retired": [1, 2] } } },
      }),
    );
    expect(store.load("old").missing).toEqual(["vx/retired"]);
  });
});

describe("selectionViews: the derived actions", () => {
  it("registers save/load/list/delete as scope-qualified schema'd actions", async () => {
    const { mag } = declareDims();
    selectionViews({ scope: vx() });

    const save = actionByName("vx/save-view");
    const load = actionByName("vx/load-view");
    const list = actionByName("vx/list-views");
    const del = actionByName("vx/delete-view");
    expect(save?.inputSchema).toMatchObject({ required: ["name"] });
    expect(list).toBeDefined();

    mag.set({ lo: 5 });
    await tick();
    save?.run?.({ name: "pacific" });
    mag.set({ lo: 9 });
    await tick();

    const result = load?.run?.({ name: "pacific" }) as { applied: Record<string, unknown> };
    expect(result.applied["vx/mag"]).toEqual({ lo: 5 });

    const listed = list?.run?.({}) as { views: { name: string }[] };
    expect(listed.views.map((v) => v.name)).toEqual(["pacific"]);
    expect(del?.run?.({ name: "pacific" })).toEqual({ name: "pacific", removed: true });
  });

  it("is durable-adopted: a second call shares the store and does not double-register", () => {
    declareDims();
    const a = selectionViews({ scope: vx() });
    const b = selectionViews({ scope: vx() });
    expect(b).toBe(a);
  });
});

describe("SelectionViewsBar: the mouse half", () => {
  function mount(el: () => unknown): HTMLElement {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(el as never, host);
    return host;
  }

  it("saves via the name field, lists in the picker, loads on choose, deletes", async () => {
    const { mag } = declareDims();
    const store = selectionViews({ scope: vx() });
    const host = mount(() => <SelectionViewsBar store={store} />);

    const input = host.querySelector("input.views-name") as HTMLInputElement;
    const saveBtn = host.querySelector("button.views-save") as HTMLButtonElement;
    const select = host.querySelector("select.views-select") as HTMLSelectElement;
    const delBtn = host.querySelector("button.views-delete") as HTMLButtonElement;

    mag.set({ lo: 5 });
    await tick();
    input.value = "fives";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    await tick();
    expect(store.names()).toEqual(["fives"]);
    expect([...select.options].map((o) => o.value)).toEqual(["", "fives"]);

    mag.set({ lo: 9 });
    await tick();
    select.value = "fives";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(mag.get()).toEqual({ lo: 5 }); // choosing IS loading

    delBtn.click();
    await tick();
    expect(store.names()).toEqual([]);
  });
});
