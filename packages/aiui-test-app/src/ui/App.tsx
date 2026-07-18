/**
 * App.tsx — layout only. Every component below is a pure reader of the durable
 * signals and the cell graph, so any of them can be redesigned or replaced
 * without touching the dataflow.
 */
import { Controls } from "./Controls";
import { DensityChart } from "./DensityChart";
import { FitPanel } from "./FitPanel";
import { MomentsTable } from "./MomentsTable";
import { SamplePanel } from "./SamplePanel";

export function App() {
  return (
    <div class="app">
      <header class="masthead">
        <h1>mixture of gaussians</h1>
        <p class="muted">
          A five-cell dataflow graph: <code>samples</code> → <code>histogram</code> /{" "}
          <code>moments</code> → <code>fit</code> → <code>curves</code>. Arm the intent client with{" "}
          <kbd>`</kbd> and talk about what you see.
        </p>
      </header>
      <main class="stage">
        <DensityChart />
        <aside class="rail">
          <Controls />
          <FitPanel />
          <MomentsTable />
          <SamplePanel />
        </aside>
      </main>
    </div>
  );
}
