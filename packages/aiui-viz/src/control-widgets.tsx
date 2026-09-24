/**
 * control-widgets.tsx — the control-bound widgets the apps kept hand-rolling:
 * a slider, a toggle, a scrub pill, and a select. Extracted by evidence, not
 * ambition (the porcelain rule): before this file existed, morphogen and
 * aztec had each written their own identical local `Slider` component,
 * morphogen carried a third inline `knob()` variant, and every call site
 * re-stated min/max/step that the control's meta now owns. That is the exact
 * boilerplate shape that produced `hotCellGraph` and `registerStandardTools`.
 * The scrub pill and the select arrived the same way (2026-09): three
 * verbatim copies of the pill across two downstream repos, five of the enum
 * select in one.
 *
 * These are deliberately NOT an auto-panel: an app composes them into its own
 * layout and prose, chooses labels and formatting, and remains free to
 * hand-roll any binding these don't fit (aztec's scrub slider — playhead state
 * plus a pause side effect — is not control-shaped and correctly stays
 * bespoke). What binding through the widget buys:
 *
 *  - **one source of truth**: min/max/step/unit/options come from the
 *    control's meta, ending the call-site duplication; writes go through the
 *    control's own validation (the same clamp/snap/enum check the agent's
 *    `set` tool gets);
 *  - **attribution**: the root element carries `data-control="<name>"`, so a
 *    drag over the widget resolves to the control (the counterpart of
 *    CellView's `data-cell` stamp), and the description becomes the hover
 *    title;
 *  - the CSS-class contract every aiui app already styles (`slider`,
 *    `slider-label`, `check`, `scrub`, `scrub-label`, `scrub-value`,
 *    `is-scrubbing`, `select`) — no styles ship here, same as CellView.
 */

import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import type { ControlBox } from "./control";

/**
 * A range input bound to a numeric control. Bounds, step, and unit come from
 * the control's meta (declare them there; sliders without min/max fall back to
 * the browser's 0–100). Writes go through the control's validation.
 */
export function ControlSlider(props: {
  of: ControlBox<number>;
  /** Display label; defaults to the control's name. */
  label?: string;
  /** Value formatter for the readout; defaults to `value` + the meta unit. */
  format?: (value: number) => string;
  /** Extra class(es) appended after "slider" (layout variants). */
  class?: string;
}): JSX.Element {
  const shown = () => {
    const v = props.of.get();
    return props.format ? props.format(v) : `${v}${props.of.meta.unit ?? ""}`;
  };
  return (
    <label
      class={props.class ? `slider ${props.class}` : "slider"}
      data-control={props.of.name}
      title={props.of.description}
    >
      <span class="slider-label">
        {props.label ?? props.of.name} <b>{shown()}</b>
      </span>
      <input
        type="range"
        name={props.of.name}
        min={props.of.meta.min}
        max={props.of.meta.max}
        step={props.of.meta.step}
        value={props.of.get()}
        onInput={(e) => props.of.set(e.currentTarget.valueAsNumber as never)}
      />
    </label>
  );
}

/** A checkbox bound to a boolean control. Same contract as ControlSlider. */
export function ControlToggle(props: {
  of: ControlBox<boolean>;
  /** Display label; defaults to the control's name. */
  label?: string;
  /** Extra class(es) appended after "check" (layout variants). */
  class?: string;
}): JSX.Element {
  return (
    <label
      class={props.class ? `check ${props.class}` : "check"}
      data-control={props.of.name}
      title={props.of.description}
    >
      <input
        type="checkbox"
        name={props.of.name}
        checked={props.of.get()}
        onInput={(e) => props.of.set(e.currentTarget.checked as never)}
      />
      {props.label ?? props.of.name}
    </label>
  );
}

/**
 * The scrub pill: a numeric control as a number IN THE PROSE — a quiet label
 * and a value in a pill; press and drag horizontally to move the number, and
 * release to leave it. A `span` px drag (300 by default) crosses the
 * control's whole declared range, so every pill feels the same regardless of
 * its units; `log` scrubs in log₁₀ space — equal drag, equal factor — for
 * controls whose action spans decades (the control's `min` must be > 0). A
 * control without bounds moves one `step` (else one unit) per pixel.
 *
 * Writes go through the control's validation (clamp + snap, declared once);
 * the pill restates nothing. Pointer-only by design: the pill is a drag
 * instrument, and a page's key layer keeps the arrow keys — a control that
 * wants keyboard entry is a slider. `touch-action: none` belongs in the host's
 * CSS so a touch drag never scrolls the page (the FAI design sheet's `.scrub`
 * recipe: a double dashed ring standing, the accent while touched).
 *
 * Solid 2.0 note: the gesture state is a PLAIN boolean, not a signal — writes
 * commit at the next microtask, so a signal read in the very next synchronous
 * pointermove would still see the old value. The signal only styles
 * (`is-scrubbing`).
 */
