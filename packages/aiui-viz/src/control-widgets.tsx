/**
 * control-widgets.tsx — the two control-bound widgets the apps kept
 * hand-rolling: a slider and a toggle. Extracted by evidence, not ambition
 * (the porcelain rule): before this file existed, morphogen and aztec had each
 * written their own identical local `Slider` component, morphogen carried a
 * third inline `knob()` variant, and every call site re-stated min/max/step
 * that the control's meta now owns. That is the exact boilerplate shape that
 * produced `hotCellGraph` and `registerStandardTools`.
 *
 * These are deliberately NOT an auto-panel: an app composes them into its own
 * layout and prose, chooses labels and formatting, and remains free to
 * hand-roll any binding these don't fit (aztec's scrub slider — playhead state
 * plus a pause side effect — is not control-shaped and correctly stays
 * bespoke). What binding through the widget buys:
 *
 *  - **one source of truth**: min/max/step/unit come from the control's meta,
 *    ending the call-site duplication; writes go through the control's own
 *    validation (the same clamp/snap the agent's `set` tool gets);
 *  - **attribution**: the label carries `data-control="<name>"`, so a drag
 *    over the widget resolves to the control (the counterpart of CellView's
 *    `data-cell` stamp), and the description becomes the hover title;
 *  - the CSS-class contract every aiui app already styles (`slider`,
 *    `slider-label`, `check`) — no styles ship here, same as CellView.
 */

import type { JSX } from "@solidjs/web";
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
