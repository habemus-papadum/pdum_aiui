// @vitest-environment jsdom
/**
 * mosaic.dispose.test.tsx — the bridge's disposal contract, both halves:
 * marks are disconnected from the coordinator, and interactor CLAUSES are
 * retracted from their (surviving, shared) selection. The second half is the
 * ghost-brush fix: a clause is keyed by its interactor instance and Mosaic
 * only replaces a clause from the same source, so a view disposed mid-brush
 * must retract its own clause or the stale filter ANDs with every future
 * brush. Plot is mocked here (its marks/interactors are scripted directly);
 * the real-Plot behavioral test lives in mosaic.test.tsx.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MosaicView } from "./mosaic";

// A scriptable Plot: directives fill marks/interactors exactly as vgplot's
// would; the element/update surface is what MosaicView touches.
vi.mock("@uwdata/mosaic-plot", () => ({
  Plot: class FakePlot {
    marks: unknown[] = [];
    interactors: unknown[] = [];
    element = document.createElement("div");
    update(): void {}
  },
}));

/** A fake Selection holding `clauses`; update() records retractions. */
function fakeSelection(clauses: { source: unknown; value?: unknown; predicate?: unknown }[]) {
  const updates: unknown[] = [];
  return {
    clauses,
    update(clause: unknown) {
      updates.push(clause);
    },
    updates,
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MosaicView disposal", () => {
  it("disconnects marks and retracts each interactor's clause from its selection", async () => {
    const connected: unknown[] = [];
    const disconnected: unknown[] = [];
    const coordinator = {
      connect: (c: unknown) => void connected.push(c),
      disconnect: (c: unknown) => void disconnected.push(c),
    };

    const mark = { theMark: true };
    const brushing: { selection?: ReturnType<typeof fakeSelection> } = {};
    const selection = fakeSelection([]);
    brushing.selection = selection;
    // An active brush: the interactor's clause sits in the shared selection.
    selection.clauses.push({ source: brushing, value: [1, 2], predicate: "P" });
    // A PanZoom-shaped interactor (no selection) must be skipped, not thrown on.
    const panzoom = {};

    dispose = render(
      () => (
        <MosaicView
          coordinator={coordinator}
          spec={() => [
            (p) => void (p as unknown as { marks: unknown[] }).marks.push(mark),
            (p) =>
              void (p as unknown as { interactors: unknown[] }).interactors.push(brushing, panzoom),
          ]}
        />
      ),
      document.body,
    );
    await tick();
    expect(connected).toEqual([mark]);

    dispose();
    dispose = undefined;
    expect(disconnected).toEqual([mark]);
    expect(selection.updates).toEqual([{ source: brushing, value: null, predicate: null }]);
  });

  it("publishes no retraction when the interactor holds no active clause", async () => {
    const coordinator = { connect: () => {}, disconnect: () => {} };
    const idle: { selection?: ReturnType<typeof fakeSelection> } = {};
    const selection = fakeSelection([]); // no clause from this source
    idle.selection = selection;

    dispose = render(
      () => (
        <MosaicView
          coordinator={coordinator}
          spec={() => [
            (p) => void (p as unknown as { interactors: unknown[] }).interactors.push(idle),
          ]}
        />
      ),
      document.body,
    );
    await tick();
    dispose();
    dispose = undefined;
    expect(selection.updates).toEqual([]);
  });
});
