import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./playground", import.meta.url)),
  server: { host: "127.0.0.1", port: 5218, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/playground", import.meta.url)),
    emptyOutDir: true,
  },
});
