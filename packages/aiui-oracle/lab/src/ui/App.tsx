/**
 * App.tsx — the bench: the wave app (cells + widgets) with the oracle wired
 * in as its control surface, plus the affordances that exercise every event
 * the viewer tracks: ad-hoc text, images, live instruction edits, and live
 * tool-surface changes (per-tool toggles → setTools).
 */

import {
  OracleSession,
  type OracleTool,
  onControlSurfaceChange,
  pasteKeySource,
  toolsFromControlSurface,
  weaveInstructions,
  webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import { OracleControl, OracleViewer } from "@habemus-papadum/aiui-oracle/widgets";
import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { createEffect, createSignal, For, onCleanup, untrack } from "solid-js";
import { amplitude, damping, freq, grid, kick, waveform } from "../model/store";
import { Wave } from "./Wave";

const APP_BLURB =
  "A standing-wave visualizer. One animated wave; controls for frequency (Hz), " +
  "amplitude, damping, waveform family, and a reference grid; a kick action that " +
  "sends a decaying ripple through the wave.";

export function App() {
  // The projection is a deliberate SNAPSHOT of the surface (values feed the
  // schemas) — untracked on purpose; re-projection on surface change is what
  // keeps it live.
  const [allTools, setAllTools] = createSignal<OracleTool[]>(
    untrack(() => toolsFromControlSurface()),
  );
  const [enabledNames, setEnabledNames] = createSignal<Set<string>>(
    new Set(untrack(() => toolsFromControlSurface()).map((tool) => tool.name)),
  );
  const initialInstructions = weaveInstructions({ app: APP_BLURB });
  const [instructions, setInstructions] = createSignal(initialInstructions);
  const [draft, setDraft] = createSignal("");

  const session = new OracleSession({
    config: { instructions: initialInstructions, tools: untrack(() => toolsFromControlSurface()) },
    keySource: pasteKeySource(),
    transport: webRtcTransport(),
  });
  onCleanup(onControlSurfaceChange(() => setAllTools(untrack(() => toolsFromControlSurface()))));
  onCleanup(() => session.close());

  // The LIVE surface: toggles or a re-projection change what the model holds
  // mid-session (setTools no-ops the wire until a session exists).
  createEffect(
    () => ({ tools: allTools(), on: enabledNames() }),
    ({ tools, on }) => {
      session.setTools(tools.filter((tool) => on.has(tool.name)));
    },
  );

  const sendDraft = () => {
    const text = draft().trim();
    if (text !== "") {
      session.sendText(text);
      setDraft("");
    }
  };

  const sendImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const caption = draft().trim();
      session.sendImage(String(reader.result), caption === "" ? undefined : caption);
      setDraft("");
    };
    reader.readAsDataURL(file);
  };

  return (
    <div class="lab">
      <h1>oracle lab — talk to the wave</h1>
      <div class="lab-panel">
        <Wave />
      </div>
      <div class="lab-panel lab-controls">
        <ControlSlider of={freq} label="frequency" />
        <ControlSlider of={amplitude} label="amplitude" />
        <ControlSlider of={damping} label="damping" />
        <label>
          waveform
          <select
            value={waveform.get() as string}
            onChange={(event) => waveform.set(event.currentTarget.value)}
          >
            <option value="sine">sine</option>
            <option value="square">square</option>
            <option value="saw">saw</option>
          </select>
        </label>
        <ControlToggle of={grid} label="grid" />
        <button type="button" onClick={() => kick.run()}>
          kick
        </button>
      </div>
      <div class="lab-panel">
        <OracleControl session={session} />
        <div class="lab-composer">
          <input
            type="text"
            placeholder="type to the oracle (Enter sends; with an image, this is the caption)"
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                sendDraft();
              }
            }}
          />
          <button type="button" onClick={sendDraft}>
            send
          </button>
          <label class="lab-attach">
            image…
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) {
                  sendImageFile(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        <details class="lab-fold">
          <summary>instructions (live)</summary>
          <textarea
            rows={6}
            value={instructions()}
            onInput={(event) => setInstructions(event.currentTarget.value)}
          />
          <button type="button" onClick={() => session.setInstructions(instructions())}>
            apply
          </button>
        </details>
        <details class="lab-fold">
          <summary>tools (live)</summary>
          <div class="lab-tool-toggles">
            <For each={allTools()}>
              {(tool) => (
                <label>
                  <input
                    type="checkbox"
                    checked={enabledNames().has(tool.name)}
                    onChange={(event) => {
                      const next = new Set(enabledNames());
                      if (event.currentTarget.checked) {
                        next.add(tool.name);
                      } else {
                        next.delete(tool.name);
                      }
                      setEnabledNames(next);
                    }}
                  />
                  {tool.name}
                </label>
              )}
            </For>
          </div>
        </details>
      </div>
      <div class="lab-panel">
        <OracleViewer session={session} />
      </div>
    </div>
  );
}
