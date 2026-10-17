/**
 * knob.tsx — the knob gesture, once. A KNOB is an element that stands for a
 * numeric control — a symbol in an equation (`<Term control=>`), a node in a
 * diagram (`MermaidMark.control`), a shape in a drawing — and moves it the way
 * the scrub pill does: press and drag sideways, and a `span` of pixels crosses
 * the control's whole declared range, so every knob feels the same; arrow keys
 * step it when focused (Shift ×10, Home/End to the bounds); a READOUT shows the
 * value while the knob is hot (scrubbed, else focused, else hovered). Writes go
 * through the control's own validation, so bounds and snapping are declared
 * once and the agent's `set` tool moves what the user drags.
 *
 * ```ts
 * const knobs = createKnobs();            // in the component body
 * knobs.attach(host);                     // once the host element exists
 * knobs.bind(span, { control: beta });    // per element, after each render
 * <KnobReadout of={knobs} />              // the pill, anywhere in the component
 * ```
 *
 * **Delegation, not per-element listeners.** Both consumers replace their
 * elements on every re-render (KaTeX's HTML, Mermaid's SVG) while the host
 * stays; so the gesture listens on the HOST, and `bind` only records which
 * elements are knobs. A press resolves its target to the innermost bound
 * element enclosing it (or through the consumer's own `resolve`, when its hit
 * areas are not the elements themselves — Mermaid's edge clones). Keyboard
 * and focus resolve to the exact focused element, which is always the knob.
 * A drag listens on the document while it lasts: with pointer capture the
 * events come to the host anyway, and without it (a synthetic pointer: an
 * agent driving the page, a jsdom test) they still arrive. A re-render during
 * a drag replaces the knob's element; the drag follows its control onto the
 * new element at the next `bind`.
 *
 * **The stamp.** `bind` writes the attribution contract every control widget
 * keeps — `data-control="<name>"`, so `locate`, `selection` and `set` resolve
 * the knob to its control — plus the ARIA of a slider (`role`, `tabindex`,
 * `aria-label` from the control's description, `aria-valuemin/max/now/text`)
 * and the class `aiui-knob`. The value attributes follow the control through
 * one effect over every bound control, so a consumer's render pass need not
 * track values at all; `data-scrubbing="true"` rides along during a drag.
 *
 * **What stays component-specific.** Which elements are knobs and when they
 * are rebound (the consumer's render pass); what else the element carries
 * (`data-aiui-term`, `data-aiui-id`); hover and click callbacks on non-knob
 * elements. The readout's LOOK is the skin's (`aiui-knob-readout`,
 * `-value`, `-name`; aiui-design dresses them); this module positions it
 * against the viewport (`position: fixed`), so no scroll box between it and
 * the page — a wide equation's own overflow scroller, a panel — can clip it.
 *
 * Solid 2.0 notes: gesture state is plain (a signal read in the next
 * synchronous pointermove would be stale); `createKnobs` is called in a
 * component body so its effects and cleanup have an owner.
 */
import type { JSX } from "@solidjs/web";
import { type Accessor, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { ControlBox } from "../control";
import { withUnit } from "../control-widgets";
import { elementHeight, elementWidth } from "../viewport";
import { ensureStyles } from "./styles";

/** Pixels of horizontal drag that cross a knob's declared range, by default. */
export const KNOB_SPAN = 240;

/** The readout's default formatter: the value at the step's precision, then the unit. */
export function formatKnob(value: number, meta: ControlBox<number>["meta"]): string {
  const step = meta.step;
  const shown =
    step !== undefined && step > 0 && step < 1
      ? value.toFixed(Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)))))
      : String(value);
  return withUnit(shown, meta.unit);
}

/** Value units per pixel of drag — the scrub pill's rule over the control's range. */
export function knobPerPx(control: ControlBox<number>, span: number | undefined): number {
  const { min, max, step } = control.meta;
  const px = span ?? KNOB_SPAN;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / px;
  return step ?? 1;
}

