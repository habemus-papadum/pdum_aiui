/**
 * cell-view.tsx — the notebook feel for every visualization, in one wrapper:
 * spinner + progress before the first value, an error box with retry, and
 * keep-the-last-render (dimmed, progress stripe) while a new run streams or
 * refreshes. From archive/reactive-flows/solid-cells-solidjs_v2.md.
 *
 * Styling is the consumer's: the markup emits stable class names
 * (`cell-body`, `cell-body-loading`, `cell-pending`, `cell-error`,
 * `progress-stripe`, `progress-stripe-fill`, plus `btn`/`btn-outline` on the
 * retry button) that the host app is expected to style. The demo's styles.css
 * is a worked example for a dark surface.
 */

import type { JSX } from "@solidjs/web";
import { type Accessor, Match, Show, Switch } from "solid-js";
import type { Cell } from "./cell";

export function CellView<T>(props: {
  of: Cell<T>;
  children: (value: Accessor<T>) => JSX.Element;
  /** Shown before the first value (default: spinner + progress). */
  fallback?: JSX.Element;
  /** Shown on error (default: message + retry button). */
  errorFallback?: (error: unknown, retry: () => void) => JSX.Element;
  /** Keep showing the last value, dimmed, while recomputing. Default true. */
  keepLatest?: boolean;
  /** Label for the default pending state. */
  label?: string;
}): JSX.Element {
  const showValue = () => {
    const s = props.of.state();
    if (s === "ready") return true;
    if (s === "errored" || s === "unresolved" || s === "pending") return false;
    // streaming/refreshing/held: show the last value (a streamed partial
    // counts). held renders it quiet — loading() is false, so no dim/stripe.
    return props.keepLatest !== false && props.of.latest() !== undefined;
  };

  return (
    <Switch
      fallback={
        props.fallback ?? <DefaultPending label={props.label} progress={props.of.progress()} />
      }
    >
      <Match when={props.of.state() === "errored"}>
        {props.errorFallback ? (
          props.errorFallback(props.of.error(), props.of.refetch)
        ) : (
          <DefaultError error={props.of.error()} retry={props.of.refetch} />
        )}
      </Match>
      <Match when={showValue()}>
        {/* data-cell / data-cell-loc: the element → cell attribution stamp
            (see PRINCIPLES §7) — the name, plus the cell's *definition* site
            ("file:line", babel-injected) so DOM-contract consumers (the intent
            client's jump mode, the intent runtime's VS Code ladder) can open
            the `cell(...)` call without a runtime registry lookup. */}
        {/* data-cell-state mirrors state() so CSS can key off it (e.g.
            [data-cell-state="held"]) and agents/tests can read it off the DOM. */}
        <div
          style={{ position: "relative" }}
          data-cell={props.of.cellName}
          data-cell-loc={props.of.loc}
          data-cell-state={props.of.state()}
        >
          <div class={props.of.loading() ? "cell-body cell-body-loading" : "cell-body"}>
            {props.children(() => props.of.latest() as T)}
          </div>
          <Show when={props.of.loading()}>
            <ProgressStripe value={props.of.progress()} />
          </Show>
        </div>
      </Match>
    </Switch>
  );
}

export function Spinner(props: { size?: number }) {
  const s = () => props.size ?? 16;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.2" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

function DefaultPending(props: { label?: string; progress?: number }) {
  return (
    <div class="cell-pending">
      <Spinner />
      <span>
        {props.label ?? "computing"}
        {props.progress !== undefined ? ` · ${Math.round(props.progress * 100)}%` : "…"}
      </span>
    </div>
  );
}

function DefaultError(props: { error: unknown; retry: () => void }) {
  const message = () => {
    const e = props.error as { message?: string } | undefined;
    return String(e?.message ?? props.error);
  };
  return (
    <div class="cell-error">
      <span style={{ flex: "1" }}>{message()}</span>
      <button type="button" class="btn btn-outline" onClick={() => props.retry()}>
        Retry
      </button>
    </div>
  );
}

export function ProgressStripe(props: { value?: number }) {
  return (
    <div class="progress-stripe">
      <Show
        when={props.value !== undefined}
        fallback={
          <svg
            width="100%"
            height="3"
            viewBox="0 0 100 3"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect y="0" width="30" height="3" fill="#4a86dd">
              <animate attributeName="x" values="-30;100" dur="1.1s" repeatCount="indefinite" />
            </rect>
          </svg>
        }
      >
        <div class="progress-stripe-fill" style={{ width: `${(props.value ?? 0) * 100}%` }} />
      </Show>
    </div>
  );
}
