import { renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/** Rollup keeps the input's filename; the served artifact must be index.html. */
function emitAsIndex(outDir: string): Plugin {
  return {
    name: "emit-as-index",
    closeBundle() {
      renameSync(join(outDir, "client.html"), join(outDir, "index.html"));
    },
  };
}

/**
 * Builds the remote client (`client.html` + `src/client/`) into a servable
 * artifact at `assets/client/` — what the pencil sidecar hands an iPad at
 * `GET /pencil/` (an iPad has no frontend process; paint's precedent).
 *
 * `assets/` (not `dist/`) so the path from the sidecar is IDENTICAL in both
 * runtimes: `../assets/client` resolves the same from `src/sidecar.ts` (tsx,
 * source-first) and from `dist/sidecar.js` (installed) — the same trick
 * paint's `assets/ipad-client.html` uses. `base` is the mount prefix, so the
 * built asset URLs are absolute under `/pencil/`.
 *
 * No dev-overlay plugin here: the client uses no `control()`s (its state is
 * plain signals), and the served artifact should not carry the locator's
 * instrumentation. The LAB's dev server still serves the same sources live at
 * `/client.html` for the iterate loop.
 *
 * Dual role: this is both the client BUILD (above) and the config the channel
 * sidecar loads in DEV mode — `serveClientSurface` roots Vite here (solid, no
 * lab rig) and serves `client.html` at `/pencil/` with HMR over the channel's
 * one port. The `build`/`emitAsIndex` half is inert when serving (a build-only
 * `closeBundle`); the `plugins`/`root`/`base` half is exactly what dev wants.
 */
const OUT_DIR = fileURLToPath(new URL("../assets/client", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/pencil/",
  plugins: [solid(), emitAsIndex(OUT_DIR)],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./client.html", import.meta.url)),
    },
  },
});
