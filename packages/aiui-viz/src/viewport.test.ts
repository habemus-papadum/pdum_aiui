// @vitest-environment jsdom
/**
 * viewport.test.ts — the resize seam: the viewport pair over one listener,
 * element sizes over one shared observer with one observation per element,
 * and a `now` whose frame loop runs only while something reads it. The
 * durables are torn down after every case; "a second module evaluation" is a
 * real one — the module imported again under a different query, which
 * re-evaluates it alone (Solid and the durable registry stay shared, as under
 * a hot reload).
 */
import { createEffect, createMemo, createRoot, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeDurable } from "./durable";
import { elementHeight, elementWidth, now, viewportHeight, viewportWidth } from "./viewport";

type Viewport = typeof import("./viewport");

let evaluation = 0;
/** The module evaluated a second time — what a hot reload does to it. */
async function reevaluated(): Promise<Viewport> {
  evaluation += 1;
  // A fresh id (the query) makes the runner evaluate the module again.
  return (await import(/* @vite-ignore */ `./viewport?eval=${evaluation}`)) as Viewport;
}

// ── doubles ──────────────────────────────────────────────────────────────────

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  readonly observe = vi.fn((el: Element) => {
    this.observed.add(el);
  });
  readonly unobserve = vi.fn((el: Element) => {
    this.observed.delete(el);
  });
  readonly disconnect = vi.fn(() => this.observed.clear());
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  report(el: Element, width: number, height: number): void {
    const entry = { target: el, contentRect: { width, height } } as unknown as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }
}
const observer = (): FakeResizeObserver => {
  const ro = FakeResizeObserver.instances[0];
  if (ro === undefined) throw new Error("no ResizeObserver was created");
  return ro;
};

