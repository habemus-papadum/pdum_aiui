/**
 * viewport.ts — the page's reactive dimensions and clock, once per document:
 * Observable's `width` and `now` for an aiui page, plus the per-element size
 * a component actually lays out against. The design note is
 * packages/aiui-viz/docs/viewport.md.
 *
 *   - `viewportWidth()` / `viewportHeight()` — the layout viewport
 *     (`documentElement.clientWidth` / `clientHeight`: the window minus a
 *     classic scrollbar — what a CSS media query sees). An aiui page is panels
 *     and sidebars, not Observable's one column, so the page-level value is the
 *     viewport, and a component asks for its OWN box with the next pair.
 *   - `elementWidth(el)` / `elementHeight(el)` — an element's content box,
 *     live, from ONE shared ResizeObserver with one observation per element
 *     however many readers it has. Observed only while something reads it.
 *   - `now()` — `Date.now()`, re-read every animation frame for as long as
 *     anything reads it; the loop stops when the last reader goes.
 *
 * ## Subscriber gating
 *
 * Solid 2.0 signals take an `unobserved` hook that fires when the last
 * subscriber unlinks. A recompute that reads the signal again keeps its link,
 * so the hook is quiet across re-runs; a dispose, or a branch that stops
 * reading, fires it. Here a read from a LINKING computation starts the resource
 * behind the signal, and the hook schedules the stop one microtask later —
 * cancelled by any read in between, so a compute whose dependency order changed
 * does not stop and restart a frame loop. Probe reads (`latest()`, `isPending`)
 * report a placeholder observer and link nothing; untracked reads link nothing.
 * Neither starts anything; both return the current value.
 *
 * ## Hot reload
 *
 * The signals and the listeners behind them live in the durable registry
 * (`aiui:viewport`, `aiui:resize-observer`, `aiui:now`), the `colorMode`
 * pattern: a re-evaluated module adopts the one resize listener, the one
 * observer and the one frame loop instead of stacking a second. The boxes are
 * looked up on every read rather than captured at module scope, so a real
 * `disposeDurable` is honoured by the next read (and a test can tear down
 * between cases). Nothing here is a `control()` or a `cell()`, so nothing lands
 * in a registry the `report` tool enumerates.
 *
 * Non-browser realms (node tests without jsdom) get static zeros and a frozen
 * clock instead of a throw — the guard precedes the durable call, since the
 * registry itself lives on `window`.
 */

import { type Accessor, createSignal, getObserver, getOwner } from "solid-js";
import { durable } from "./durable";

/** An element, or an accessor for one that may not exist yet (`() => host`). */
export type ElementTarget = Element | (() => Element | undefined);

const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";

/**
 * True when the read about to happen LINKS a computation to the signal — a
 * tracked read inside a memo, an effect's compute or a JSX expression. Probe
 * reads return a placeholder observer that is not the owner; untracked reads
 * return none.
 */
function linking(): boolean {
  const observer = getObserver();
  return observer !== null && observer === getOwner();
}

/**
 * The start/stop policy behind every gated resource. `touch(key)` on a linking
 * read (the start must be idempotent); `lost(key)` from a signal's
 * `unobserved` hook. The stop runs one microtask later, and only if nothing was
 * touched in between.
 */
function gate(
  start: () => void,
  stop: () => void,
): { touch(key: string): void; lost(key: string): void } {
  const live = new Set<string>();
  let pending = false;
  return {
    touch(key) {
      live.add(key);
      start();
    },
    lost(key) {
      live.delete(key);
      if (pending || live.size > 0) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (live.size === 0) stop();
      });
    },
  };
}

// ── the shared observer ──────────────────────────────────────────────────────

type SizeHook = (rect: DOMRectReadOnly) => void;

interface SizeEntry {
  width: Accessor<number>;
  height: Accessor<number>;
  touch(key: "width" | "height"): void;
}

interface ObserverBox {
  /** Created on the first observation, never before. */
  observer: ResizeObserver | undefined;
  /** Who wants to hear about each observed element; one observation each. */
  hooks: Map<Element, Set<SizeHook>>;
  /** One pair of size signals per element, for the element's lifetime. */
  entries: WeakMap<Element, SizeEntry>;
}

function observerBox(): ObserverBox | undefined {
  if (!inBrowser) return undefined;
  return durable(
    "aiui:resize-observer",
    (): ObserverBox => ({ observer: undefined, hooks: new Map(), entries: new WeakMap() }),
  );
}

/** Hear about one element's size through the shared observer; returns the release. */
function watch(box: ObserverBox, el: Element, hook: SizeHook): () => void {
  let set = box.hooks.get(el);
  if (set === undefined) {
    set = new Set();
    box.hooks.set(el, set);
    if (box.observer === undefined && typeof ResizeObserver === "function") {
      box.observer = new ResizeObserver((list) => {
        for (const entry of list) {
          for (const h of box.hooks.get(entry.target) ?? []) h(entry.contentRect);
        }
      });
    }
    box.observer?.observe(el);
  }
  set.add(hook);
  return () => {
    const hooks = box.hooks.get(el);
    if (hooks === undefined || !hooks.delete(hook) || hooks.size > 0) return;
    box.hooks.delete(el);
    box.observer?.unobserve(el);
  };
}

/** The content box, measured now — what the observer will report, before it has. */
function contentBox(el: Element): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  if (!(el instanceof HTMLElement)) return { width: rect.width, height: rect.height };
  const cs = getComputedStyle(el);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const horizontal =
    px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  const vertical =
    px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  return {
    width: Math.max(0, rect.width - horizontal),
    height: Math.max(0, rect.height - vertical),
  };
}

