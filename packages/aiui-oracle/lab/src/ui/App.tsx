/**
 * App.tsx — the bench: the wave app (cells + widgets) with the oracle wired
 * in as its control surface. The composition an integrating app would write:
 * a session over the projected tool surface, the control strip, a ledger.
 */

import {
  OracleSession,
  onControlSurfaceChange,
  pasteKeySource,
  toolsFromControlSurface,
  weaveInstructions,
  webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import { OracleControl } from "@habemus-papadum/aiui-oracle/widgets";
import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { onCleanup, untrack } from "solid-js";
import { amplitude, damping, freq, grid, kick, waveform } from "../model/store";
import { Ledger } from "./Ledger";
import { Wave } from "./Wave";

export function App() {
  // The projection is a deliberate SNAPSHOT of the surface (values feed the
  // schemas), not a subscription — untracked on purpose; the
  // onControlSurfaceChange re-projection below is what keeps it live.
  const session = new OracleSession({
    config: {
      instructions: weaveInstructions({
        app:
          "A standing-wave visualizer. One animated wave; controls for frequency (Hz), " +
          "amplitude, damping, waveform family, and a reference grid; a kick action that " +
          "sends a decaying ripple through the wave.",
      }),
      tools: untrack(() => toolsFromControlSurface()),
    },
    keySource: pasteKeySource(),
    transport: webRtcTransport(),
  });
  // The live surface (day-one decision): a control/action declared later —
  // HMR, lazy modules — re-projects into the session.
  onCleanup(onControlSurfaceChange(() => session.setTools(toolsFromControlSurface())));
  onCleanup(() => session.close());

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
      </div>
      <div class="lab-panel">
        <Ledger session={session} />
      </div>
    </div>
  );
}
