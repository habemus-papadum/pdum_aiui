/**
 * StatTiles.tsx — the headline numbers of the current cross-filter selection:
 * how many events are in view (of the whole catalog), the live Gutenberg–Richter
 * b-value and its uncertainty, the completeness magnitude driving that fit, the
 * complete-sample size, and the largest magnitude selected. All derived from the
 * one durable histogram signal through the graph's grStats memo, so they move the
 * instant a brush changes. The tile row is stamped `data-cell` for attribution.
 */
import { Show } from "solid-js";
import { seismosGraph } from "../graph";
import { store } from "../store";

const fmt = (n: number) => n.toLocaleString("en-US");

function Tile(props: { value: string; label: string; hint?: string; dim?: boolean }) {
  return (
    <div class={props.dim ? "tile tile-dim" : "tile"}>
      <div class="tile-value">{props.value}</div>
      <div class="tile-label">{props.label}</div>
      <Show when={props.hint}>
        <div class="tile-hint">{props.hint}</div>
      </Show>
    </div>
  );
}

export function StatTiles() {
  const g = () => seismosGraph().grStats();
  const total = () => store.summary()?.rowsTotal ?? 0;
  const filtered = () => g()?.rowsFiltered ?? 0;
  const pct = () => {
    const t = total();
    return t > 0 ? Math.round((filtered() / t) * 100) : 100;
  };
  const fit = () => g()?.fit ?? null;
  const maxMag = () => {
    const bins = g()?.bins ?? [];
    return bins.length ? bins[bins.length - 1].mag : null;
  };

  return (
    <div class="tiles" data-cell="grStats">
      <Tile value={fmt(filtered())} label="events in view" hint={`${pct()}% of ${fmt(total())}`} />
      <Tile
        value={fit() ? `${fit()?.b.toFixed(2)} ± ${fit()?.sigmaB.toFixed(3)}` : "—"}
        label="b-value"
        hint="MLE, M ≥ Mc"
        dim={!fit()}
      />
      <Tile value={store.mc.get().toFixed(1)} label="completeness Mc" hint="fit threshold" />
      <Tile
        value={fit() ? fmt(fit()?.nComplete ?? 0) : "—"}
        label="events ≥ Mc"
        hint="the fitted sample"
        dim={!fit()}
      />
      <Tile
        value={maxMag() != null ? (maxMag() as number).toFixed(1) : "—"}
        label="largest M"
        hint="in selection"
        dim={maxMag() == null}
      />
    </div>
  );
}
