// @vitest-environment jsdom
/**
 * selection-inspector.test.tsx — provenance attribution over a REAL
 * mosaic-core Selection: a dimension clause, a registered component clause,
 * and an unregistered stranger, each labeled correctly; the capability
 * grouping that joins dims and producers by column; and the widget rendering
 * the same model under its class contract.
 */
import { render } from "@solidjs/web";
import { Selection } from "@uwdata/mosaic-core";
import { afterEach, describe, expect, it } from "vitest";
import { clearControlSurface } from "./control";
import { disposeDurable } from "./durable";
import { clearMosaicProducerRegistry, registerMosaicInput } from "./mosaic-registry";
import {
  clearSelectionDimRegistry,
  type SelectionSignal,
  selectionDim,
  selectionSignal,
} from "./mosaic-selection";
import { scope } from "./scope";
import { SelectionInspector, selectionInspectorModel } from "./selection-inspector";
import { tick } from "./testing";

let dispose: (() => void) | undefined;
let signal: SelectionSignal | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  signal?.dispose();
  signal = undefined;
  document.body.innerHTML = "";
  clearMosaicProducerRegistry();
  disposeDurable("mosaic-producers:registry");
  for (const key of clearSelectionDimRegistry().durableKeys) disposeDurable(key);
  for (const key of clearControlSurface().durableKeys) disposeDurable(key);
});

class Mystery {}

async function build() {
  const s = scope("ix");
  const sel = Selection.crossfilter();
  signal = selectionSignal(sel);
  const mag = selectionDim({
    name: "mag",
    scope: s,
    kind: "interval",
    targets: [{ selection: sel, field: "mag" }],
  });
  const brushish = { value: [10, 20] };
  registerMosaicInput({
    scope: s,
    name: "depth-brush",
    input: brushish,
    selection: sel,
    fields: ["depth"],
    kind: "interval",
  });
  mag.set({ lo: 5 });
  sel.update({ source: brushish, value: [10, 20], predicate: "depth BETWEEN 10 AND 20" } as never);
  sel.update({ source: new Mystery(), value: 1, predicate: "x = 1" } as never);
  await tick();
  return { s, sel, mag, brushish, signal: signal as SelectionSignal };
}

describe("selectionInspectorModel", () => {
  it("attributes every clause: dim, registered component, unregistered stranger", async () => {
    const { s, signal } = await build();
    const model = selectionInspectorModel({ signal, scope: s });

    expect(model.clauses).toHaveLength(3);
    const byOrigin = Object.fromEntries(model.clauses.map((r) => [r.origin, r]));
    expect(byOrigin.dim).toMatchObject({ producer: "ix/mag", fields: ["mag"] });
    expect(byOrigin.component).toMatchObject({
      producer: "ix/depth-brush",
      fields: ["depth"],
      value: [10, 20],
    });
    expect(byOrigin.unknown.producer).toBe("Mystery");
    expect(byOrigin.dim.sql).toContain("mag");
    expect(model.where).toContain(" AND ");
  });

  it("groups capabilities by column, joining dims and producers with live flags", async () => {
    const { s, signal } = await build();
    const model = selectionInspectorModel({ signal, scope: s });

    const byKey = Object.fromEntries(model.capabilities.map((c) => [c.fields.join("+"), c]));
    expect(byKey.mag.dims).toEqual([{ name: "ix/mag", kind: "interval", value: { lo: 5 } }]);
    expect(byKey.mag.producers).toEqual([]);
    expect(byKey.depth.producers).toMatchObject([
      { name: "ix/depth-brush", host: "input", active: true, value: [10, 20] },
    ]);
  });
});

describe("SelectionInspector: the widget", () => {
  it("renders clause rows with data-origin, the WHERE, and capability members", async () => {
    const { s, signal } = await build();
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <SelectionInspector signal={signal} scope={s} />, host);
    await tick();

    const rows = host.querySelectorAll(".inspector-clause");
    expect(rows).toHaveLength(3);
    const origins = [...rows].map((r) => r.getAttribute("data-origin")).sort();
    expect(origins).toEqual(["component", "dim", "unknown"]);
    expect(host.querySelector(".inspector-where")?.textContent).toContain(" AND ");
    const active = host.querySelectorAll(".capability-member[data-active]");
    expect(active.length).toBeGreaterThanOrEqual(2); // the dim and the brush
  });

  it("attributed rows carry a clear button that retracts JUST that clause", async () => {
    const { s, sel, mag, signal } = await build();
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <SelectionInspector signal={signal} scope={s} />, host);
    await tick();

    // The unknown row has no resolvable name — no button.
    const unknownRow = host.querySelector('.inspector-clause[data-origin="unknown"]');
    expect(unknownRow?.querySelector(".inspector-clear")).toBeNull();

    const componentRow = host.querySelector('.inspector-clause[data-origin="component"]');
    (componentRow?.querySelector(".inspector-clear") as HTMLButtonElement).click();
    await tick();
    expect(sel.clauses.map((c) => String(c.predicate))).not.toContain("depth BETWEEN 10 AND 20");
    expect(mag.get()).toEqual({ lo: 5 }); // the dim's filter untouched

    const dimRow = host.querySelector('.inspector-clause[data-origin="dim"]');
    (dimRow?.querySelector(".inspector-clear") as HTMLButtonElement).click();
    await tick();
    expect(mag.get()).toBeNull();
    expect(sel.clauses.map((c) => String(c.predicate))).toEqual(["x = 1"]); // the stranger stays
  });
});
