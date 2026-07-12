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
  plugins: [solid()],
  build: {
    lib: {
      // The exports map's two entries — the browser runtime barrel and the
      // Node-side config factory (./vite) — plus the dev stamp, which both of
      // them import (`#dev-stamp`) and which therefore needs a real file behind
      // publishConfig's imports map rather than being inlined into each.
      entry: { index: "src/index.ts", vite: "src/vite.ts", "dev-stamp": "src/dev-stamp.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
