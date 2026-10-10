import { readFileSync } from "node:fs";
import {
  externalizeDeps,
  SOLID_TEST_CONDITIONS,
  solidTestDeps,
} from "@habemus-papadum/aiui-build-config";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "aiui-prompts-inspector:styles",
      generateBundle() {
        for (const path of ["style.css", "themes/aiui.css", "themes/terminal.css"])
          this.emitFile({
            type: "asset",
            fileName: path,
            source: readFileSync(new URL(`./src/${path}`, import.meta.url), "utf8"),
          });
      },
    },
  ],
  // Inline one shared reactive runtime with browser export conditions. jsdom
  // supplies DOM APIs; Node's default Solid server build must not win resolution.
  test: {
    name: "aiui-prompts-inspector",
    include: ["src/**/*.test.{ts,tsx}", "bench/**/*.test.ts"],
    environment: "jsdom",
    server: { deps: solidTestDeps },
  },
  resolve: { conditions: SOLID_TEST_CONDITIONS },
  build: {
    lib: {
      entry: { index: "src/index.ts", model: "src/model.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: { external: externalizeDeps(pkg) },
  },
});
