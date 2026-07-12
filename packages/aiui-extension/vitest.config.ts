// Vitest deliberately does NOT load vite.config.ts: that config instantiates
// the CRXJS plugin (manifest pipeline, dev-server hooks) which has no business
// running under a test runner. But the aiui COMPILER must run here too —
// control()/cell() names, locations, and descriptions are compiler-injected,
// and the model-layer tests exercise the same inference the panel gets
// (mount: false keeps the intent tool out; same shape as the app template).
import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [aiuiDevOverlay({ locator: true, mount: false })],
  resolve: {
    // Solid must resolve as ONE shared browser/dev build under Vitest, or
    // effects silently observe a different reactive instance than the one
    // the cells write to (the full story is in aiui-viz's vite.config.ts).
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    // jsdom: `durable()` keeps its registry on `window`, so the cell-graph
    // tests need a window even without rendering. The pure grammar tests run
    // fine under it too.
    environment: "jsdom",
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
