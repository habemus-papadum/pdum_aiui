/**
 * The `/intent/` panel, built to a static bundle the channel serves in **prod**
 * mode (an installed session has no Vite). In **dev** the channel serves the
 * same source through a Vite dev server in middleware mode — see
 * `src/sidecar.ts` → aiui-util's `serveClientSurface`. This is the app build
 * (an html entry), separate from the library/sidecar `vite.config.ts` lib build.
 *
 * `base` is the mount prefix so every asset URL resolves under `/intent/`.
 * Output goes to `assets/panel/` (mirroring aiui-pencil's `assets/client/`), so
 * `src/sidecar.ts` resolves it as `../assets/panel` from both `src/` (tsx) and
 * `dist/` (installed) — the same relative path in both.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "/intent/",
  plugins: [solid()],
  build: {
    // The panel is served to the session's own (modern) Chrome, and main.tsx
    // uses top-level await — so target esnext rather than the default es2020,
    // which rejects TLA. (Dev serving already allows it.)
    target: "esnext",
    outDir: fileURLToPath(new URL("./assets/panel", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
