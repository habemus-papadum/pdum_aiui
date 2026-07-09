/**
 * cell-attribution.ts — EXACT runtime element → cell attribution, without
 * CellView, derived from Solid 2's reactive internals.
 *
 * The dev-overlay's attribution contract is two DOM attributes on the element
 * that renders a cell's value: `data-cell` (the cell's name) and
 * `data-cell-loc` (its `cell(...)` definition site). `CellView` writes them by
 * hand; this module derives the same stamps automatically. It is EXACT — it
 * never guesses. Where it cannot prove a stamp it FAILS LOUDLY (a console
 * error) rather than misattribute, and it is pinned to the Solid build whose
 * private internals it reaches into (see PINNED_SIGNALS); if those internals
 * shift it throws at enable time instead of silently degrading.
 *
 * ── the mechanism (evidence: docs/proposals/solid-cell-attribution.md) ───────
 * There is no path from a live render effect to the DOM node it writes — the
 * node is captured in the effect's `effectFn` closure. So we reach into the
 * private computation objects Solid hands us via `getObserver()`:
 *
 *   • At a cell read during rendering, `getObserver()` IS the render effect. We
 *     record `{name, loc}` under it (ordered) and — once per effect — wrap its
 *     private `_fn` (reset the read list at each recompute) and `_effectFn`
 *     (Solid reads this field fresh at commit — dev.js `runEffect`) to publish a
 *     module-global `committing = <that effect>` for its commit. No owner or
 *     observer is set during commit otherwise; this wrapper supplies the
 *     committing identity.
 *   • Every DOM write to a still-DETACHED element (patched on the
 *     Node/Element/CharacterData prototypes, which @solidjs/web calls) is
 *     buffered against `committing`. Detached = initial construction, where a
 *     cell's read sits fresh in the effect's read list; a connected element is
 *     an update, which Solid commits with GUARDED partial writes that would
 *     break positional pairing — so we stamp at construction and freeze.
 *
 * When an effect's construction commit finishes we have its ordered cell-reads
 * R and its ordered writes W. babel-preset-solid compiles a component's dynamic
 * attributes into ONE effect whose compute reads them in source order and whose
 * commit writes them in the SAME order, and each reactive insert into its own
 * effect — so pairing W to R BY POSITION is exact. If |W| ≠ |R| the effect held
 * a write with no cell read (a non-cell dynamic attribute we cannot observe, or
 * several cells in one node): we refuse to stamp it and log a loud error.
 *
 * ── what is and isn't attributable ───────────────────────────────────────────
 * EXACT, unconditionally: reactive CHILDREN/TEXT (`{cell()}` in an element
 * body) — each is its own insert effect reading one cell.
 * EXACT only when a component's every dynamic ATTRIBUTE is a cell read (read
 * through `attributedRead`): Solid batches all of a component's attributes into
 * one source-ordered effect, so ONE non-cell dynamic attribute anywhere in the
 * component breaks positional alignment for ALL of its attributes — detected
 * and loud-failed, never misattributed. General attribute attribution needs an
 * upstream hook (the proposal's "upstream ask").
 * NOT attributable: a cell whose value is undefined at construction (an async
 * cell still pending) — it emits no write to pair, so it is loud-failed if it
 * shares an attribute effect, or simply left unstamped as an insert.
 */

import { createRenderEffect, createRoot, createSignal, flush, getObserver } from "solid-js";
import { type Cell, cellByName, cellRegistry } from "./cell";

const CELL_ATTR = "data-cell";
const LOC_ATTR = "data-cell-loc";

/**
 * The @solidjs/signals build this module's internals-reach is validated
 * against: `getObserver()` returns a computation with writable `_fn`/`_effectFn`
 * fields, and `dev.js:runEffect` invokes `node._effectFn` fresh at commit.
 */
export const cellAttributionPinnedSignals = "2.0.0-beta.15";

interface ReadEntry {
  name: string;
  loc: string | undefined;
}
interface WriteEntry {
  el: Element;
  attr: boolean;
}
interface EffectNode {
  _fn?: (...a: unknown[]) => unknown;
  _effectFn?: (...a: unknown[]) => unknown;
}

const reads = new WeakMap<object, ReadEntry[]>();
const instrumented = new WeakSet<object>();
const stampedEls = new WeakSet<Element>();
let committing: object | null = null;
/** Writes buffered during the currently-committing effect (null when idle). */
let activeWrites: WriteEntry[] | null = null;

let installed = false;
let restore: (() => void) | null = null;