export function ControlScrub(props: {
  of: ControlBox<number>;
  /** Quiet caption inside the pill — text, or JSX when the equation's symbol
   * rides along ("daily vol (σ<sub>d</sub>)"). Omit when the sentence names
   * it. */
  label?: JSX.Element;
  /** Value formatter ("$350k"); defaults to `value` + the meta unit. */
  format?: (value: number) => string;
  /** Extra class(es) appended after "scrub" (a hero size, a page variant). */
  class?: string;
  /** Logarithmic drag: equal pixels, equal factor (needs `min` > 0). */
  log?: boolean;
  /** Pixels of horizontal drag that cross the declared range. Default 300. */
  span?: number;
  /** The pill element, for a host that must attach NATIVE listeners to it
   * (a deck whose swipe layer would otherwise see the drag: element-attached
   * touch listeners run before delegated ones). */
  ref?: (el: HTMLSpanElement) => void;
}): JSX.Element {
  const [live, setLive] = createSignal(false);
  let scrubbing = false;
  let startX = 0;
  let startV = 0;
  /** Value units per pixel (log₁₀ units in log mode). */
  const perPx = (): number => {
    const { min, max, step } = props.of.meta;
    const span = props.span ?? 300;
    if (min !== undefined && max !== undefined && max > min) {
      if (props.log === true && min > 0) return (Math.log10(max) - Math.log10(min)) / span;
      return (max - min) / span;
    }
    return step ?? 1;
  };
  const shown = () => {
    const v = props.of.get();
    return props.format ? props.format(v) : `${v}${props.of.meta.unit ?? ""}`;
  };
  const end = (): void => {
    scrubbing = false;
    setLive(false);
  };
  return (
    <span
      class={["scrub", live() ? "is-scrubbing" : "", props.class ?? ""].filter(Boolean).join(" ")}
      data-control={props.of.name}
      title={props.of.description}
      ref={(el) => props.ref?.(el)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        scrubbing = true;
        setLive(true);
        startX = e.clientX;
        startV = props.of.get();
        // Capture so the drag survives leaving the pill; preventDefault so
        // the press never starts a text selection. try: a SYNTHETIC
        // pointerdown (an agent driving the page, a jsdom test) carries no
        // active pointer id and capture throws — the scrub works without.
        try {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
          /* synthetic pointer — no capture */
        }
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!scrubbing) return;
        // Accumulate from the press's raw value — the control snaps and
        // clamps each write; the drag itself stays smooth.
        const dx = (e.clientX - startX) * perPx();
        const next = props.log === true ? 10 ** (Math.log10(startV) + dx) : startV + dx;
        props.of.set(next as never);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <Show when={props.label !== undefined}>
        <span class="scrub-label">{props.label}</span>
      </Show>
      <b class="scrub-value">{shown()}</b>
    </span>
  );
}

/**
 * A `<select>` bound to an enum control: the options are the control's
 * declared `options` (declare them there — a control without `options` shows
 * only its current value), the current option follows the control, and a
 * choice writes back through the control's validation. Same contract as
 * ControlSlider: the label carries the stamp and the description; the
 * caption reuses `slider-label` so one CSS rule styles every control's
 * caption; the root is `select` for layout.
 *
 * Options may be any type — the written value is the declared option at the
 * chosen index, never the `<option>`'s string.
 */
export function ControlSelect<T>(props: {
  of: ControlBox<T>;
  /** Display label; defaults to the control's name. */
  label?: string;
  /** Display text per option — a map keyed by `String(option)`, or a
   * function; defaults to `String(option)`. */
  labels?: Readonly<Record<string, string>> | ((option: T) => string);
  /** Extra class(es) appended after "select" (layout variants). */
  class?: string;
}): JSX.Element {
  const options = (): readonly T[] => props.of.meta.options ?? [props.of.get()];
  const text = (option: T): string => {
    const labels = props.labels;
    if (typeof labels === "function") return labels(option);
    return labels?.[String(option)] ?? String(option);
  };
  return (
    <label
      class={props.class ? `select ${props.class}` : "select"}
      data-control={props.of.name}
      title={props.of.description}
    >
      <span class="slider-label">{props.label ?? props.of.name}</span>
      <select
        name={props.of.name}
        value={String(props.of.get())}
        onInput={(e) => {
          const chosen = options()[e.currentTarget.selectedIndex];
          if (chosen !== undefined) props.of.set(chosen as never);
        }}
      >
        <For each={options()}>
          {(option) => <option value={String(option)}>{text(option)}</option>}
        </For>
      </select>
    </label>
  );
}
