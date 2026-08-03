/**
 * App.tsx — layout only. Every component below is a pure reader of the durable
 * signals and the cell graph, so any of them can be redesigned or replaced
 * without touching the dataflow.
 */
import { Board } from "./Board";
import { Controls } from "./Controls";
import { FitPanel } from "./FitPanel";
import { LogLikChart } from "./LogLikChart";

export function App() {
  return (
    <div class="app">
      <header class="masthead">
        <h1>mixture of gaussians, drawn</h1>
        <p class="muted">
          Draw 2-D Gaussians as ellipses on the board; the app samples the mixture, hex-bins it, and
          recovers the components with EM (<code>samples</code> → <code>hexes</code> →{" "}
          <code>fit</code>, streaming). Arm the intent client with <kbd>`</kbd> and talk about what
          you see.
        </p>
      </header>
      <main class="stage">
        <div class="charts">
          <Board />
          <LogLikChart />
        </div>
        <aside class="rail">
          <Controls />
          <FitPanel />
        </aside>
      </main>
    </div>
  );
}
