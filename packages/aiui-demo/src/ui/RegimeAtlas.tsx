/**
 * RegimeAtlas.tsx — the (F, k) parameter plane as an interactive map.
 *
 * d3 supplies the scales and tick math; Solid renders the SVG — no
 * d3-selection, no imperative DOM. Click anywhere to move the simulation to
 * that point in parameter space; click a catalog point to jump to a named
 * regime. The crosshair tracks the live (F, k) reactively, and the whole
 * panel is a CellView over the (slow-downloading) catalog cell — so it
 * shows a progress stripe while the "dataset" arrives, keeps the previous map
 * dimmed during a re-download, and offers Retry on simulated failure.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { scaleLinear } from "d3";
import { For, Show } from "solid-js";
import { morphoGraph } from "../model/graph";
import type { Regime } from "../model/regime-data";
import { paramF, paramK } from "../model/store";
import { SERIES } from "./theme";

const W = 420;
const H = 300;
const M = { top: 12, right: 14, bottom: 34, left: 46 };

export function RegimeAtlas() {
  const g = () => morphoGraph();
  const x = scaleLinear()
    .domain([0.03, 0.075]) // k
    .range([M.left, W - M.right]);
  const y = scaleLinear()
    .domain([0.005, 0.09]) // F
    .range([H - M.bottom, M.top]);

  const jump = (r: Regime) => {
    paramF.set(r.F);
    paramK.set(r.k);
  };
  const clickPlane = (e: MouseEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    const k = x.invert(px);
    const F = y.invert(py);
    if (k >= 0.03 && k <= 0.075 && F >= 0.005 && F <= 0.09) {
      paramK.set(Number(k.toFixed(4)));
      paramF.set(Number(F.toFixed(4)));
    }
  };

  return (
    <div class="panel">
      <div class="panel-head">
        <h2>regime atlas</h2>
        <span class="panel-sub">Pearson's (F, k) plane — click to travel</span>
      </div>
      <Show when={g()}>
        {(graph) => (
          <CellView of={graph().catalog} label="downloading regime catalog">
            {(regimes) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: pointer-first parameter plane; the regime table is the keyboard-accessible twin
              <svg
                viewBox={`0 0 ${W} ${H}`}
                class="atlas"
                role="img"
                aria-label="regime map in feed/kill parameter space"
                onClick={clickPlane}
              >
                {/* axes */}
                <For each={x.ticks(5)}>
                  {(t) => (
                    <g>
                      <line x1={x(t)} x2={x(t)} y1={M.top} y2={H - M.bottom} class="atlas-grid" />
                      <text x={x(t)} y={H - M.bottom + 16} class="atlas-tick" text-anchor="middle">
                        {t.toFixed(3)}
                      </text>
                    </g>
                  )}
                </For>
                <For each={y.ticks(5)}>
                  {(t) => (
                    <g>
                      <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} class="atlas-grid" />
                      <text x={M.left - 8} y={y(t) + 3} class="atlas-tick" text-anchor="end">
                        {t.toFixed(2)}
                      </text>
                    </g>
                  )}
                </For>
                <text x={W - M.right} y={H - 6} class="atlas-axis" text-anchor="end">
                  kill k →
                </text>
                <text x={12} y={M.top + 4} class="atlas-axis">
                  feed F ↑
                </text>

                {/* catalog points (streaming in as the download progresses) */}
                <For each={regimes()}>
                  {(r) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: same pointer-first affordance; regime rows in the table are focusable
                    <g
                      class="atlas-point"
                      onClick={(e) => {
                        e.stopPropagation();
                        jump(r);
                      }}
                    >
                      <circle cx={x(r.k)} cy={y(r.F)} r={9} fill="transparent" />
                      <circle cx={x(r.k)} cy={y(r.F)} r={4} fill={SERIES().blue} />
                      <text x={x(r.k) + 7} y={y(r.F) + 3} class="atlas-label">
                        {r.name}
                      </text>
                    </g>
                  )}
                </For>

                {/* the live (F, k) crosshair */}
                <g class="atlas-cursor">
                  <line x1={x(paramK.get())} x2={x(paramK.get())} y1={M.top} y2={H - M.bottom} />
                  <line x1={M.left} x2={W - M.right} y1={y(paramF.get())} y2={y(paramF.get())} />
                  <circle cx={x(paramK.get())} cy={y(paramF.get())} r={6} />
                </g>
              </svg>
            )}
          </CellView>
        )}
      </Show>
    </div>
  );
}
