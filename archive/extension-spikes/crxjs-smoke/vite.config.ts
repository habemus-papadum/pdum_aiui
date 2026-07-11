import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [solid(), crx({ manifest })],
  server: {
    // CRXJS needs a pinned port: the loader baked into the dev extension dials it.
    // (5311, not 5199 — 5199 was already squatted by another checkout's dev server,
    // which produced a confusing first HMR test: strictPort refused to start, a
    // bare `vite <port>` retry treated the port as a ROOT DIRECTORY, and the
    // extension under test was silently the stale production dist.)
    port: 5311,
    strictPort: true,
    hmr: { clientPort: 5311 },
    // The content script imports overlay SOURCE from the monorepo (the
    // source-first convention) — allow serving files from the repo root.
    fs: { allow: ["../../.."] },
  },
});
