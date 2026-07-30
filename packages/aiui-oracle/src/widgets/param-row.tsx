/**
 * param-row.tsx — one row of a params widget, rendered from a {@link ParamSpec}.
 *
 * Shared by both params widgets because the DISCIPLINE is shared, not just the
 * markup: every row shows what we set, what is actually in force, and — when
 * those disagree — says so. A control that only shows what you typed is a
 * control that lies whenever the platform declines, and both of the surfaces
 * this package talks to decline silently (the vendor ignores unknown session
 * fields; a browser resolves `applyConstraints` without necessarily changing
 * anything).
 *
 * Labels are the vendor's names verbatim — see the note in `params.ts`.
 */

import { Show } from "solid-js";
import { type ParamSpec, rowDrifts } from "../params";

export interface ParamRowProps {
  spec: ParamSpec;
  /** What we intend — from the config we would send. */
  value: unknown;
  /** What the platform says is in force. `undefined` = not reported yet. */
  effective: unknown;
  /** Why this row cannot be edited right now; editable when undefined. */
  disabledReason?: string | undefined;
  /** `undefined` means "unset — take the vendor's default". */
  onChange: (value: unknown) => void;
}

/** The sentinel for the vendor's own `null` inside a `<select>`. */
const NULL_OPTION = "null";

const show = (value: unknown): string =>
  value === undefined ? "—" : value === null ? "null" : String(value);

export function ParamRow(props: ParamRowProps) {
  const disabled = () => props.disabledReason !== undefined;
  // The label and its control are SIBLINGS, not nested: the row is
  // `display: contents` so its cells land in the parent grid's columns, and
  // wrapping the input in the label would collapse that. Hence an explicit
  // association. Paths are unique across both tables, so they make the id.
  const id = () => `aiui-oracle-param-${props.spec.path}`;
  const drifts = () => rowDrifts(props.value, props.effective);

  const control = () => {
    const spec = props.spec;
    if (spec.kind === "boolean") {
      // Tri-state on purpose: unset, true, false. A bare checkbox cannot say
      // "I never set this", and for `interrupt_response` the difference
      // between unset and explicitly false is the difference between the
      // vendor's behaviour and ours.
      return (
        <select
          id={id()}
          disabled={disabled()}
          value={props.value === undefined ? "" : String(props.value)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            props.onChange(raw === "" ? undefined : raw === "true");
          }}
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    if (spec.kind === "enum") {
      return (
        <select
          id={id()}
          disabled={disabled()}
          value={props.value === null ? NULL_OPTION : ((props.value as string | undefined) ?? "")}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            props.onChange(raw === "" ? undefined : raw === NULL_OPTION ? null : raw);
          }}
        >
          <option value="">—</option>
          {(spec.options ?? []).map((option) => (
            <option value={option === null ? NULL_OPTION : option}>
              {option === null ? NULL_OPTION : option}
            </option>
          ))}
        </select>
      );
    }
    if (spec.kind === "number") {
      return (
        <input
          id={id()}
          type="number"
          disabled={disabled()}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={props.value === undefined || props.value === null ? "" : String(props.value)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            props.onChange(raw === "" ? undefined : Number(raw));
          }}
        />
      );
    }
    return (
      <input
        id={id()}
        type="text"
        disabled={disabled()}
        value={props.value === undefined || props.value === null ? "" : String(props.value)}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          props.onChange(raw === "" ? undefined : raw);
        }}
      />
    );
  };

  return (
    <div class="aiui-oracle-param" data-drift={drifts()} data-disabled={disabled()}>
      <label class="aiui-oracle-param-name" for={id()} title={props.spec.hint}>
        {props.spec.name}
      </label>
      {control()}
      <span class="aiui-oracle-param-effective" title="what the platform reports is in force">
        {show(props.effective)}
      </span>
      <Show when={props.disabledReason}>
        {(reason) => <span class="aiui-oracle-param-why">{reason()}</span>}
      </Show>
      <Show when={drifts()}>
        <span class="aiui-oracle-param-drift" title="set here, not held there">
          drift
        </span>
      </Show>
    </div>
  );
}
