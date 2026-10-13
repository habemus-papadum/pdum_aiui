import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Building the frontend never starts a backend or embeds local backend addresses.
export default defineConfig({
  root: fileURLToPath(new URL("./app", import.meta.url)),
  build: { outDir: "../dist", emptyOutDir: true },
});
