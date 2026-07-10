import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiuiDevOverlay is the aiui integration — the intent tool + channel port
// bridging (see the overlay package's src/vite.ts for why it must be a plugin).
// `locator: true` turns on the aiui compiler: every host JSX element gets
// data-source-loc = "src/…:line:col" (dev-only), and cell()/control()/action()
// call sites get their { name, loc, description } identity injected (build and
// serve alike — control names are durable keys and tool identities).
//
// Order matters: aiuiDevOverlay comes BEFORE solid() so the locator's `pre`
// babel pass stamps JSX before vite-plugin-solid (also `pre`) compiles each
// element into an opaque template. Same-enforce plugins run in array order.
export default defineConfig(({ command, isPreview }) => ({
  // Static builds are published to https://habemus-papadum.net/aiui/ (see
  // publish.sh); dev keeps "/". Route hrefs are built from BASE_URL
  // (src/site/router.ts) so they work under both. isPreview matters: `vite
  // preview` resolves the config with command "serve", so keying on command
  // alone serves the built /aiui/-prefixed assets under the wrong base (SPA
  // fallback then returns index.html for every asset URL — a confusing 200).
  base: command === "build" || isPreview ? "/aiui/" : "/",
  // One entry, one document: the SPA shell (src/main.tsx) client-side-routes
  // between notebooks so the intent tool's turn survives switching pages.
  // Per-notebook code isolation now comes from the dynamic import() in
  // src/site/pages.ts (Vite code-splits each page into its own chunk), not
  // from multi-entry rollupOptions. Deep links (/aztec) ride the dev server's
  // SPA fallback; the published static site gets real objects per route
  // (publish.sh).
  plugins: [
    // No explicit `format`: the intent tool rides the default modality set —
    // the multimodal (intent-v1) tab active, with the text tab as the escape
    // hatch. (Sends fail against an old channel that doesn't know intent-v1;
    // that degrades to a widget error, not a crash.)
    aiuiDevOverlay({ locator: true }),
    solid(),
  ],
}));
