import aiui from "@habemus-papadum/aiui-viz/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// aiui() is the build-time integration (@habemus-papadum/aiui-viz/vite): the
// source-locator compiler pass + the dev-only sourceRoot seed — no overlay
// injection, no channel port (connectivity arrives from the intent client).
//
// `locator` turns on compile-time source stamping: every host JSX element gets
// data-source-loc = "src/…:line:col", and every `cell()` call site gets its
// `{ name, loc }` identity injected — which is why graph.ts never writes those
// by hand, and why a screenshot of this page can name the cell behind a chart.
//
// Order matters: aiui comes BEFORE solid() so the locator's `pre`
// babel pass stamps JSX before vite-plugin-solid (also `pre`) compiles each
// element into an opaque template. Same-enforce plugins run in array order.
export default defineConfig({
  plugins: [aiui({ locator: { cellFactories: ["cell"] } }), solid()],
});
