/**
 * bar.tsx — the command bar: the mode tree rendered DEPTH-FIRST, plus the
 * control-bound widgets it can hold. Rendered POSITION-KEYED (<Repeat>) so a
 * cap's DOM node PERSISTS while its attributes update in place — load-bearing
 * for the push-to-talk hold cap (a reference-keyed <For> would re-create the
 * button when its own lit flips, detaching it mid-press). BarItemView's `item`
 * MUST stay an ACCESSOR prop, never a resolved value, or that invariant
 * breaks. The tap-flash state is a CapRuntime created ONCE in Panel and shared
 * by both the command bar and the config strip (one flash closure, not one per
 * strip).
 */

import { type ControlBox, ControlToggle, controlByName } from "@habemus-papadum/aiui-viz";
import type { BarItem, BarTreeNode } from "@habemus-papadum/aiui-viz/modal";
import { createMemo, createSignal, For, Match, onCleanup, Repeat, Show, Switch } from "solid-js";
import type { IntentClient } from "../client";

export const BAR_STYLES = `
  .aiui-bar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .aiui-sep { opacity: 0.4; padding: 0 3px; font-weight: 600; user-select: none; }
  /* A group brackets a lit parent with its revealed children: thin left/right
     rules and a faint tint that DEEPENS with nesting depth, so a linear row of
     caps still shows which belong together and how deep. Children flow inline
     right after their parent (depth-first), the group wraps as one unit. */
  .aiui-group { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center;
    padding: 2px 5px; border-radius: 7px;
    border-left: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-right: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .aiui-group[data-depth="1"] { background: color-mix(in srgb, currentColor 7%, transparent); }
  .aiui-group[data-depth="2"] { background: color-mix(in srgb, currentColor 10%, transparent); }
  .aiui-group[data-depth="3"] { background: color-mix(in srgb, currentColor 13%, transparent); }
  .aiui-group[data-depth="4"] { background: color-mix(in srgb, currentColor 16%, transparent); }
  .aiui-cap { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px; padding: 3px 8px; background: transparent; cursor: pointer; font: inherit;
    transition: background 250ms ease-out, border-color 250ms ease-out; }
  .aiui-cap[data-lit="true"] { background: color-mix(in srgb, #7c3aed 18%, transparent);
    border-color: #7c3aed; }
  .aiui-cap:active:not([disabled]) { transform: translateY(1px);
    background: color-mix(in srgb, currentColor 14%, transparent); }
  .aiui-cap[data-flash="true"] { background: color-mix(in srgb, #16a34a 22%, transparent);
    border-color: #16a34a; transition: none; }
  .aiui-cap[disabled] { opacity: 0.35; cursor: default; }
  .aiui-cap[data-tone="danger"] { border-color: color-mix(in srgb, #dc2626 60%, transparent); }
  .aiui-widget { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
    opacity: 0.9; }
  .aiui-widget select { font: inherit; }
  .aiui-widget .slider input { vertical-align: middle; }
`;

/**
 * The tap-flash runtime, created ONCE in Panel and shared by the command bar
 * and the config strip so the flash closure is not siloed per strip. Owns the
 * flashed signal, its 120ms timer, and the onCleanup that clears it.
 */
export interface CapRuntime {
  dispatch: IntentClient["dispatch"];
  flashed: () => string | undefined;
  tapCap: (command: string, payload?: unknown) => void;
}

export function createCapRuntime(dispatch: IntentClient["dispatch"]): CapRuntime {
  // Verb caps move no region — acknowledge the tap itself with a brief flash.
  const [flashed, setFlashed] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const tapCap = (command: string, payload?: unknown): void => {
    dispatch(command, payload);
    setFlashed(command);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashed(undefined), 120);
  };
  onCleanup(() => clearTimeout(flashTimer));
  return { dispatch, flashed, tapCap };
}

