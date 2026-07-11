import { sourceLocatorVite } from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts (which is the lib build). The
// slice's tests are headless dataflow tests; three settings matter:
//
//  - environment jsdom: `durable()` keeps its registry on `window`, so
//    controls and cell graphs need a window even without rendering.
//  - resolve.conditions + inline: Solid must resolve as ONE shared browser/dev
//    build under Vitest, or effects silently observe a different reactive
//    instance than the one the controls write to — cells then never recompute
//    (the full story is in aiui-viz's vite.config.ts; it bit this package
//    first).
//  - the aiui compiler with `locPrefix`: the slice's identity (names,
//    descriptions, package-qualified locs) is injected by THIS package's own
//    toolchain — the library-grade identity story the tests pin.
export default defineConfig({
  plugins: [
    sourceLocatorVite({
      locPrefix: "@habemus-papadum/aiui-oscillator/",
      stampJsx: false,
    }),
  ],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
