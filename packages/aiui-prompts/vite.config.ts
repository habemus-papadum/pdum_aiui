import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  test: {
    name: "aiui-prompts",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
  },
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "jsx-runtime": "src/jsx-runtime.ts",
        "jsx-dev-runtime": "src/jsx-dev-runtime.ts",
        operations: "src/operations.ts",
        analysis: "src/analysis.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: { external: externalizeDeps(pkg) },
  },
});