/** A control-bound widget (slider / select / toggle) by registered name. */
function BarWidget(props: { item: () => Extract<BarItem, { kind: "widget" }> }) {
  const ctl = createMemo(() => controlByName(props.item().control));
  return (
    <Show
      when={ctl()}
      fallback={<span class="aiui-widget">missing control: {props.item().control}</span>}
      keyed
    >
      {(control) => (
        <span class="aiui-widget" data-widget={props.item().control}>
          <Switch>
            <Match when={props.item().widget === "slider"}>
              {/* Bare range, no label/readout — text beside a slider relayouts
                  as the value moves (owner); the tooltip carries the name. */}
              <input
                type="range"
                name={props.item().control}
                min={control.meta.min}
                max={control.meta.max}
                step={control.meta.step}
                value={control.get() as number}
                title={`${props.item().label}: ${control.get()}${control.meta.unit ?? ""}`}
                disabled={!props.item().enabled}
                onInput={(e) => control.set(Number(e.currentTarget.value) as never)}
              />
            </Match>
            <Match when={props.item().widget === "toggle"}>
              <ControlToggle of={control as ControlBox<boolean>} label={props.item().label} />
            </Match>
            <Match when={props.item().widget === "select"}>
              <label>
                {props.item().label}
                <select
                  name={props.item().control}
                  disabled={!props.item().enabled}
                  onChange={(e) => control.set(e.currentTarget.value as never)}
                >
                  <For each={(control.meta.options ?? []) as readonly string[]}>
                    {(option) => (
                      <option value={option} selected={control.get() === option}>
                        {option}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Match>
          </Switch>
        </span>
      )}
    </Show>
  );
}

// Keyboard shortcuts are never cap TEXT (owner): keys live in the tooltip
// and the help table; the cap shows icon + stable label.
//
// Rendered POSITION-KEYED (<Repeat>, fine-grained): the DOM node at a
// position PERSISTS while its attributes update in place. This is load-
// bearing for the push-to-talk hold cap — a reference-keyed <For> would
// re-create the button the moment its own lit state flips, detaching the
// node mid-press and losing the pointerup (found live).
const cap = (item: () => Extract<BarItem, { kind: "cap" }> | undefined, runtime: CapRuntime) => {
  const hold = () => item()?.hold;
  return (
    <button
      type="button"
      class="aiui-cap"
      data-command={item()?.command}
      data-lit={item()?.lit ? "true" : "false"}
      data-flash={runtime.flashed() === item()?.command ? "true" : "false"}
      data-tone={item()?.hint.tone}
      data-hold={hold() !== undefined ? "true" : "false"}
      disabled={!item()?.enabled}
      title={(() => {
        const it = item();
        if (it === undefined) {
          return "";
        }
        // UI copy for the one cap whose disablement has a REMEDY the user
        // can take right now (owner, 2026-07-14).
        if (it.command === "selection" && !it.enabled) {
          return "no selection on the page — consider tweak mode (t) and selecting something";
        }
        const h = it.hint;
        return h.key !== "" ? `${h.key} — ${h.label}` : h.label;
      })()}
      onClick={() => {
        const it = item();
        if (it !== undefined && it.hold === undefined) {
          runtime.tapCap(it.command, it.payload);
        }
      }}
      onPointerDown={() => {
        const h = hold();
        if (h !== undefined) {
          runtime.dispatch(h.down);
        }
      }}
      onPointerUp={() => {
        const h = hold();
        if (h !== undefined) {
          runtime.dispatch(h.up);
        }
      }}
      onPointerLeave={() => {
        const h = hold();
        if (h !== undefined && item()?.lit) {
          runtime.dispatch(h.up);
        }
      }}
    >
      {item()?.hint.icon} {item()?.hint.label}
    </button>
  );
};

/** One bar item — a cap or a control widget — over the shared CapRuntime. The
 * `item` prop MUST stay an accessor (never resolved) to keep the cap's node
 * persistent across its own lit flip. */
export function BarItemView(props: { item: () => BarItem | undefined; runtime: CapRuntime }) {
  return (
    <>
      <Show when={props.item()?.kind === "cap"}>
        {cap(props.item as () => Extract<BarItem, { kind: "cap" }> | undefined, props.runtime)}
      </Show>
      <Show when={props.item()?.kind === "widget"}>
        <BarWidget item={props.item as () => Extract<BarItem, { kind: "widget" }>} />
      </Show>
    </>
  );
}

/** The command bar: the mode tree rendered DEPTH-FIRST — each node in
 * declaration order, and a node with revealed children becomes a bracketed
 * group wrapping the parent cap and, recursively, its subtree. A leaf renders
 * bare; the Show flips it into a group exactly when children appear. */
export function CommandBar(props: { items: () => BarTreeNode[]; runtime: CapRuntime }) {
  const renderBranch = (nodes: () => BarTreeNode[]) => (
    <Repeat count={nodes().length}>
      {(index) => {
        const node = () => nodes()[index];
        return (
          <Show
            when={(node()?.children.length ?? 0) > 0}
            fallback={<BarItemView item={() => node()?.item} runtime={props.runtime} />}
          >
            <span class="aiui-group" data-depth={node()?.depth}>
              <BarItemView item={() => node()?.item} runtime={props.runtime} />
              {renderBranch(() => node()?.children ?? [])}
            </span>
          </Show>
        );
      }}
    </Repeat>
  );

  return (
    <div class="aiui-bar" data-testid="command-bar">
      {renderBranch(props.items)}
    </div>
  );
}
