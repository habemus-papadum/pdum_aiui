/**
 * The Turn pane — a TEMPORARY helper (it retires into the command bar): the
 * compose box (text → `engine.contribute`, one segment per submission), the
 * selection slurp, Send and cancel. The turn's CONTENT is not here: the
 * transcript preview lives directly under the command bar, permanently
 * visible (main.tsx), because it is the panel's centre of gravity — not a
 * pane tenant.
 */

import type { Engine } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { Pane } from "@habemus-papadum/aiui-webext";
import { createSignal, Show } from "solid-js";

export interface TurnPaneProps {
  engine: Engine;
  /** Bumped by the host after every engine event (drives re-derivation). */
  rev: () => number;
  /** A turn is open — the only state where content may enter (§13.6). */
  canCompose: () => boolean;
  /** Called when an act needs a turn and none is open (status hint). */
  onNoTurn: () => void;
  /** Send/cancel route through the panel's state machine, never the engine
   * directly — the machine owns phase, re-arm, and capture teardown. */
  onSend: () => void;
  onCancel: () => void;
  loweredPrompt: () => string | undefined;
  /** The slurp command (pull model): add the active tab's selection now. */
  onAddSelection: () => void;
  /** The active tab currently has a non-empty selection (affordance only). */
  selectionPresent: () => boolean;
}

export function TurnPane(props: TurnPaneProps) {
  const [text, setText] = createSignal("");

  const threadOpen = () => {
    props.rev();
    return props.engine.threadOpen;
  };

  const addText = (): void => {
    const t = text().trim();
    if (t === "") {
      return;
    }
    if (!props.canCompose()) {
      props.onNoTurn(); // §13.6: nothing enters outside a turn; ⌘B opens one
      return;
    }
    props.engine.contribute(t);
    setText("");
  };
  const send = (): void => {
    addText();
    props.onSend();
  };
  const cancel = (): void => {
    props.onCancel();
  };

  return (
    <Pane title="Turn" hint={threadOpen() ? "open" : "idle"}>
      <div class="row">
        <textarea
          rows={3}
          placeholder="what should the session do?  (⏎ adds to the turn; Send finalizes)"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              addText();
            }
          }}
        />
      </div>
      <div class="row">
        <button type="button" class="chan" onClick={send}>
          Send
        </button>
        <button type="button" class="ghost" onClick={addText}>
          add to turn
        </button>
        <button type="button" class="ghost" onClick={() => props.onAddSelection()}>
          add selection{props.selectionPresent() ? " ●" : ""}
        </button>
        <Show when={threadOpen()}>
          <button type="button" class="ghost" onClick={cancel}>
            cancel turn
          </button>
        </Show>
      </div>
      <Show when={props.loweredPrompt() !== undefined}>
        <details>
          <summary class="kv">last sent prompt (as lowered)</summary>
          <pre class="kv" style={{ "white-space": "pre-wrap", "word-break": "break-word" }}>
            {props.loweredPrompt()}
          </pre>
        </details>
      </Show>
    </Pane>
  );
}
