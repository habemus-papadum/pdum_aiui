import aiui from "@habemus-papadum/aiui-viz/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiui() is the build-time integration (@habemus-papadum/aiui-viz/vite): the
// source-locator compiler pass — JSX gets data-source-loc = "src/…:line:col"
// (dev-only stamps; production bundles ship clean) and `cell()` call sites get
// their `{ name, loc }` identity injected in EVERY mode (load-bearing for
// durable cells) — plus the dev-only sourceRoot seed. Nothing else: no overlay
// injection, no channel port; connectivity arrives from the intent client
// (window.__AIUI__ itself is the viz runtime's job, production included).
//
// Order matters: aiui() comes BEFORE solid() so the locator's `pre` babel pass
// stamps JSX before vite-plugin-solid (also `pre`) compiles each element into
// an opaque template. Same-enforce plugins run in array order.
export default defineConfig({
  plugins: [aiui({ locator: { cellFactories: ["cell"] } }), solid()],
});
