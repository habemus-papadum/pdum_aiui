/**
 * RegimeTable.tsx — the catalog as a table (the accessibility twin of the
 * atlas: same data, tabular form). Rows appear as the simulated download
 * streams them — the cell commits every chunk, so the table literally fills
 * in packet by packet. Click a row to jump the simulation there.
 */
import { CellView, ControlToggle } from "@habemus-papadum/aiui-viz";
import { For } from "solid-js";
import { morphoGraph } from "../model/graph";
import type { Regime } from "../model/regime-data";
import { failNextFetch, paramF, paramK } from "../model/store";

export function RegimeTable() {
  const g = () => morphoGraph();
  const jump = (r: Regime) => {
    paramF.set(r.F);
    paramK.set(r.k);
  };
  const active = (r: Regime) =>
    Math.abs(paramF.get() - r.F) < 0.0008 && Math.abs(paramK.get() - r.k) < 0.0008;
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>regime catalog</h2>
        <span class="panel-sub">
          <ControlToggle of={failNextFetch} label="fail next fetch" />
          <button type="button" class="btn btn-outline" onClick={() => g().reloadCatalog()}>
            re-download
          </button>
        </span>
      </div>
      <CellView of={g().catalog} label="downloading regime catalog">
        {(regimes) => (
          <div class="regime-table-scroll">
            <table class="regime-table">
              <thead>
                <tr>
                  <th>regime</th>
                  <th>class</th>
                  <th>F</th>
                  <th>k</th>
                  <th>character</th>
                </tr>
              </thead>
              <tbody>
                <For each={regimes()}>
                  {(r) => (
                    <tr class={active(r) ? "active" : undefined} onClick={() => jump(r)}>
                      <td>{r.name}</td>
                      <td class="mono">{r.pearson ?? "—"}</td>
                      <td class="mono">{r.F.toFixed(4)}</td>
                      <td class="mono">{r.k.toFixed(4)}</td>
                      <td class="dim">{r.character}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </CellView>
    </div>
  );
}