/** One keyboard step of a knob: its step, else a hundredth of its range, else 1. */
export function knobStep(control: ControlBox<number>): number {
  const { min, max, step } = control.meta;
  if (step !== undefined && step > 0) return step;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / 100;
  return 1;
}

const leafName = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** How an element stands for a control. */
export interface KnobBinding {
  control: ControlBox<number>;
  /** Pixels of horizontal drag that cross the control's declared range. Default {@link KNOB_SPAN}. */
  span?: number;
  /** Readout formatter (also `aria-valuetext`); defaults to {@link formatKnob}. */
  format?: (value: number) => string;
}

/** A bound knob: the element and how it stands for its control. */
export interface Knob extends Readonly<KnobBinding> {
  readonly el: Element;
}

export interface KnobsOptions {
  /** The bound element an event target belongs to. Default: the innermost
   * bound element enclosing the target (walking up to the host). A consumer
   * whose hit areas are not the elements themselves supplies its own. */
  resolve?: (target: Element) => Element | undefined;
}

export interface Knobs {
  /** Delegate the gesture to this host (idempotent; a new host releases the old). */
  attach(host: HTMLElement): void;
  /** Make `el` a knob for `binding.control` — stamps it, tracks its value. Rebinding
   * the same control updates the options in place. */
  bind(el: Element, binding: KnobBinding): void;
  /** Stop `el` being a knob: the stamp and the ARIA come off. */
  unbind(el: Element): void;
  /** Forget every knob (the elements were replaced wholesale). */
  clear(): void;
  /** The knob the readout follows: scrubbing, else focused, else hovered. */
  hot: Accessor<Knob | undefined>;
  /** The readout's anchor — the hot knob's top-center in viewport px. */
  anchor: Accessor<{ x: number; y: number } | undefined>;
  /** Re-place the readout (the knob moved under it). */
  place(): void;
}

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const KNOB_STYLES = `
.aiui-knob { cursor: ew-resize; touch-action: none; outline: none; }
.aiui-knob-readout { position: fixed; z-index: 10; pointer-events: none; white-space: nowrap;
  transform: translate(-50%, calc(-100% - var(--aiui-knob-readout-gap, 6px))); }
`;
const STYLE_MARK = "data-aiui-knob";

const ARIA = [
  "data-control",
  "tabindex",
  "role",
  "aria-label",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
  "aria-valuetext",
];

interface KnobRecord {
  readonly el: Element;
  readonly control: ControlBox<number>;
  span: number | undefined;
  format: ((value: number) => string) | undefined;
}

interface Scrub {
  rec: KnobRecord;
  control: ControlBox<number>;
  startX: number;
  startV: number;
  perPx: number;
}

const stampValue = (rec: KnobRecord, v: number): void => {
  rec.el.setAttribute("aria-valuenow", String(v));
  rec.el.setAttribute(
    "aria-valuetext",
    rec.format ? rec.format(v) : formatKnob(v, rec.control.meta),
  );
};

/**
 * The knob controller for one host — see the module doc. Call it in a
 * component body: its listeners release and its effects dispose with the
 * component.
 */
