import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  build: {
    lib: {
      // One entry per export subpath, so a Mosaic-only app never imports the
      // vendor-SDK-touching modules (`/oracle`, `/stt`) — mirroring aiui-viz's
      // optional-peer entry-point layout.
      entry: {
        index: "src/index.ts",
        oracle: "src/oracle.ts",
        stt: "src/stt.ts",
        mosaic: "src/mosaic.ts",
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
