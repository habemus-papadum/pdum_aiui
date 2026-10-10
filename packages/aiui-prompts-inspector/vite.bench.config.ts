import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: fileURLToPath(new URL("./bench", import.meta.url)),
  plugins: [solid()],
  server: { host: "127.0.0.1", port: 5219, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/bench", import.meta.url)),
    emptyOutDir: true,
  },
});
