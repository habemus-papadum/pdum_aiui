import { join } from "node:path";
import { defineConfig } from "electron-vite";
import { gatewayProxy } from "./infrastructure/gateway-proxy.ts";

// Each dev launch supplies its own output and cache paths, not just a unique port.
const output = process.env.ELECTRON_OUTPUT ?? "out";
const gateway = process.env.GATEWAY_URL;
const cacheDir = process.env.ELECTRON_CACHE ?? "node_modules/.vite";
export default defineConfig({
  main: {
    build: {
      outDir: join(output, "main"),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: { output: { entryFileNames: "index.cjs", format: "cjs" } },
    },
  },
  preload: {
    build: {
      outDir: join(output, "preload"),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: { output: { entryFileNames: "index.cjs", format: "cjs" } },
    },
  },
  renderer: {
    base: "./",
    cacheDir,
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: gateway ? gatewayProxy(gateway) : {},
    },
    build: { outDir: join(output, "renderer") },
  },
});
