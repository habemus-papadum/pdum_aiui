import { fileURLToPath } from "node:url";
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { demoPages } from "./demo-discovery";

// Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
//
// aiui() is the build-time integration (@habemus-papadum/aiui-source-processor): the
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
    // stampRoots: the demos live in SIBLING packages, outside this root, and
    // the locator stamps JSX only for app code under the root — so in the
    // gallery's dev loop the demo pages carried no data-source-loc at all
    // (found live 2026-10-08). Declaring demos/ as app code stamps them with
    // root-relative locs ("../seismos/src/ui/App.tsx:42:7"), which /@fs/ and
    // the attribution consumers resolve against sourceRoot as before.
    //
    // The BUILD keeps the stamps and ships the sources (`sources: "ship"` —
    // every demo's files under /aiui/__aiui/src/, a public repo's code on a
    // public site), with sourceRoot pointing at the repo so a stamp on the
    // published page links to GitHub; dev keeps the machine path the editor
    // links need. The `source` and `locate` tools then answer on the site as
    // they do here.
    aiui({
      // devKeys: the dev server injects the OpenAI key for the voice dock
      // (dev serve only; a production bundle cannot contain it).
      devKeys: ["openai"],
      locator: {
        stampRoots: [fileURLToPath(new URL("..", import.meta.url))],
        ...(command === "build" ? { stampJsx: true } : {}),
      },
      ...(command === "build"
        ? {
            sources: "ship",
            sourceRoot: "https://github.com/habemus-papadum/pdum_aiui/blob/main/demos/gallery/",
          }
        : {}),
    }),
    solid(),
    // Marker-driven discovery of the sibling demo packages (aiui.sitePage in
    // their package.json) — serves virtual:demo-pages; see demo-discovery.ts.
    demoPages(fileURLToPath(new URL("..", import.meta.url))),
  ],
}));
