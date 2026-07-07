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
      // Three entries: the browser-safe surface (protocol + host controller),
      // the Node relay server behind `./relay`, and the CLI (`bin`). The relay
      // and CLI import Node builtins (http/express/ws), kept out of the browser
      // `index` bundle by their separate entries.
      entry: {
        index: "src/index.ts",
        relay: "src/relay.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
      output: {
        // The bin is executed by plain `node` from an installed tarball; the
        // shebang is prepended to the built cli chunk (not in the TS source).
        banner: (chunk: { name: string }) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});
