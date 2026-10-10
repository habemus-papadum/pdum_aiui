import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiui() is the build-time integration (@habemus-papadum/aiui-source-processor): the
// source-locator compiler pass — JSX gets data-source-loc = "src/…:line:col"
// (in every mode; `stampJsx: false` opts a build out) and `cell()` call sites get
// their `{ name, loc }` identity injected in EVERY mode (load-bearing for
// durable cells) — plus the dev-only sourceRoot seed and
// the dev server's source listing (and any devKeys/duckdbAssets opt-ins). Nothing else: no runtime
// injection (window.__AIUI__ itself is the viz runtime's job, production included).
//
// Order matters: aiui() comes BEFORE solid() so the locator's `pre` babel pass
// stamps JSX before vite-plugin-solid (also `pre`) compiles each element into
// an opaque template. Same-enforce plugins run in array order.
export default defineConfig({
  plugins: [aiui({ devKeys: ["openai"] }), solid()],
  build: {
    rollupOptions: {
      // One entry per playbook step — every stage of the walkthrough stays a
      // real, buildable page (the gallery's multi-page pattern).
      input: {
        main: "index.html",
        step1: "step1.html",
        step2: "step2.html",
        step3: "step3.html",
      },
    },
  },
});
