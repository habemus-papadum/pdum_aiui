import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The entire aiui integration is one plugin. `aiuiDevOverlay` mounts the intent
// tool into every served page and bridges the channel port (`VITE_AIUI_PORT`,
// exported by `aiui vite`) into the browser. It is dev-server-only.
//
// `locator` turns on compile-time source stamping: every host JSX element gets
// data-source-loc = "src/…:line:col", and every `cell()` call site gets its
// `{ name, loc }` identity injected — which is why graph.ts never writes those
// by hand, and why a screenshot of this page can name the cell behind a chart.
//
// Order matters: aiuiDevOverlay comes BEFORE solid() so the locator's `pre`
// babel pass stamps JSX before vite-plugin-solid (also `pre`) compiles each
// element into an opaque template. Same-enforce plugins run in array order.
export default defineConfig({
  plugins: [aiuiDevOverlay({ locator: { cellFactories: ["cell"] } }), solid()],
});