/** Loud, detectable failure — an app author should see this, not silence. */
function loud(msg: string): void {
  console.error(`[cell-attribution] ${msg}`);
}

/** Merge one cell's (name, loc) into an element's stamp (idempotent). */
function mergeStamp(el: Element, name: string, loc: string | undefined): void {
  const names = (el.getAttribute(CELL_ATTR) ?? "").split(/\s+/).filter(Boolean);
  if (!names.includes(name)) {
    names.push(name);
    el.setAttribute(CELL_ATTR, names.join(" "));
  }
  if (loc) {
    const locs = (el.getAttribute(LOC_ATTR) ?? "").split(/\s+/).filter(Boolean);
    if (!locs.includes(loc)) {
      locs.push(loc);
      el.setAttribute(LOC_ATTR, locs.join(" "));
    }
  }
}

/**
 * An effect's construction commit just finished: pair its writes to its
 * cell-reads by position and stamp — or loud-fail if they don't align 1:1.
 */
function finalizeCommit(E: object, writes: WriteEntry[]): void {
  const R = reads.get(E);
  if (!R || R.length === 0) return; // effect read no cell — nothing to attribute

  // An attribute effect emits one setAttribute per dynamic attribute (each a
  // distinct binding, even on the same element). An insert effect emits several
  // DOM ops for one binding, all on the same parent — collapse those.
  const allAttr = writes.length > 0 && writes.every((w) => w.attr);
  const targets: Element[] = [];
  for (const w of writes) {
    if (allAttr || targets[targets.length - 1] !== w.el) targets.push(w.el);
  }

  if (targets.length === 0) return; // update commit (all writes were connected)
  if (targets.length !== R.length) {
    loud(
      `cannot attribute ${targets.length} construction write(s) from ${R.length} cell read(s) ` +
        `[${R.map((r) => r.name).join(", ")}] — a non-cell dynamic binding (or an undefined ` +
        `async cell) shares this effect. Left unstamped; see docs/proposals/solid-cell-attribution.md.`,
    );
    return;
  }
  for (let i = 0; i < targets.length; i++) {
    const el = targets[i];
    if (stampedEls.has(el)) continue; // stable mapping — stamp once
    mergeStamp(el, R[i].name, R[i].loc);
    stampedEls.add(el);
  }
}

/** Wrap an effect's private `_fn`/`_effectFn` to track reads and its commit. */
function instrument(E: EffectNode & object): void {
  if (instrumented.has(E)) return;
  instrumented.add(E);
  const origFn = E._fn;
  const origEffectFn = E._effectFn;
  if (origFn) {
    E._fn = function (this: unknown, ...args: unknown[]) {
      reads.set(E, []); // fresh read list per recompute (conditional reads stay correct)
      return origFn.apply(this, args);
    };
  }
  if (origEffectFn) {
    E._effectFn = function (this: unknown, ...args: unknown[]) {
      const prevCommitting = committing;
      const prevWrites = activeWrites;
      committing = E;
      activeWrites = [];
      try {
        return origEffectFn.apply(this, args);
      } finally {
        finalizeCommit(E, activeWrites);
        committing = prevCommitting;
        activeWrites = prevWrites;
      }
    };
  }
}

/** Record a cell value-read against the render effect performing it. */
function recordRead(name: string, loc: string | undefined): void {
  const E = getObserver() as (EffectNode & object) | null;
  if (!E) return; // untracked read (event handler, console) — not rendering
  instrument(E);
  const list = reads.get(E);
  if (list) list.push({ name, loc });
  else reads.set(E, [{ name, loc }]);
}

/** A DOM write to a DETACHED element; buffer it against the committing effect. */
function onWrite(node: Node, attr: boolean): void {
  if (!committing || !activeWrites) return;
  const el = (node.nodeType === 3 ? (node as Text).parentElement : node) as Element | null;
  if (!el || el.isConnected) return; // connected = an update; stamp only at construction
  activeWrites.push({ el, attr });
}

/**
 * Read a cell's value inside a render effect while recording attribution — the
 * escape hatch for apps reading `cell()` directly (we can wrap a registered
 * cell's `.latest`, but not the callable an app already closed over). Performs
 * the cell's reactive read so the read subscribes and, for a synchronous cell,
 * resolves at construction — when it is exactly attributable. A pending async
 * cell's reactive read throws `NotReadyError`; we surface `undefined` so a bare
 * `attributedRead(c)?.x` degrades to blank (and the cell is not attributed
 * until it renders a value — see the header's async note).
 */
export function attributedRead<T>(c: Cell<T>): T | undefined {
  if (installed && c.cellName) recordRead(c.cellName, c.loc);
  try {
    return c();
  } catch {
    return undefined;
  }
}

