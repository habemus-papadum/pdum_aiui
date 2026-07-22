/**
 * StatsTiles.tsx — headline observables as stat tiles (the dataviz "is it
 * even a chart?" answer for single current values). The live pair comes from
 * the snapshot signal (4 Hz loop bridge); the census pair comes from the
 * analysis cell and dims while a fresher run is in flight.
 */
import { Show } from "solid-js";
import { morphoGraph } from "../model/graph";
import { sim, snapshot } from "../model/store";

function Tile(props: {
  label: string;
  value: string;
  hint?: string;
  dim?: boolean;
  cell?: string;
}) {
  return (
    <div class={props.dim ? "tile tile-dim" : "tile"} data-cell={props.cell}>
      <div class="tile-value">{props.value}</div>
      <div class="tile-label">{props.label}</div>
      <Show when={props.hint}>
        <div class="tile-hint">{props.hint}</div>
      </Show>
    </div>
  );
}

export function StatsTiles() {
  const snap = snapshot.get;
  const analysis = () => morphoGraph().analysis;
  const census = () => analysis().latest();
  const stale = () => analysis().loading();
  // Loop health re-read on every snapshot tick, so the tile stays fresh.
  const loopStats = () => {
    snap();
    return sim.loop.stats();
  };
  return (
    <div class="tiles">
      <Tile
        label="pattern coverage"
        value={snap() ? `${(100 * (snap()?.coverage ?? 0)).toFixed(1)}%` : "—"}
        hint="V > 0.1, live"
      />
      <Tile
        label="contrast σ(V)"
        value={snap() ? (snap()?.contrast ?? 0).toFixed(3) : "—"}
        hint="live"
      />
      <Tile
        cell="analysis"
        label="spots"
        value={census() ? String(census()?.census.count) : "—"}
        hint={
          census() ? `mean area ${Math.round(census()?.census.meanArea ?? 0)} px²` : "run analysis"
        }
        dim={stale()}
      />
      <Tile
        cell="analysis"
        label="wavelength"
        value={census()?.wavelength !== undefined ? `${census()?.wavelength} px` : "—"}
        hint={census()?.phase === "census" ? "computing…" : "autocorrelation peak"}
        dim={stale()}
      />
      <Tile
        label="sim"
        value={`${loopStats().fps} fps`}
        hint={`${loopStats().stepsPerSecond.toLocaleString()} steps/s`}
      />
    </div>
  );
}
