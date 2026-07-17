import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * Builds the console app (`app/`) into a servable artifact at `assets/app/` —
 * what the console sidecar hands the browser at `GET /__aiui/`. `assets/` (not
 * `dist/`) so the path from the sidecar is IDENTICAL in both runtimes:
 * `../assets/app` resolves the same from `src/sidecar.ts` (tsx, source-first)
 * and from `dist/sidecar.js` (installed).
 *
 * Dual role: this is both the app BUILD (below) and the config the channel
 * sidecar loads in DEV mode — `serveClientSurface` roots Vite here (solid) and
 * serves `index.html` under `/__aiui/` with HMR over the channel's one port,
 * SPA-falling-back so `/__aiui/debug` boots the same app.
 *
 * `base` is the mount prefix, so the built asset URLs are absolute under
 * `/__aiui/`.
 */
const OUT_DIR = fileURLToPath(new URL("../assets/app", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/__aiui/",
  appType: "spa",
  plugins: [solid()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
