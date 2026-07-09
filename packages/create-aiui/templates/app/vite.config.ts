import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiuiDevOverlay is the ENTIRE aiui integration — it mounts the intent tool
// into every served page and bridges the channel port from `aiui vite`
// (VITE_AIUI_PORT) into the browser. It is dev-server-only; production builds
// are untouched. `locator` turns on compile-time source stamping: every host
// JSX element gets data-source-loc = "src/…:line:col" and `cell()` call sites
// get their `{ name, loc }` identity injected — what lets an agent (and the
// overlay's screenshot lowering) go from "this thing on screen" to the code
// that rendered it.
//
// Order matters: aiuiDevOverlay comes BEFORE solid() so the locator's `pre`
// babel pass stamps JSX before vite-plugin-solid (also `pre`) compiles each
// element into an opaque template. Same-enforce plugins run in array order.
export default defineConfig({
  plugins: [aiuiDevOverlay({ locator: { cellFactories: ["cell"] } }), solid()],
});
