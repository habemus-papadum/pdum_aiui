import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiuiDevOverlay is the aiui integration — the intent tool + channel port
// bridging (see the overlay package's src/vite.ts for why it must be a plugin).
// Its `locator` option turns on the compile-time source-locator: every host
// JSX element gets data-source-loc = "src/…:line:col" (the DOM-side handle that
// lets a human or agent go from "this thing on screen" to the code that
// rendered it — see the `locate` agent tool), and `cell()` call sites get their
// `{ name, loc }` identity injected. Dev-only; owned by the overlay now.
//
// Order matters: aiuiDevOverlay comes BEFORE solid() so the locator's `pre`
// babel pass stamps JSX before vite-plugin-solid (also `pre`) compiles each
// element into an opaque template. Same-enforce plugins run in array order.
export default defineConfig(({ command, isPreview }) => ({
  // Static builds are published to https://habemus-papadum.net/aiui/ (see
  // publish.sh); dev keeps "/". Nav links between pages are relative so they
  // work under both. isPreview matters: `vite preview` resolves the config
  // with command "serve", so keying on command alone serves the built
  // /aiui/-prefixed assets under the wrong base (SPA fallback then returns
  // index.html for every asset URL — a very confusing 200).
  base: command === "build" || isPreview ? "/aiui/" : "/",
  // Multi-page: one .html entry per notebook (PRINCIPLES §8, Level 1). The dev
  // server serves each .html directly; this only affects the production build.
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        aztec: "aztec.html",
        seismos: "seismos.html",
      },
    },
  },
  plugins: [
    aiuiDevOverlay({ format: "text-concat", locator: { cellFactories: ["cell"] } }),
    solid(),
  ],
}));
