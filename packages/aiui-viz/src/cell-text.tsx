/**
 * cell-text.tsx — a cell's value as QUIET prose: the reader for a number
 * that lives inside a sentence ("the market moves 1.2% a day"), where
 * CellView's chrome (spinner, error box, dimming) would break the line.
 *
 * The contract is "quiet by contract": the text reads `latest()` — which
 * never throws and never suspends — so it renders the fallback ("…") until
 * the first value and then follows the cell, and it keeps the last value
 * through refreshes and errors instead of flashing chrome. That is also the
 * Solid 2.0 rule this component exists to make routine: reading a pending
 * cell directly in JSX outside a Loading boundary defers the WHOLE root mount
 * (`ASYNC_OUTSIDE_LOADING_BOUNDARY`), and CellText is the shape that avoids
 * it without every page hand-rolling the same ten lines (extracted from the
 * downstream research notes, 2026-09).
 *
 * Attribution: the span carries `data-cell` / `data-cell-loc` /
 * `data-cell-state` exactly as CellView does, so a drag over the number
 * resolves to the cell, and CSS or a test can key off the state
 * (`[data-cell-state="errored"]` for a warning underline, say). The class
 * is `cell-text`; styling is the consumer's, as everywhere.
 */
import type { JSX } from "@solidjs/web";
import type { Cell } from "./cell";

export function CellText<T>(props: {
  of: Cell<T>;
  /** The value's text (or inline markup); called only once a value exists. */
  children: (value: T) => JSX.Element;
  /** Shown until the first value. Default "…". */
  fallback?: JSX.Element;
  /** Extra class(es) appended after "cell-text". */
  class?: string;
}): JSX.Element {
  const body = (): JSX.Element => {
    const v = props.of.latest();
    return v === undefined ? (props.fallback ?? "…") : props.children(v);
  };
  return (
    <span
      class={props.class ? `cell-text ${props.class}` : "cell-text"}
      data-cell={props.of.cellName}
      data-cell-loc={props.of.loc}
      data-cell-state={props.of.state()}
    >
      {body()}
    </span>
  );
}