function entryFor(box: ObserverBox, el: Element): SizeEntry {
  const existing = box.entries.get(el);
  if (existing !== undefined) return existing;

  const first = contentBox(el);
  let release: (() => void) | undefined;
  let dormant = false; // observed once, then released: re-measure on the next start
  const g = gate(
    () => {
      if (release !== undefined) return;
      release = watch(box, el, (rect) => {
        setWidth(rect.width);
        setHeight(rect.height);
      });
      if (dormant) {
        // The signals held their last value while nobody listened. A microtask
        // is an imperative boundary (the touch that started us may be inside a
        // compute, where a write would throw); the observer's own first report
        // follows at the next rendering opportunity.
        queueMicrotask(() => {
          if (release === undefined) return;
          const b = contentBox(el);
          setWidth(b.width);
          setHeight(b.height);
        });
      }
    },
    () => {
      release?.();
      release = undefined;
      dormant = true;
    },
  );
  const [width, setWidth] = createSignal(first.width, {
    name: "aiui:element-width",
    unobserved: () => g.lost("width"),
  });
  const [height, setHeight] = createSignal(first.height, {
    name: "aiui:element-height",
    unobserved: () => g.lost("height"),
  });
  const entry: SizeEntry = { width, height, touch: g.touch };
  box.entries.set(el, entry);
  return entry;
}

function resolve(target: ElementTarget): Element | undefined {
  return typeof target === "function" ? target() : target;
}

function sizeOf(target: ElementTarget, key: "width" | "height"): number {
  const el = resolve(target);
  const box = observerBox();
  if (el === undefined || box === undefined) return 0;
  const entry = entryFor(box, el);
  if (linking()) entry.touch(key);
  return entry[key]();
}

/**
 * An element's content-box width, live. Read it in a memo, an effect's compute
 * or JSX and the element is observed for as long as that reader exists; read it
 * untracked and you get a one-off measurement. `0` for an element that is not
 * laid out (`display: none`, not yet connected) or not yet available.
 *
 * Every reader of one element shares one observation of the page's one
 * ResizeObserver.
 */
export function elementWidth(target: ElementTarget): Accessor<number> {
  return () => sizeOf(target, "width");
}

/** An element's content-box height, live — see {@link elementWidth}. */
export function elementHeight(target: ElementTarget): Accessor<number> {
  return () => sizeOf(target, "height");
}

// ── the viewport ─────────────────────────────────────────────────────────────

interface ViewportBox {
  width: Accessor<number>;
  height: Accessor<number>;
  dispose(): void;
}

let staticViewport: ViewportBox | undefined;

function viewportBox(): ViewportBox {
  const box = observerBox();
  if (box === undefined) {
    if (staticViewport === undefined) {
      const [width] = createSignal(0);
      const [height] = createSignal(0);
      staticViewport = { width, height, dispose() {} };
    }
    return staticViewport;
  }
  return durable("aiui:viewport", (): ViewportBox => {
    const root = document.documentElement;
    const [width, setWidth] = createSignal(root.clientWidth, { name: "aiui:viewport-width" });
    const [height, setHeight] = createSignal(root.clientHeight, { name: "aiui:viewport-height" });
    const measure = (): void => {
      setWidth(root.clientWidth);
      setHeight(root.clientHeight);
    };
    window.addEventListener("resize", measure);
    // A classic scrollbar appearing or leaving changes clientWidth with no
    // resize event; the html element's own box, observed, reports it.
    const release = watch(box, root, measure);
    return {
      width,
      height,
      dispose() {
        window.removeEventListener("resize", measure);
        release();
      },
    };
  });
}

/**
 * The layout viewport's width: `documentElement.clientWidth`, the window
 * minus a classic scrollbar, what `@media (min-width: …)` compares against.
 * Live on window resize and scrollbar changes; always on (one listener per
 * document, no gating).
 */
export const viewportWidth: Accessor<number> = () => viewportBox().width();

/** The layout viewport's height — see {@link viewportWidth}. */
export const viewportHeight: Accessor<number> = () => viewportBox().height();

// ── now ──────────────────────────────────────────────────────────────────────

interface NowBox {
  get: Accessor<number>;
  touch(): void;
  dispose(): void;
}

function makeNowBox(): NowBox {
  const canTick = typeof requestAnimationFrame === "function";
  let frame: number | undefined;
  const tick = (): void => {
    frame = undefined;
    setNow(Date.now());
    frame = requestAnimationFrame(tick);
  };
  const stop = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const g = gate(() => {
    if (canTick && frame === undefined) frame = requestAnimationFrame(tick);
  }, stop);
  const [get, setNow] = createSignal(Date.now(), {
    name: "aiui:now",
    unobserved: () => g.lost("now"),
  });
  return { get, touch: () => g.touch("now"), dispose: stop };
}

let staticNow: NowBox | undefined;

function nowBox(): NowBox {
  if (inBrowser) return durable("aiui:now", makeNowBox);
  staticNow ??= makeNowBox();
  return staticNow;
}

/**
 * The current time, `Date.now()` in milliseconds, re-read on every animation
 * frame while anything reads it. A memo over `now()` re-runs once per frame;
 * dispose the last reader and the frame loop stops. Untracked reads return the
 * last frame's value without starting the loop.
 */
export const now: Accessor<number> = () => {
  const box = nowBox();
  if (linking()) box.touch();
  return box.get();
};
