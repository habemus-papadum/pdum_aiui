/**
 * App.tsx — the root layout (playbook layer 4: the application shell).
 *
 * Reading order is the argument the page makes: the summary strip first,
 * because the cache-read share reframes everything after it; then daily spend
 * (where and when); then attribution (what caused it); then sessions (was it
 * time well spent). Each panel is a pure reader of the cell graph.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import { store } from "../model/store";
import { Attribution } from "./Attribution";
import { DailySpend } from "./DailySpend";
import { Sessions } from "./Sessions";
import { Summary } from "./Summary";

function Loading() {
  const p = () => store.progress();
  return (
    <div class="lg-loading">
      <div class="lg-loading-label">{p().label}</div>
      <div class="lg-loading-track">
        <div
          class={`lg-loading-fill${p().fraction === null ? " lg-loading-indeterminate" : ""}`}
          style={p().fraction !== null ? { width: `${(p().fraction ?? 0) * 100}%` } : undefined}
        />
      </div>
    </div>
  );
}

/**
 * A missing dataset is the expected state of a fresh checkout — the parquet is
 * gitignored personal telemetry — so it gets real instructions rather than a
 * stack trace.
 */
function NoData(props: { error: string }) {
  return (
    <div class="lg-nodata">
      <h2 class="lg-h2">no data yet</h2>
      <p>
        This app reads Parquet generated from your own Claude Code transcripts. The files are
        gitignored on purpose — they carry project names, branch names and paths.
      </p>
      <pre class="lg-cmd">pnpm -C demos/ledger normalize</pre>
      <p class="lg-note">…then reload. The loader reported:</p>
      <pre class="lg-err">{props.error}</pre>
    </div>
  );
}

export function App() {
  return (
    <div class="app lg">
      <header class="lg-head">
        <h1 class="lg-h1">ledger</h1>
        <p class="lg-sub">your own Claude Code usage, and whether it was time well spent</p>
      </header>
      {/* The dataset cell drives the load; the page is its view. */}
      <CellView
        of={graph().dataset}
        fallback={<Loading />}
        errorFallback={(error: unknown) => <NoData error={String(error)} />}
      >
        {() => (
          <>
            <Summary />
            <DailySpend />
            <Attribution />
            <Sessions />
          </>
        )}
      </CellView>
    </div>
  );
}
