import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/** The RichTeX lab — `pnpm -C packages/aiui-viz lab`. One document, routed
 * on the pathname (Vite's SPA fallback serves index.html for every page). */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [aiui({ locator: true }), solid()],
});
