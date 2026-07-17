import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

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
  // The client kit's components are Solid `.tsx` — and ONLY `.tsx`: scoping
  // the transform keeps it off the plain `.ts` cores (the dev-overlay lesson:
  // an unscoped solid plugin rewrites import.meta in pure-Node code). And OFF
  // under Vitest entirely: the plugin flips resolve conditions toward the
  // browser, which hands the node-side relay tests a stub `ws` ("not a
  // constructor"). This suite has no .tsx tests; if the kit grows some,
  // adopt the dev-overlay recipe (inline solid + pinned conditions) instead.
  plugins: process.env.VITEST ? [] : [solid({ include: ["src/**/*.tsx"] })],
  build: {
    lib: {
      // Four entrypoints mirroring the exports map: the library (`.`), the
      // Solid client kit (`./client`), the host-neutral Node backend
      // (`./server`), and the channel sidecar (`./sidecar`, imported by the
      // channel's standard-sidecars.ts). The Node entries' ws graph stays out
      // of the `index` bundle by being separate.
      entry: {
        index: "src/index.ts",
        client: "src/client/index.ts",
        backend: "src/backend.ts",
        sidecar: "src/sidecar.ts",
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
