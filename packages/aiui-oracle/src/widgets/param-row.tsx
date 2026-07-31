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
 * A row is a SELF-CONTAINED block: a name/control line with a status line
 * under it. It was briefly a `display: contents` row inside a shared grid, so
 * that columns would line up down the page — and that broke badly, because
 * rows emit different numbers of cells depending on whether they carry a
 * reason or a drift flag, so every short row sheared the next one across the
 * columns. A block cannot shear, and it also survives the narrow side panel,
 * which a five-column grid never could.
 *
 * Labels are the vendor's names verbatim — see the note in `params.ts`.
 */

import type { JSX } from "@solidjs/web";
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
  /** `undefined` means "unset — take the platform's default". */
  onChange: (value: unknown) => void;
}

/** The sentinel for the vendor's own `null` inside a `<select>`. */
const NULL_OPTION = "null";

const show = (value: unknown): string =>
  value === undefined ? "—" : value === null ? "null" : String(value);

export function ParamRow(props: ParamRowProps) {
  const disabled = () => props.disabledReason !== undefined;
  const drifts = () => rowDrifts(props.value, props.effective);
  // The label and its control are siblings on the head line, so the
  // association is explicit. Paths are unique across both tables.
  const id = () => `aiui-oracle-param-${props.spec.path}`;
  const asText = () =>
    props.value === undefined || props.value === null ? "" : String(props.value);

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
          <option value="">— default</option>
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
          <option value="">— default</option>
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
          placeholder={spec.default ?? ""}
          value={asText()}
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
        placeholder={spec.default ?? ""}
        value={asText()}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          props.onChange(raw === "" ? undefined : raw);
        }}
      />
    );
  };

  return (
    <div class="aiui-oracle-param" data-drift={drifts() ? "true" : "false"}>
      <div class="aiui-oracle-param-head">
        <label class="aiui-oracle-param-name" for={id()} title={props.spec.hint}>
          {props.spec.name}
        </label>
        {control()}
      </div>
      <div class="aiui-oracle-param-foot">
        <span class="aiui-oracle-param-effective">
          in force <strong>{show(props.effective)}</strong>
        </span>
        <Show when={props.spec.default}>
          {(fallback) => <span class="aiui-oracle-param-default">default {fallback()}</span>}
        </Show>
        <Show when={drifts()}>
          <span class="aiui-oracle-param-drift" title="set here, not held there">
            drift
          </span>
        </Show>
        <Show when={props.disabledReason}>
          {(reason) => <span class="aiui-oracle-param-why">{reason()}</span>}
        </Show>
      </div>
    </div>
  );
}

/** A labelled run of rows — the vendor object they all belong to. */
export function ParamGroup(props: { name: string; children: JSX.Element }) {
  return (
    <div class="aiui-oracle-param-group">
      <div class="aiui-oracle-param-group-name">{props.name}</div>
      {props.children}
    </div>
  );
}
