/**
 * App.tsx — layout: the banner that explains the loop, the picture, and its
 * controls. Everything here is a pure reader of the durable signals and the
 * cell graph, so components can be redesigned or replaced freely.
 */
import { Banner } from "./Banner";
import { Controls } from "./Controls";
import { Picture } from "./Picture";

export function App() {
  return (
    <div class="app">
      <Banner />
      <main class="stage">
        <Picture />
        <Controls />
      </main>
    </div>
  );
}
