/**
 * App.tsx — the root layout. Blank on purpose.
 *
 * Components live in this directory and are freely hot-swappable, so build the
 * page out of them. Keep them pure readers of the durable signals (store.ts)
 * and the cell graph (graph.ts): read a cell's value by rendering it through
 * `<CellView of={graph().someCell}>`, never by importing a cell directly.
 */
export function App() {
  return <div class="app" />;
}
