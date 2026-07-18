import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * Builds the remote client (`client/` — the kit's paved-road composition)
 * into a servable artifact at `assets/client/` — what the pencil sidecar
 * hands an iPad at `GET /pencil/` (an iPad has no frontend process).
 *
 * `assets/` (not `dist/`) so the path from the sidecar is IDENTICAL in both
 * runtimes: `../assets/client` resolves the same from `src/sidecar.ts` (tsx,
 * source-first) and from `dist/sidecar.js` (installed). `base` is the mount
 * prefix, so the built asset URLs are absolute under `/pencil/`.
 *
 * No `aiui()` locator plugin here: the client uses no `control()`s (its state is
 * plain signals), and the served artifact should not carry the locator's
 * instrumentation. The LAB's dev server still serves the same sources live at
 * `/pencil/` for the iterate loop (or run `pnpm dev:client` standalone).
 *
 * Dual role: this is both the client BUILD (above) and the config the channel
 * sidecar loads in DEV mode — `serveClientSurface` roots Vite here (solid, no
 * lab rig) and serves `index.html` at `/pencil/` with HMR over the channel's
 * one port. The `build`/`emitAsIndex` half is inert when serving (a build-only
 * `closeBundle`); the `plugins`/`root`/`base` half is exactly what dev wants.
 */
const OUT_DIR = fileURLToPath(new URL("../assets/client", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/pencil/",
  plugins: [solid()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
