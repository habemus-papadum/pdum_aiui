/**
 * Tiles.tsx — headline numbers for the frame under the playhead: the order, the
 * domino count n(n+1), the (astronomical) number of tilings 2^(n(n+1)/2), and
 * the live frozen fraction. Stat tiles, not a chart — these are single current
 * values (the dataviz "is it even a chart?" answer).
 */
import { Show } from "solid-js";
import { aztecGraph } from "../graph";

function Tile(props: { label: string; value: string; hint?: string }) {
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

export function Tiles() {
  const frame = () => aztecGraph().currentFrame();
  const exponent = () => {
    const n = frame()?.n ?? 0;
    return (n * (n + 1)) / 2;
  };
  return (
    <div class="tiles">
      <Tile label="order" value={frame() ? `AD(${frame()?.n})` : "—"} hint="Aztec diamond" />
      <Tile label="dominoes" value={frame() ? String(frame()?.dominoes) : "—"} hint="= n(n+1)" />
      <Tile label="tilings" value={frame() ? `2^${exponent()}` : "—"} hint="= 2^(n(n+1)/2)" />
      <Tile
        label="frozen fraction"
        value={frame() ? `${(100 * (frame()?.frozenFraction ?? 0)).toFixed(1)}%` : "—"}
        hint="corners matching type"
      />
    </div>
  );
}
