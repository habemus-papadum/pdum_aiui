import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  test: {
    // Node default + per-file `@vitest-environment jsdom` pragmas — the
    // framework-free cores run in plain Node; only the DOM edges opt into jsdom.
    environment: "node",
  },
  build: {
    lib: {
      // One entry per subpath export (see package.json `exports`): the shared
      // substrate at the root, and each runtime job as its own lean entry so a
      // host (a content script, a panel, a build script) pulls only the graph
      // it composes.
      entry: {
        index: "src/index.ts",
        locator: "src/locator.ts",
        talk: "src/talk.ts",
        video: "src/video.ts",
        selection: "src/selection.ts",
        instrumentation: "src/instrumentation.ts",
        wire: "src/wire.ts",
        thread: "src/thread.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: externalizeDeps(pkg),
    },
  },
});
