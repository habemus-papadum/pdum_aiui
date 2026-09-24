/**
 * App.tsx — the lab's page: the session (who, which DuckDB, which
 * generation, which databases), a table and a column to look at, two linked
 * histograms over the cloud table, and the local side — pull a sample into
 * the tab, ask the hybrid question, rebuild the engine and watch the sample
 * go while the cloud tables stay.
 *
 * Pure readers throughout: every number comes through a cell (`CellView`),
 * every choice writes a durable root.
 */
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { createMemo, For, Show } from "solid-js";
import { type TableRef, tableRefKey } from "../model/catalog";
import { graph } from "../model/graph";
import { store } from "../model/store";
import { MosaicView } from "./MosaicView";
import { histogram } from "./specs";

function Session() {
  return (
    <CellView of={graph().session} label="connecting">
      {(s) => (
        <p class="lab-session">
          <span>
            <b>{s().username}</b> on DuckDB {s().version}
          </span>
          <span>engine generation {s().generation}</span>
          <span>
            {s()
              .databases.map((d) => `${d.alias} (${d.type})`)
              .join(" · ")}
          </span>
        </p>
      )}
    </CellView>
  );
}

function TablePicker() {
  const key = () => {
    const pick = store.pick.get();
    return pick === undefined ? "" : tableRefKey(pick);
  };
  return (
    <CellView of={graph().tables} label="listing tables">
      {(tables) => (
        <label class="lab-field">
          table
          <select
            value={key()}
            onChange={(e) => {
              const chosen = tables().find(
                (t: TableRef) => tableRefKey(t) === e.currentTarget.value,
              );
              store.pick.set(chosen);
              store.column.set(undefined);
            }}
          >
            <option value="">— pick a table —</option>
            <For each={tables()}>
              {(t) => <option value={tableRefKey(t)}>{tableRefKey(t)}</option>}
            </For>
          </select>
        </label>
      )}
    </CellView>
  );
}

function ColumnPicker() {
  return (
    <Show when={store.pick.get()}>
      <CellView of={graph().columns} label="listing columns">
        {(columns) => (
          <label class="lab-field">
            column
            <select
              value={store.column.get() ?? ""}
              onChange={(e) => store.column.set(e.currentTarget.value || undefined)}
            >
              <option value="">— pick a numeric column —</option>
              <For each={columns().filter((c) => c.numeric)}>
                {(c) => (
                  <option value={c.name}>
                    {c.name} ({c.type})
                  </option>
                )}
              </For>
            </select>
          </label>
        )}
      </CellView>
    </Show>
  );
}

function Histograms() {
  // The second histogram binds the next numeric column, so a brush on one
  // re-queries the other — the crossfilter over a cloud table.
  const second = createMemo(() => {
    const columns = graph().columns.latest() ?? [];
    const first = store.column.get();
    return columns.find((c) => c.numeric && c.name !== first)?.name;
  });
  return (
    <Show when={store.pick.get() && store.column.get()}>
      <CellView of={graph().view} label="bridging the cloud table">
        {(view) => {
          const column = () => store.column.get() as string;
          return (
            <div class="lab-plots">
              <MosaicView name="first" spec={() => histogram(view(), column())} />
              <Show when={second()}>
                {(col) => <MosaicView name="second" spec={() => histogram(view(), col())} />}
              </Show>
            </div>
          );
        }}
      </CellView>
    </Show>
  );
}

function LocalSide() {
  const materialize = async () => {
    const pick = store.pick.get();
    if (pick === undefined) return;
    const { materializeSql } = await import("../model/catalog");
    await (await store.sqlRunner).query(materializeSql(pick, store.sampleRows.get()));
    store.bumpLocal();
  };
  return (
    <section class="lab-local">
      <h2>the local side</h2>
      <ControlSlider of={store.sampleRows} label="sample rows" />
      <div class="lab-buttons">
        <button
          type="button"
          disabled={store.pick.get() === undefined}
          onClick={() => void materialize()}
        >
          materialize the sample locally
        </button>
        <button type="button" onClick={() => void store.rebuild("button")}>
          rebuild the engine (drops the sample)
        </button>
      </div>
      <CellView of={graph().local} label="counting">
        {(l) => (
          <p class="lab-counts">
            <span>local sample: {l().localRows === null ? "none" : `${l().localRows} rows`}</span>
            <span>
              cloud rows in the sample's range:{" "}
              {l().hybridRows === null ? "—" : `${l().hybridRows} (a hybrid query)`}
            </span>
          </p>
        )}
      </CellView>
    </section>
  );
}

export function App() {
  return (
    <div class="lab">
      <header>
        <h1>motherduck-lab</h1>
        <p class="lab-blurb">
          one stock DuckDB-WASM engine with the MotherDuck extension attached; the wasm from this
          origin; Mosaic over the stock connector; the tab's tables beside the cloud's.
        </p>
        <Session />
      </header>
      <section class="lab-pick">
        <TablePicker />
        <ColumnPicker />
      </section>
      <Histograms />
      <LocalSide />
    </div>
  );
}