/** Wrap a registered cell's `.latest` so direct `.latest()` reads attribute too. */
function instrumentCellLatest(c: Cell<unknown>): () => void {
  const name = c.cellName;
  if (!name) return () => {};
  const loc = c.loc;
  const orig = c.latest;
  c.latest = () => {
    recordRead(name, loc);
    return orig();
  };
  return () => {
    c.latest = orig;
  };
}

/**
 * Synthetic probe: stand up a render effect and confirm `getObserver()` inside
 * it is a computation exposing writable `_fn` and `_effectFn` — the exact reach
 * this module depends on. Throw loudly if the internals have moved, rather than
 * run and silently fail to stamp anything.
 */
function assertPinnedInternals(): void {
  let sawEffectShape = false;
  const dispose = createRoot((d) => {
    const [s] = createSignal(0);
    createRenderEffect(
      () => {
        const o = getObserver() as EffectNode | null;
        if (o && typeof o._fn === "function" && typeof o._effectFn === "function") {
          sawEffectShape = true;
        }
        return s();
      },
      () => {},
    );
    return d;
  });
  flush();
  dispose();
  if (!sawEffectShape) {
    throw new Error(
      `[cell-attribution] @solidjs/signals internals are not the pinned shape ` +
        `(${cellAttributionPinnedSignals}): getObserver() did not expose writable _fn/_effectFn. ` +
        `Refusing to enable — it would fail to attribute rather than mis-stamp.`,
    );
  }
}

/**
 * Turn on EXACT automatic element → cell attribution for every registered named
 * cell. Idempotent; returns a disposer.
 */
export function enableCellAttribution(): () => void {
  if (installed) return restore ?? (() => {});

  const win = globalThis as unknown as { document?: Document };
  const doc = win.document;
  const view = doc?.defaultView;
  if (!doc || !view) return () => {};

  const NodeP = view.Node.prototype;
  const ElementP = view.Element.prototype;
  const CharP = view.CharacterData.prototype;
  const tcDesc = Object.getOwnPropertyDescriptor(NodeP, "textContent");
  const dataDesc = Object.getOwnPropertyDescriptor(CharP, "data");
  if (!tcDesc?.set || !dataDesc?.set) {
    throw new Error("[cell-attribution] DOM text descriptors missing — cannot instrument.");
  }
  assertPinnedInternals();
  installed = true;

  const origInsertBefore = NodeP.insertBefore;
  const origAppendChild = NodeP.appendChild;
  const origReplaceChild = NodeP.replaceChild;
  const origSetAttribute = ElementP.setAttribute;
  const tcSet = tcDesc.set;
  const dataSet = dataDesc.set;

  NodeP.insertBefore = function <T extends Node>(this: Node, n: T, ref: Node | null): T {
    onWrite(this, false);
    return origInsertBefore.call(this, n, ref) as T;
  };
  NodeP.appendChild = function <T extends Node>(this: Node, n: T): T {
    onWrite(this, false);
    return origAppendChild.call(this, n) as T;
  };
  NodeP.replaceChild = function <T extends Node>(this: Node, n: Node, old: T): T {
    onWrite(this, false);
    return origReplaceChild.call(this, n, old) as T;
  };
  ElementP.setAttribute = function (this: Element, k: string, v: string): void {
    if (k !== CELL_ATTR && k !== LOC_ATTR) onWrite(this, true);
    origSetAttribute.call(this, k, v);
  };
  Object.defineProperty(NodeP, "textContent", {
    ...tcDesc,
    set(this: Node, v: unknown) {
      onWrite(this, false);
      tcSet.call(this, v);
    },
  });
  Object.defineProperty(CharP, "data", {
    ...dataDesc,
    set(this: CharacterData, v: unknown) {
      onWrite(this, false);
      dataSet.call(this, v);
    },
  });

  const uninstrument: Array<() => void> = [];
  for (const { name } of cellRegistry()) {
    const c = cellByName(name);
    if (c) uninstrument.push(instrumentCellLatest(c));
  }

  restore = () => {
    NodeP.insertBefore = origInsertBefore;
    NodeP.appendChild = origAppendChild;
    NodeP.replaceChild = origReplaceChild;
    ElementP.setAttribute = origSetAttribute;
    Object.defineProperty(NodeP, "textContent", tcDesc);
    Object.defineProperty(CharP, "data", dataDesc);
    for (const u of uninstrument) u();
    committing = null;
    activeWrites = null;
    installed = false;
    restore = null;
  };
  return restore;
}