/** A hand-cranked animation frame queue. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const requestFrame = vi.fn((cb: FrameRequestCallback): number => {
  const id = nextFrame++;
  frames.set(id, cb);
  return id;
});
const cancelFrame = vi.fn((id: number) => {
  frames.delete(id);
});
function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(performance.now());
}

function box(el: Element, width: number, height: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }),
  });
}

let clientWidth = 1024;
let clientHeight = 768;

const microtask = (): Promise<void> => new Promise((r) => queueMicrotask(r));

beforeEach(() => {
  FakeResizeObserver.instances = [];
  frames.clear();
  nextFrame = 1;
  clientWidth = 1024;
  clientHeight = 768;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
});

afterEach(() => {
  // The viewport releases its documentElement watch before the observer goes.
  disposeDurable("aiui:viewport", (b) => (b as { dispose(): void }).dispose());
  disposeDurable("aiui:now", (b) => (b as { dispose(): void }).dispose());
  disposeDurable("aiui:resize-observer", (b) =>
    (b as { observer?: ResizeObserver }).observer?.disconnect(),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  requestFrame.mockClear();
  cancelFrame.mockClear();
});

// ── the viewport ─────────────────────────────────────────────────────────────

describe("viewportWidth / viewportHeight", () => {
  it("measure the layout viewport and follow a window resize", () => {
    expect(viewportWidth()).toBe(1024);
    expect(viewportHeight()).toBe(768);

    clientWidth = 800;
    clientHeight = 600;
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(viewportWidth()).toBe(800);
    expect(viewportHeight()).toBe(600);
  });

  it("follow a scrollbar change through the html element's observation", () => {
    expect(viewportWidth()).toBe(1024);
    expect(observer().observed.has(document.documentElement)).toBe(true);
    clientWidth = 1009;
    observer().report(document.documentElement, 1009, 4000);
    flush();
    expect(viewportWidth()).toBe(1009);
  });

  it("a second module evaluation adopts the listener instead of stacking one", async () => {
    const add = vi.spyOn(window, "addEventListener");
    expect(viewportWidth()).toBe(1024);
    const second = await reevaluated();
    expect(second.viewportWidth).not.toBe(viewportWidth); // a real second evaluation…
    expect(second.viewportWidth()).toBe(1024);
    clientWidth = 900;
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(second.viewportWidth()).toBe(900);
    expect(viewportWidth()).toBe(900);
    // …over the one durable: one listener, one observer.
    expect(add.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
    expect(FakeResizeObserver.instances).toHaveLength(1);
  });
});

// ── element sizes ────────────────────────────────────────────────────────────

describe("elementWidth / elementHeight", () => {
  it("measure the content box up front, then follow the observer", () => {
    const el = document.createElement("div");
    document.body.append(el);
    box(el, 300, 120);
    const w = elementWidth(el);
    const h = elementHeight(el);

    let seen: [number, number] | undefined;
    const dispose = createRoot((dispose) => {
      createEffect(
        () => [w(), h()] as [number, number],
        (v) => {
          seen = v;
        },
      );
      return dispose;
    });
    flush();
    expect(seen).toEqual([300, 120]);

    observer().report(el, 480.5, 160);
    flush();
    expect(seen).toEqual([480.5, 160]);
    dispose();
    el.remove();
  });

  it("two readers of one element share one observation; the last cleanup releases it", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    box(el, 200, 100);

    const reader = (): { value: () => number; dispose: () => void } =>
      createRoot((dispose) => {
        const value = createMemo(() => elementWidth(el)());
        createEffect(
          () => value(),
          () => {},
        );
        return { value, dispose };
      });
    const a = reader();
    const b = reader();
    flush();
    const ro = observer();
    const observeCalls = () => ro.observe.mock.calls.filter(([t]) => t === el);
    const unobserveCalls = () => ro.unobserve.mock.calls.filter(([t]) => t === el);
    expect(observeCalls()).toHaveLength(1);

    ro.report(el, 333, 100);
    flush();
    expect(a.value()).toBe(333);
    expect(b.value()).toBe(333);

    a.dispose();
    await microtask();
    expect(unobserveCalls()).toHaveLength(0); // b still reads it

    b.dispose();
    await microtask();
    expect(unobserveCalls()).toHaveLength(1);
    el.remove();
  });

  it("an untracked read measures once and observes nothing", () => {
    const el = document.createElement("div");
    document.body.append(el);
    box(el, 250, 50);
    expect(elementWidth(el)()).toBe(250);
    expect(elementHeight(el)()).toBe(50);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    el.remove();
  });

  it("an accessor target that is not there yet reads 0 and observes nothing", () => {
    let host: HTMLElement | undefined;
    const w = elementWidth(() => host);
    const dispose = createRoot((dispose) => {
      createEffect(
        () => w(),
        () => {},
      );
      return dispose;
    });
    flush();
    expect(w()).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    dispose();
  });

  it("a released element is observed again by a later reader, re-measured", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    box(el, 100, 10);
    const first = createRoot((dispose) => {
      createEffect(
        () => elementWidth(el)(),
        () => {},
      );
      return dispose;
    });
    flush();
    const ro = observer();
    expect(ro.observed.has(el)).toBe(true);
    first();
    await microtask();
    expect(ro.observed.has(el)).toBe(false);

    box(el, 640, 10); // it changed while nobody listened
    let seen = -1;
    const second = createRoot((dispose) => {
      createEffect(
        () => elementWidth(el)(),
        (w) => {
          seen = w;
        },
      );
      return dispose;
    });
    flush();
    expect(ro.observed.has(el)).toBe(true);
    await microtask();
    flush();
    expect(seen).toBe(640);
    second();
    el.remove();
  });
});

// ── now ──────────────────────────────────────────────────────────────────────

describe("now", () => {
  it("ticks per animation frame while read, and stops when the last reader is disposed", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1000);
    expect(frames.size).toBe(0);

    const seen: number[] = [];
    const dispose = createRoot((dispose) => {
      createEffect(
        () => now(),
        (t) => {
          seen.push(t);
        },
      );
      return dispose;
    });
    flush();
    expect(frames.size).toBe(1); // the loop started with the first linking read

    clock.mockReturnValue(1016);
    runFrame();
    flush();
    expect(seen.at(-1)).toBe(1016);
    expect(frames.size).toBe(1); // and rescheduled itself

    dispose();
    await microtask();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(requestFrame).toHaveBeenCalledTimes(2); // nothing new after the stop
  });

  it("a re-run of a reader keeps the loop; an untracked read never starts it", async () => {
    expect(typeof now()).toBe("number");
    expect(frames.size).toBe(0);

    const [other, setOther] = createSignal(0);
    const dispose = createRoot((dispose) => {
      const m = createMemo(() => now() + other());
      createEffect(
        () => m(),
        () => {},
      );
      return dispose;
    });
    flush();
    expect(frames.size).toBe(1);
    setOther(1);
    flush();
    setOther(2);
    flush();
    await microtask();
    expect(cancelFrame).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    dispose();
    await microtask();
    expect(frames.size).toBe(0);
  });

  it("two module evaluations share one frame loop", async () => {
    const second = await reevaluated();
    const dispose = createRoot((dispose) => {
      createEffect(
        () => now() + second.now(),
        () => {},
      );
      return dispose;
    });
    flush();
    expect(frames.size).toBe(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    dispose();
    await microtask();
    expect(frames.size).toBe(0);
  });
});
