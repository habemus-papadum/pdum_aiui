import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [solid(), crx({ manifest })],
  server: {
    // CRXJS needs a pinned port: the loader baked into the dev extension dials it.
    port: 5199,
    strictPort: true,
    hmr: { clientPort: 5199 },
    // The content script imports overlay SOURCE from the monorepo (the
    // source-first convention) — allow serving files from the repo root.
    fs: { allow: ["../../.."] },
  },
});
