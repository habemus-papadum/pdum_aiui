/**
 * shell.tsx — what every panel document shares, whatever is hosting it: the
 * narration signals (status · toast · the lowered-prompt echo), the panel's own
 * keyboard grammar, and the wire pane that renders the narration.
 *
 * Two entries use this: the plain page the channel serves (`ui/main.tsx`) and
 * the MV3 side panel (`ext/panel.tsx`). The keyboard grammar in particular MUST
 * NOT be duplicated — it is the most behavior-critical code in the client, and
 * two copies would drift the moment one is edited.
 */

import { createEffect, createRoot, Show } from "solid-js";
import type { IntentClient } from "../client";
import { uiScale } from "../config";
import { keyVerdict } from "../keys";

/**
 * Drive the document's root font size off the `uiScale` control (panel zoom —
 * browser zoom does not reach side panels, which is why this exists at all).
 * Shared by both entries, and the APPLY half of zoom restore: the effect runs
 * immediately with the control's current value, so a scale restored by
 * `loadConfigBase()` lands on the document at boot. The frozen client's
 * "zoom restore" ledger bug was exactly this half going wrong — the value
 * came back, the application of it didn't. Returns the disposer.
 */
export function installUiScaleRoot(doc: Document = document): () => void {
  return createRoot((dispose) => {
    createEffect(
      () => uiScale.get() as number,
      (scale) => {
        doc.documentElement.style.fontSize = `${Math.round(scale * 100)}%`;
      },
    );
    return dispose;
  });
}

/** The panel's running commentary — one set of signals, shared by the panes. */
export interface Narration {
  statusLine: () => string;
  setStatusLine: (line: string) => void;
  toastLine: () => string | undefined;
  toast: (message: string) => void;
  loweredPrompt: () => string | undefined;
  setLoweredPrompt: (prompt: string | undefined) => void;
}

/**
 * The panel document's keys. NOT the modal grammar — that is `keys.ts`, and it
 * belongs to the machine. These are the document's own affordances, layered
 * around it:
 *
 *  - the **activation gesture** (⌘B on the plain page; the extension's command
 *    chord arrives from the service worker instead — an imperative event from
 *    outside, never a key in the grammar. See activation.ts);
 *  - **panel zoom** (⌘+/⌘−/⌘0), registered before the grammar so it wins
 *    mid-turn, as the old panel did;
 *  - **Esc**, which steps out even when the grammar claims nothing: on the
 *    TARGET page keys belong to the page, but in the panel's own document Esc
 *    may still disarm.
 *
 * Returns the uninstaller.
 */
export function installPanelKeys(config: {
  client: IntentClient;
  activate?: () => void;
  onBlip?: (key: string) => void;
}): () => void {
  const { client } = config;
  const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (config.activate !== undefined && event.metaKey && event.key === "b") {
      event.preventDefault();
      config.activate();
      return;
    }
    if (event.metaKey && phase === "down") {
      const scale = uiScale.get() as number;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        uiScale.set((Math.round((scale + 0.1) * 10) / 10) as never);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        uiScale.set((Math.round((scale - 0.1) * 10) / 10) as never);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        uiScale.set(1 as never);
        return;
      }
    }
    const verdict = keyVerdict(client.state(), event.key, phase, event.repeat);
    if (verdict.kind === "pass") {
      if (phase === "down" && event.key === "Escape" && client.canDispatch("escape")) {
        event.preventDefault();
        client.dispatch("escape");
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    client.handleKey(event.key, phase, event.repeat);
  };
  const down = onKey("down");
  const up = onKey("up");
  const blur = (): void => {
    client.emit("windowBlur");
  };
  document.addEventListener("keydown", down, true);
  document.addEventListener("keyup", up, true);
  window.addEventListener("blur", blur);
  return () => {
    document.removeEventListener("keydown", down, true);
    document.removeEventListener("keyup", up, true);
    window.removeEventListener("blur", blur);
  };
}

/** The wire's narration: status line · toast · the lowered-prompt echo. */
export function WirePane(props: { narration: Narration }) {
  return (
    <div style="margin: 8px 12px; font: 12px system-ui; opacity: 0.85; max-width: 460px">
      <Show when={props.narration.toastLine()}>
        {(line) => (
          <div style="color: #dc2626; border: 1px solid #dc2626; border-radius: 6px; padding: 4px 8px; margin-bottom: 6px">
            {line()}
          </div>
        )}
      </Show>
      <Show when={props.narration.statusLine() !== ""}>
        <div style="opacity: 0.7">{props.narration.statusLine()}</div>
      </Show>
      <Show when={props.narration.loweredPrompt()}>
        {(prompt) => (
          <details style="margin-top: 6px" open>
            <summary>lowered prompt (the channel's echo of the sent turn)</summary>
            <pre style="white-space: pre-wrap; font: 11px ui-monospace, monospace">{prompt()}</pre>
          </details>
        )}
      </Show>
    </div>
  );
}
