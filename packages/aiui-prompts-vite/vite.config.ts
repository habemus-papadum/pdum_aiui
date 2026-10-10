import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  test: { name: "aiui-prompts-vite", include: ["test/**/*.test.ts"] },
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: { external: externalizeDeps(pkg) },
  },
});
