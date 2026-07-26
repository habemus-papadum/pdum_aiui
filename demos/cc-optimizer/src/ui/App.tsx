/**
 * App.tsx — the root layout (playbook layer 4: the application shell).
 *
 * Reading order is the argument the page makes: the summary strip first,
 * because the cache-read share reframes everything after it; then the session
 * graph (the shape of the work — what ran when, beside what); then daily spend
 * (where and when); then attribution (what caused it); then sessions (was it
 * time well spent).
 *
 * All but one panel are pure readers of the cell graph. The session graph is
 * the exception and deliberately so: it is a Mosaic client on the shared
 * cross-filter, so brushing a time range in it re-queries every other client
 * through the coordinator rather than through this tree.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import { store } from "../model/store";
import { Attribution } from "./Attribution";
import { DailySpend } from "./DailySpend";
import { Sessions } from "./Sessions";
import { SessionTimeline } from "./SessionTimeline";
import { Summary } from "./Summary";

function Loading() {
  const p = () => store.progress();
  return (
    <div class="cco-loading">
      <div class="cco-loading-label">{p().label}</div>
      <div class="cco-loading-track">
        <div
          class={`cco-loading-fill${p().fraction === null ? " cco-loading-indeterminate" : ""}`}
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
    <div class="cco-nodata">
      <h2 class="cco-h2">no data yet</h2>
      <p>
        This app reads Parquet generated from your own Claude Code transcripts. The files are
        gitignored on purpose — they carry project names, branch names and paths.
      </p>
      <pre class="cco-cmd">pnpm -C demos/cc-optimizer normalize</pre>
      <p class="cco-note">…then reload. The loader reported:</p>
      <pre class="cco-err">{props.error}</pre>
    </div>
  );
}

export function App() {
  return (
    <div class="app cco">
      <header class="cco-head">
        <h1 class="cco-h1">cc-optimizer</h1>
        <p class="cco-sub">your own Claude Code usage, and whether it was time well spent</p>
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
            <SessionTimeline />
            <DailySpend />
            <Attribution />
            <Sessions />
          </>
        )}
      </CellView>
    </div>
  );
}
