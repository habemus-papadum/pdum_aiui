/**
 * Legend.tsx — the color key. Identity is never color-alone: each row pairs the
 * swatch with the type letter and how that domino moves under a shuffle step,
 * which is also the corner it freezes into.
 */
import { For } from "solid-js";
import { LEGEND } from "../palette";

export function Legend() {
  return (
    <div class="aztec-legend">
      <For each={LEGEND}>
        {(row) => (
          <span class="aztec-legend-item">
            <i style={{ background: row.color }} />
            <b>{row.name}</b>
            <span class="dim">{row.moves}</span>
          </span>
        )}
      </For>
    </div>
  );
}
