import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./bench", import.meta.url)),
  server: { host: "127.0.0.1", port: 5219, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("../dist/inspector-bench", import.meta.url)),
    emptyOutDir: true,
  },
});
