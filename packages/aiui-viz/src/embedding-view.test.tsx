// @vitest-environment jsdom
/**
 * embedding-view.test.tsx — the EmbeddingView bridge's lifecycle contract,
 * with `embedding-atlas` mocked (the real component needs WebGL + a live
 * coordinator; the wrapper's obligations are what's pinned here):
 * creation deferred until the host has measured extent; the rangeSelection
 * facade forwarding to the real Selection while capturing the internal
 * client; producer registration under scope/name with the captured client as
 * source and the drive hook installed; reactive viewOptions routing through
 * update(); and dispose = unregister + destroy.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeDurable } from "./durable";
import { EmbeddingView } from "./embedding-view";
import { clearMosaicProducerRegistry, mosaicProducerByName } from "./mosaic-registry";

const harness = vi.hoisted(() => {
  const instances: FakeEmbeddingViewMosaic[] = [];
  class FakeEmbeddingViewMosaic {
    target: HTMLElement;
    props: Record<string, unknown>;
    updates: Record<string, unknown>[] = [];
    destroyed = false;
    client: Record<string, unknown> = { reset: () => {} };
    constructor(target: HTMLElement, props: Record<string, unknown>) {
      this.target = target;
      this.props = props;
      instances.push(this);
      // The real component's range effect publishes an initial (null) clause
      // from its internal client as soon as the Mosaic client exists.
      const range = props.rangeSelection as { update(c: unknown): unknown } | null;
      range?.update({ source: this.client, value: null, predicate: null });
    }
    update(next: Record<string, unknown>): void {
      this.updates.push(next);
      this.props = { ...this.props, ...next };
    }
    destroy(): void {
      this.destroyed = true;
      const range = this.props.rangeSelection as { update(c: unknown): unknown } | null;
      range?.update({ source: this.client, value: null, predicate: null });
    }
  }
  return { instances, FakeEmbeddingViewMosaic };
});

vi.mock("embedding-atlas", () => ({ EmbeddingViewMosaic: harness.FakeEmbeddingViewMosaic }));

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: (entries: unknown[], observer: FakeResizeObserver) => void;
  constructor(cb: (entries: unknown[], observer: FakeResizeObserver) => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {}
  fire(width: number, height: number): void {
    this.cb([{ contentRect: { width, height } }], this);
  }
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

function fakeSelection() {
  const updates: unknown[] = [];
  return {
    updates,
    update(clause: unknown) {
      updates.push(clause);
      return clause;
    },
    activate(_clause: unknown) {},
  };
}

const coordinator = { connect: () => {}, disconnect: () => {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  harness.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  clearMosaicProducerRegistry();
  disposeDurable("mosaic-producers:registry");
  document.body.innerHTML = "";
});

describe("EmbeddingView", () => {
  it("defers creation until measured, forwards clauses, registers the captured client", async () => {
    const range = fakeSelection();
    const [theme, setTheme] = createSignal("dark");
    dispose = render(
      () => (
        <EmbeddingView
          coordinator={coordinator}
          table="wine"
          x="px"
          y="py"
          rangeSelection={range}
          scope="wine"
          name="embedding"
          viewOptions={() => ({ config: { colorScheme: theme() as "dark" | "light" } })}
        />
      ),
      document.body,
    );
    await tick();
    // No size yet — no component.
    expect(harness.instances).toHaveLength(0);

    FakeResizeObserver.instances[0].fire(640, 480);
    await tick();
    expect(harness.instances).toHaveLength(1);
    const view = harness.instances[0];
    expect(view.props.width).toBe(640);
    expect(view.props.table).toBe("wine");

    // The facade forwarded the component's initial clause to the REAL
    // selection and captured the internal client…
    expect(range.updates).toHaveLength(1);
    expect((range.updates[0] as { source: unknown }).source).toBe(view.client);
    // …which is now the registered producer, with the drive hook installed.
    const entry = mosaicProducerByName("wine/embedding");
    expect(entry?.source).toBe(view.client);
    expect(entry?.fields).toEqual(["px", "py"]);
    expect(entry?.kind).toBe("interval");
    const drive = (view.client as { __aiuiDrive?: (cv: unknown) => void }).__aiuiDrive;
    expect(typeof drive).toBe("function");
    drive?.({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
    expect(view.updates.at(-1)).toEqual({
      rangeSelectionValue: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    });

    // Reactive extras route through update(), not a rebuild.
    setTheme("light");
    await tick();
    expect(harness.instances).toHaveLength(1);
    const last = view.updates.at(-1) as { config?: { colorScheme?: string } };
    expect(last.config?.colorScheme).toBe("light");
  });

  it("dispose unregisters the producer and destroys the component (which retracts)", async () => {
    const range = fakeSelection();
    dispose = render(
      () => (
        <EmbeddingView
          coordinator={coordinator}
          table="wine"
          x="px"
          y="py"
          rangeSelection={range}
          scope="wine"
          name="embedding"
        />
      ),
      document.body,
    );
    FakeResizeObserver.instances[0].fire(300, 200);
    await tick();
    expect(mosaicProducerByName("wine/embedding")).toBeDefined();
    const view = harness.instances[0];

    dispose?.();
    dispose = undefined;
    expect(view.destroyed).toBe(true);
    expect(mosaicProducerByName("wine/embedding")).toBeUndefined();
    // destroy() retracted through the facade into the real selection.
    const lastClause = range.updates.at(-1) as { source: unknown; predicate: unknown };
    expect(lastClause.source).toBe(view.client);
    expect(lastClause.predicate).toBeNull();
  });
});
