/**
 * Permanents.tsx — the connection to permanents of matrices, made live.
 *
 * The prose explains why counting tilings is counting perfect matchings is a
 * permanent (and why that is normally hard); the table shows Ryser's permanent
 * of AD(n)'s biadjacency matrix landing exactly on the EKLP closed form.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { aztecGraph } from "../graph";

export function Permanents() {
  const g = () => aztecGraph();
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>tilings = permanents</h2>
        <span class="panel-sub">Ryser vs the EKLP closed form</span>
      </div>
      <p class="aztec-prose">
        A domino tiling of AD(n) is a perfect matching of its dual graph — a vertex on every unit
        cell, an edge between cells that share a side. That graph is bipartite (2-color the cells
        like a checkerboard), so the number of perfect matchings is the <b>permanent</b> of the
        black×white biadjacency matrix. Permanents are <b>#P-hard</b> in general (Valiant, 1979) —
        the determinant's twin without the cancelling signs, and no known polynomial algorithm — yet
        EKLP proved this particular count is exactly <span class="mono">2^(n(n+1)/2)</span>. The
        table computes the permanent bare-handed with Ryser's inclusion–exclusion formula and checks
        it against the formula.
      </p>
      <Show when={g()}>
        {(graph) => (
          <CellView of={graph().permanents} label="counting matchings (Ryser)">
            {(res) => (
              <table class="regime-table aztec-perm-table">
                <thead>
                  <tr>
                    <th>n</th>
                    <th>matrix</th>
                    <th>permanent</th>
                    <th>2^(n(n+1)/2)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={res().permanents}>
                    {(row) => (
                      <tr>
                        <td class="mono">{row.n}</td>
                        <td class="dim mono">
                          {row.size}×{row.size}
                        </td>
                        <td class="mono">{row.permanent.toLocaleString()}</td>
                        <td class="mono">{row.formula.toLocaleString()}</td>
                        <td class={row.matches ? "aztec-ok" : "aztec-bad"}>
                          {row.matches ? "✓" : "✗"}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            )}
          </CellView>
        )}
      </Show>
      <p class="aztec-prose dim">
        Kasteleyn's escape hatch: for a <i>planar</i> graph the signs that make the permanent hard
        can be gauged away, and the number of dimer coverings equals the <b>Pfaffian</b> of a
        Kasteleyn-oriented adjacency matrix — a determinant, computable in polynomial time. That is
        why physicists could count dimers on a lattice at all.
      </p>
    </div>
  );
}
