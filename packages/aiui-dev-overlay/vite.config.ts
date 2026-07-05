import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  build: {
    lib: {
      // Four entries: the browser bundle, the dev-server plugin behind the
      // `./vite` subpath export (Node code — kept out of the browser bundle),
      // the framework-free intent pipeline behind `./intent-pipeline`, and the
      // shared debug UI behind `./debug-ui` (lab + DevTools extension).
      entry: {
        index: "src/index.ts",
        vite: "src/vite.ts",
        "intent-pipeline": "src/intent-pipeline/index.ts",
        "debug-ui": "src/debug-ui/index.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
