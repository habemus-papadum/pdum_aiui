import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { ipadUrl } from "./ipad-url.ts";

/** Local pencil tuning rig, reachable directly from an iPad on the same network. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: true },
  plugins: [aiui({ locator: true }), solid(), ipadUrl()],
});