export function createKnobs(options: KnobsOptions = {}): Knobs {
  ensureStyles(STYLE_MARK, KNOB_STYLES);
  const records = new Map<Element, KnobRecord>();
  // Bumped on bind/unbind so the value effect below tracks the current set.
  // ownedWrite: bookkeeping — a consumer may bind from inside its own render
  // pass, and a write there is legitimate.
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  let n = 0;
  const [hot, setHot] = createSignal<Knob | undefined>();
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | undefined>();
  let host: HTMLElement | undefined;
  let scrub: Scrub | undefined;
  let focused: KnobRecord | undefined;
  let hovered: KnobRecord | undefined;

  const resolve = (target: Element | null): KnobRecord | undefined => {
    if (target === null) return undefined;
    if (options.resolve !== undefined) {
      const el = options.resolve(target);
      return el === undefined ? undefined : records.get(el);
    }
    let cur: Element | null = target;
    while (cur !== null && cur !== host) {
      const rec = records.get(cur);
      if (rec !== undefined) return rec;
      cur = cur.parentElement;
    }
    return undefined;
  };

  const hotOf = (): KnobRecord | undefined => scrub?.rec ?? focused ?? hovered;
  const place = (): void => {
    const k = hotOf();
    if (k === undefined || !k.el.isConnected) {
      setAnchor(undefined);
      return;
    }
    const r = k.el.getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, y: r.top });
  };
  const showHot = (): void => {
    setHot(hotOf());
    place();
  };

  // The glyphs may move under an open readout: follow the host's box.
  createEffect(
    () => {
      if (hot() === undefined || host === undefined) return undefined;
      return [elementWidth(host)(), elementHeight(host)()];
    },
    () => place(),
  );

  // ── the gesture ───────────────────────────────────────────────────────────
  const onPointerOver = (e: PointerEvent): void => {
    hovered = resolve(e.target as Element | null);
    showHot();
  };
  const onPointerLeave = (): void => {
    hovered = undefined;
    showHot();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (scrub === undefined) return;
    // Accumulate from the press's raw value — the control snaps and clamps
    // each write; the drag itself stays smooth.
    scrub.control.set((scrub.startV + (e.clientX - scrub.startX) * scrub.perPx) as never);
  };
  const endScrub = (): void => {
    if (scrub === undefined) return;
    const doc = scrub.rec.el.ownerDocument;
    doc.removeEventListener("pointermove", onPointerMove);
    doc.removeEventListener("pointerup", endScrub);
    doc.removeEventListener("pointercancel", endScrub);
    scrub.rec.el.removeAttribute("data-scrubbing");
    scrub = undefined;
    showHot();
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const rec = resolve(e.target as Element | null);
    if (rec === undefined) return;
    endScrub();
    scrub = {
      rec,
      control: rec.control,
      startX: e.clientX,
      startV: rec.control.get(),
      perPx: knobPerPx(rec.control, rec.span),
    };
    // Capture so the drag survives leaving the element; preventDefault so the
    // press never starts a text selection. try: a SYNTHETIC pointerdown has
    // no active pointer and capture throws — the knob works without.
    try {
      host?.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic pointer — no capture */
    }
    e.preventDefault();
    const doc = rec.el.ownerDocument;
    doc.addEventListener("pointermove", onPointerMove);
    doc.addEventListener("pointerup", endScrub);
    doc.addEventListener("pointercancel", endScrub);
    rec.el.setAttribute("data-scrubbing", "true");
    showHot();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const rec = records.get(e.target as Element);
    if (rec === undefined) return;
    const control = rec.control;
    const unit = knobStep(control) * (e.shiftKey ? 10 : 1);
    const v = control.get();
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v + unit;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v - unit;
    else if (e.key === "Home") next = control.meta.min;
    else if (e.key === "End") next = control.meta.max;
    if (next === undefined) return;
    e.preventDefault();
    control.set(next as never);
  };
  const onFocusIn = (e: FocusEvent): void => {
    const rec = records.get(e.target as Element);
    if (rec === undefined) return;
    focused = rec;
    showHot();
  };
  const onFocusOut = (e: FocusEvent): void => {
    if (focused === undefined || e.target !== focused.el) return;
    focused = undefined;
    showHot();
  };
  const onScroll = (): void => {
    if (hotOf() !== undefined) place();
  };

  const release = (el: HTMLElement): void => {
    el.removeEventListener("pointerover", onPointerOver);
    el.removeEventListener("pointerleave", onPointerLeave);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("focusin", onFocusIn);
    el.removeEventListener("focusout", onFocusOut);
    el.ownerDocument.removeEventListener("scroll", onScroll, { capture: true });
  };
  const attach = (el: HTMLElement): void => {
    if (host === el) return;
    if (host !== undefined) release(host);
    host = el;
    el.addEventListener("pointerover", onPointerOver);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.ownerDocument.addEventListener("scroll", onScroll, { capture: true, passive: true });
  };
  onCleanup(() => {
    endScrub();
    if (host !== undefined) release(host);
  });

  // ── the stamp, and the values that follow their controls ──────────────────
  const stamp = (rec: KnobRecord): void => {
    const { el, control } = rec;
    el.classList.add("aiui-knob");
    el.setAttribute("data-control", control.name);
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", control.description ?? leafName(control.name));
    if (control.meta.min !== undefined) el.setAttribute("aria-valuemin", String(control.meta.min));
    if (control.meta.max !== undefined) el.setAttribute("aria-valuemax", String(control.meta.max));
    // The committed value now (untracked: bind runs from a render pass); the
    // effect below keeps it current.
    stampValue(
      rec,
      untrack(() => control.get()),
    );
  };
  createEffect(
    () => {
      version();
      const pairs: [KnobRecord, number][] = [];
      for (const rec of records.values()) pairs.push([rec, rec.control.get()]);
      return pairs;
    },
    (pairs) => {
      for (const [rec, v] of pairs) stampValue(rec, v);
    },
  );

  const forget = (rec: KnobRecord): void => {
    records.delete(rec.el);
    rec.el.classList.remove("aiui-knob");
    for (const a of ARIA) rec.el.removeAttribute(a);
    if (focused === rec) focused = undefined;
    if (hovered === rec) hovered = undefined;
  };
  const bind = (el: Element, binding: KnobBinding): void => {
    const prev = records.get(el);
    let rec: KnobRecord;
    if (prev !== undefined && prev.control === binding.control) {
      prev.span = binding.span;
      prev.format = binding.format;
      rec = prev;
    } else {
      if (prev !== undefined) forget(prev);
      rec = { el, control: binding.control, span: binding.span, format: binding.format };
      records.set(el, rec);
      setVersion(++n);
    }
    // A drag whose element was replaced mid-gesture (a re-render) follows its
    // control onto the new element.
    if (scrub !== undefined && scrub.rec !== rec && scrub.control === rec.control) {
      if (!scrub.rec.el.isConnected) {
        scrub.rec.el.removeAttribute("data-scrubbing");
        scrub.rec = rec;
        rec.el.setAttribute("data-scrubbing", "true");
      }
    }
    stamp(rec);
    if (hotOf() !== untrack(hot)) showHot();
  };
  const unbind = (el: Element): void => {
    const rec = records.get(el);
    if (rec === undefined) return;
    forget(rec);
    setVersion(++n);
    if (hotOf() !== untrack(hot)) showHot();
  };
  const clear = (): void => {
    if (records.size === 0) return;
    for (const rec of [...records.values()]) forget(rec);
    setVersion(++n);
    if (hotOf() !== untrack(hot)) showHot();
  };

  return { attach, bind, unbind, clear, hot, anchor, place };
}

/**
 * The readout: the hot knob's value and its control's leaf name, in a pill
 * fixed above the knob. Renders nothing while no knob is hot. Classes:
 * `aiui-knob-readout`, `aiui-knob-readout-value`, `aiui-knob-readout-name`;
 * `data-control` names the control.
 */
export function KnobReadout(props: { of: Knobs }): JSX.Element {
  const shown = (k: Knob): string => {
    const v = k.control.get();
    return k.format ? k.format(v) : formatKnob(v, k.control.meta);
  };
  return (
    <Show when={props.of.hot()}>
      {(k) => (
        <span
          class="aiui-knob-readout"
          data-control={k().control.name}
          style={{
            left: `${props.of.anchor()?.x ?? 0}px`,
            top: `${props.of.anchor()?.y ?? 0}px`,
            visibility: props.of.anchor() === undefined ? "hidden" : undefined,
          }}
        >
          <b class="aiui-knob-readout-value">{shown(k())}</b>
          <span class="aiui-knob-readout-name">{leafName(k().control.name)}</span>
        </span>
      )}
    </Show>
  );
}
