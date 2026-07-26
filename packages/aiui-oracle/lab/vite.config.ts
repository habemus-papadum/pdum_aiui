import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * Oracle Lab's dev server — the pencil playbook, minus the relay (the oracle
 * talks to the vendor directly; there is no backend to mount).
 *
 * `aiui({ locator: true })` is load-bearing: the aiui compiler injects
 * `control()` names from their bindings (without it every control in store.ts
 * throws "needs a name") and stamps source locations. Order matters — its
 * `pre` babel pass must run before vite-plugin-solid compiles JSX away.
 *
 * `root` from the module URL, NOT `__dirname` (undefined in a `"type":
 * "module"` package — Vite would silently root at the CWD and 404).
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [aiui({ locator: true }), solid()],
  server: {
    // A LAN device (the iPad) may join — the trusted-LAN posture,
    // docs/guide/warning.md. Note the mic needs a secure context: fine on
    // localhost; a LAN address wants the CfT flag or https.
    host: true,
  },
});
