import { AudioControl, useAudioHub } from "@habemus-papadum/aiui-audio/widgets";
import { VendorKeyInput } from "@habemus-papadum/aiui-dock";
import { bridgeEffect, CellView } from "@habemus-papadum/aiui-viz";
import { LiveDiffText } from "@habemus-papadum/aiui-viz/live-text";
import { createSignal, onCleanup, Show, untrack } from "solid-js";
import { graph } from "../model/graph";
import { appScope, demoFor, fallbackAudio } from "../model/store";

function Transcript(props: { text: () => string }) {
  const host = document.createElement("div");
  host.className = "audio-demo-transcript";
  host.setAttribute("aria-live", "polite");
  const view = new LiveDiffText(host, {
    classes: { add: "audio-demo-added", del: "audio-demo-deleted" },
  });
  bridgeEffect(props.text, (text) => view.update(text), { scope: appScope, name: "transcript" });
  onCleanup(() => view.clear());
  return host;
}
export function App() {
  const hub = useAudioHub() ?? fallbackAudio();
  const model = untrack(() => demoFor(hub));
  const [busy, setBusy] = createSignal(false);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    model.error.set("");
    void fn()
      .catch((cause: unknown) =>
        model.error.set(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <article class="audio-demo">
      <header>
        <h1>One microphone, different listeners</h1>
        <p class="lede">
          Dictate with ElevenLabs, ask Oracle to edit the text, then return to dictation. Park the
          input at any time while both sessions stay connected.
        </p>
      </header>
      <section id="audio">
        <h2>audio</h2>
        <AudioControl hub={hub} />
      </section>
      <section id="dictation">
        <h2>dictation and editing</h2>
        <div class="audio-demo-buttons">
          <button
            type="button"
            disabled={busy() || model.state.get() === "dictating"}
            onClick={() => run(model.dictate)}
          >
            Start dictation
          </button>
          <button
            type="button"
            disabled={busy() || model.state.get() !== "dictating"}
            onClick={() => run(model.finish)}
          >
            Finish dictation
          </button>
          <button
            type="button"
            disabled={busy() || model.state.get() === "editing"}
            onClick={() => run(model.edit)}
          >
            Edit with Oracle
          </button>
          <button
            type="button"
            disabled={busy() || model.state.get() !== "editing"}
            onClick={() => run(model.returnToDictation)}
          >
            Return to dictation
          </button>
          <button type="button" disabled={busy()} onClick={() => run(model.close)}>
            Close sessions
          </button>
        </div>
        <CellView of={graph().transcript}>
          {(value) => (
            <Transcript text={() => value().text || "Your transcript will appear here."} />
          )}
        </CellView>
        <p>Appended words appear immediately. Revised words briefly show what changed.</p>
        <Show when={model.error.get()}>{(message) => <p role="alert">{message()}</p>}</Show>
      </section>
      <section id="credentials">
        <h2>credentials</h2>
        <VendorKeyInput provider="elevenlabs" />
        <VendorKeyInput provider="openai" />
      </section>
      <section id="routing">
        <h2>what stays connected</h2>
        <p>
          The input meter measures the microphone before routing. “Park input” sends speech to
          nobody and keeps the microphone available. “Microphone off” releases the device. Session
          connections and playback are controlled separately.
        </p>
      </section>
    </article>
  );
}
