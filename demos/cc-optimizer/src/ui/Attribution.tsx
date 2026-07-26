/**
 * Attribution.tsx — what *caused* the spend: agent type, skill, MCP server.
 *
 * These columns are sparse (a skill is named on ~4% of turns, an MCP server on
 * ~6%), so the "(none)" bucket is nearly always the largest bar. That is not
 * noise to be filtered out — it is the baseline the others must be read
 * against, and hiding it would make a 3% slice look like a headline.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { For } from "solid-js";
import { graph } from "../model/graph";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

interface Slice {
  kind: string;
  key: string;
  cost: number;
  turns: number;
}

function Group(props: { title: string; note: string; rows: Slice[] }) {
  const max = () => Math.max(...props.rows.map((r) => r.cost), 1e-9);
  return (
    <div class="cco-attr-group">
      <h3 class="cco-h3">{props.title}</h3>
      <p class="cco-note cco-note-tight">{props.note}</p>
      <For each={props.rows.slice(0, 8)}>
        {(r) => (
          <div class={`cco-attr-row${r.key.startsWith("(") ? " cco-attr-baseline" : ""}`}>
            <span class="cco-attr-key" title={r.key}>
              {r.key}
            </span>
            <span class="cco-attr-track">
              <span class="cco-attr-fill" style={{ width: `${(r.cost / max()) * 100}%` }} />
            </span>
            <span class="cco-attr-cost">{usd(r.cost)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

export function Attribution() {
  return (
    <section class="cco-panel">
      <h2 class="cco-h2">what caused the spend</h2>
      <CellView of={graph().attribution}>
        {(rows) => (
          <div class="cco-attr">
            <Group
              title="by agent"
              note="(main loop) is every turn that ran in the top-level session."
              rows={rows().filter((r) => r.kind === "agent")}
            />
            <Group
              title="by skill"
              note="Named on a minority of turns — (none) is the baseline, not an error."
              rows={rows().filter((r) => r.kind === "skill")}
            />
            <Group
              title="by MCP server"
              note="Attribution lands on the turn that invoked the server's tool."
              rows={rows().filter((r) => r.kind === "mcp")}
            />
          </div>
        )}
      </CellView>
    </section>
  );
}
