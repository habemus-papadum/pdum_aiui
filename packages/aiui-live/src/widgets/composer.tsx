/**
 * composer.tsx — the hands-on instrument: send any of the three appends by
 * hand, session-wide or on an open delegation, or type a request as if it
 * had been spoken. This is how the vendor's claims about what each append
 * DOES were checked (commentary is paraphrased; thinking is quiet;
 * instructions can interrupt speech).
 */

import { createSignal, For } from "solid-js";
import type { LiveSession } from "../session";
import { useLiveState } from "./state";

export interface LiveComposerProps {
  session: LiveSession;
}

type Mode = "say" | "note" | "steer" | "typed";

export function LiveComposer(props: LiveComposerProps) {
  const state = useLiveState(props.session);
  const [mode, setMode] = createSignal<Mode>("say");
  const [target, setTarget] = createSignal<string>("");
  const [draft, setDraft] = createSignal("");
  const openTasks = () =>
    state().tasks.filter((task) => task.status === "open" && task.target !== "local");

  const send = () => {
    const text = draft().trim();
    if (text === "") {
      return;
    }
    const delegationId = target() === "" ? null : target();
    switch (mode()) {
      case "say":
        void props.session.say(text, { delegationId });
        break;
      case "note":
        void props.session.note(text, { delegationId });
        break;
      case "steer":
        void props.session.steer(text, { delegationId });
        break;
      case "typed":
        props.session.sendText(text);
        break;
    }
    setDraft("");
  };

  return (
    <div class="aiui-live-composer">
      <select
        value={mode()}
        onChange={(event) => setMode(event.currentTarget.value as Mode)}
        title="which append (or typed input)"
      >
        <option value="say">say (commentary)</option>
        <option value="note">note (thinking)</option>
        <option value="steer">steer (instructions)</option>
        <option value="typed">typed request</option>
      </select>
      <select
        value={target()}
        onChange={(event) => setTarget(event.currentTarget.value)}
        disabled={mode() === "typed"}
        title="delegation id (blank = session-wide)"
      >
        <option value="">session-wide</option>
        <For each={openTasks()}>
          {(task) => <option value={task.id}>{`#${task.seq} ${task.id.slice(0, 14)}`}</option>}
        </For>
      </select>
      <input
        type="text"
        value={draft()}
        placeholder={
          mode() === "typed" ? "type a request, as if spoken" : "text to append (Enter sends)"
        }
        disabled={state().status !== "live"}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            send();
          }
        }}
      />
      <button type="button" disabled={state().status !== "live"} onClick={send}>
        send
      </button>
    </div>
  );
}
