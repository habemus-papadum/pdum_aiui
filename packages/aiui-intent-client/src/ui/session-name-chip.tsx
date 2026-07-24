/**
 * session-name-chip.tsx — the panel's remote identity, visible and editable.
 *
 * The session name is what the iPad pickers (/pencil, /bar) list for this
 * panel — with two windows open it is the only thing telling them apart
 * (BEHAVIOR-level rationale in ../session-name.ts). The chip sits under the
 * channel header; clicking the name opens an inline rename (Enter commits,
 * Esc cancels, blur commits). A rename re-registers on both wires live, so an
 * open picker updates without a reconnect.
 *
 * The input is safe under the panel's key capture: installPanelKeys
 * (shell.tsx) yields to typing targets before the grammar sees a key.
 */

import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

/** How an entry hands the name to the layout: a reactive read + the renamer. */
export interface SessionNameControl {
  name: () => string;
  rename: (next: string) => void;
}

export const SESSION_NAME_STYLES = `
  .aiui-session-name { margin: 6px 12px 0; font: 12px system-ui;
    display: inline-flex; align-items: center; gap: 6px; }
  .aiui-session-name-tag { opacity: 0.55; }
  .aiui-session-name button { font: inherit; color: inherit; background: transparent;
    border: 1px dashed color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 999px; padding: 1px 8px; cursor: pointer; }
  .aiui-session-name input { font: inherit; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
    border-radius: 999px; padding: 1px 8px; width: 14em; }
`;

export function SessionNameChip(props: SessionNameControl): JSX.Element {
  const [editing, setEditing] = createSignal(false, { ownedWrite: true });
  let inputRef: HTMLInputElement | undefined;
  const commit = (): void => {
    const next = inputRef?.value.trim() ?? "";
    setEditing(false);
    if (next !== "" && next !== props.name()) {
      props.rename(next);
    }
  };
  return (
    <div class="aiui-session-name" data-testid="session-name">
      <span class="aiui-session-name-tag">appears to remotes as</span>
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            title="rename this session (what the iPad pickers show)"
            onClick={() => setEditing(true)}
          >
            {props.name()}
          </button>
        }
      >
        <input
          ref={(el) => {
            inputRef = el;
            queueMicrotask(() => {
              el.focus();
              el.select();
            });
          }}
          value={props.name()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
            event.stopPropagation();
          }}
          onBlur={commit}
        />
      </Show>
    </div>
  );
}
