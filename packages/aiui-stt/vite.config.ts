import { readFileSync } from "node:fs";
import {
  externalizeDeps,
  SOLID_TEST_CONDITIONS,
  SOLID_TEST_OXC,
  solidTestDeps,
} from "@habemus-papadum/aiui-build-config";
import solid from "vite-plugin-solid";
// `vitest/config`, not `vite`: Vitest 5 no longer augments Vite's UserConfig
// with `test`, so a config that carries a test block types it from here.
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Solid compiles ONLY the .tsx surface (MicPicker); the engines and the
  // signal adapter are plain .ts an unscoped plugin must not rewrite. OFF
  // under Vitest — this suite has no .tsx tests (the reactive tests are
  // JSX-free createRoot code); Solid still resolves correctly there via the
  // inline deps + pinned conditions below (the aiui-viz recipe). No `ws`
  // anywhere, so the split-projects trap (ws-vs-Solid conditions) is moot.
  plugins: process.env.VITEST ? [] : [solid({ include: ["src/**/*.tsx"] })],
  // Vite 8 honours `jsx: preserve`; a plugin-less test run still loads .tsx.
  oxc: process.env.VITEST ? SOLID_TEST_OXC : undefined,
  test: {
    environment: "jsdom",
    server: {
      deps: solidTestDeps,
    },
  },
  resolve: {
    // Only meaningful under Vitest (the lib build's resolution is unaffected).
    conditions: SOLID_TEST_CONDITIONS,
  },
  build: {
    lib: {
      // One entry per export subpath: the core seam (`.`) and the real
      // microphone (`./mic`), so an app feeding its own PCM never pays for
      // the capture path.
      entry: {
        index: "src/index.ts",
        mic: "src/mic/index.ts",
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
