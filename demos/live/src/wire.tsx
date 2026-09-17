/**
 * wire.tsx — page 1: the WIRE alone. No app, no reasoning: a scripted
 * backend whose delay you set, so every number on the task table is about
 * the voice connection — how long after you stop talking the delegation
 * arrives, how long after an append the first word is spoken, what the
 * 15-second WebRTC charge looks like on the meter, whether the laptop mic
 * hears the reply (say something while it talks).
 */

import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import "./styles.css";
import { Bench } from "./live/Bench";
import { WIRE_SLOTS } from "./live/prompt";
import { Nav } from "./ui/Nav";

function WirePage() {
  const [delay, setDelay] = createSignal(1500);
  return (
    <div class="app">
      <Nav current="wire" />
      <header class="app-head">
        <h1>wire · the voice connection alone</h1>
        <p class="app-sub">
          Connect, then say anything: "set it to five", "what time is it", a number. The prompt
          tells the model to delegate everything; the scripted backend waits the delay below and
          answers. Read the task table: <b>↦</b> is how long after the delegation the backend's
          append went out (your delay),
          <b> 🔊</b> how long after that the first word was spoken, <b>∑</b> the whole ticket. The
          ledger has every event with its time since connect.
        </p>
      </header>
      <Bench
        options={{ slots: WIRE_SLOTS, scriptedDelayMs: delay }}
        backends={["scripted", "echo"]}
        initial="scripted"
      >
        <div class="bench-row">
          <label class="bench-knob">
            scripted delay {delay()} ms
            <input
              type="range"
              min="0"
              max="20000"
              step="250"
              value={delay()}
              onInput={(event) => setDelay(Number(event.currentTarget.value))}
            />
          </label>
          <span class="bench-hint">
            past 9 s the session speaks its own "still working" line — that is the progress policy,
            not the backend
          </span>
        </div>
      </Bench>
    </div>
  );
}

render(
  () => (
    <PageBoundary name="wire">
      <WirePage />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
