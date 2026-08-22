/**
 * StatTiles.tsx — the headline numbers of the current cross-filter selection,
 * kept live by the durable stats client (store.stats): reviews in view (of
 * the whole catalog), the average critic score, and the median price.
 */
import { Show } from "solid-js";
import { store } from "../model/store";

const fmt = (n: number) => n.toLocaleString("en-US");

function Tile(props: { value: string; label: string; hint?: string }) {
  return (
    <div class="tile">
      <div class="tile-value">{props.value}</div>
      <div class="tile-label">{props.label}</div>
      <Show when={props.hint}>
        <div class="tile-hint">{props.hint}</div>
      </Show>
    </div>
  );
}

export function StatTiles() {
  const total = () => store.summary()?.rowsTotal ?? 0;
  const filtered = () => store.stats()?.rows ?? total();
  const pct = () => {
    const t = total();
    return t > 0 ? Math.round((filtered() / t) * 100) : 100;
  };
  const avgPoints = () => store.stats()?.avgPoints ?? null;
  const medianPrice = () => store.stats()?.medianPrice ?? null;
  return (
    <div class="tiles" data-cell="wine-stats">
      <Tile value={fmt(filtered())} label="reviews in view" hint={`${pct()}% of ${fmt(total())}`} />
      <Tile
        value={avgPoints() != null ? (avgPoints() as number).toFixed(1) : "–"}
        label="avg points"
        hint="critic score, 80–100"
      />
      <Tile
        value={medianPrice() != null ? `$${Math.round(medianPrice() as number)}` : "–"}
        label="median price"
        hint="per bottle"
      />
    </div>
  );
}
