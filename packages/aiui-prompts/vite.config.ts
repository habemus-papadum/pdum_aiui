import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [
    {
      name: "aiui-prompts:inspector-style",
      generateBundle() {
        for (const path of [
          "inspector/style.css",
          "inspector/themes/aiui.css",
          "inspector/themes/terminal.css",
        ])
          this.emitFile({
            type: "asset",
            fileName: path,
            source: readFileSync(new URL(`./${path}`, import.meta.url), "utf8"),
          });
      },
    },
  ],
  test: {
    name: "aiui-prompts",
    include: ["src/**/*.test.{ts,tsx}", "inspector/**/*.test.ts", "test/**/*.test.ts"],
  },
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "jsx-runtime": "src/jsx-runtime.ts",
        "jsx-dev-runtime": "src/jsx-dev-runtime.ts",
        vite: "src/vite.ts",
        operations: "src/operations.ts",
        analysis: "src/analysis.ts",
        "inspector/index": "inspector/index.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true, // declarations are emitted after the clean library build
    rollupOptions: {
      external: externalizeDeps(pkg),
    },
  },
});
