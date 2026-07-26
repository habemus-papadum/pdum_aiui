/**
 * vite.ts — the dev-mode key injection (`./vite` subpath): a plugin that
 * hard-codes the developer's OWN key into the page, DEV SERVE ONLY.
 *
 * Why a runtime global and not `import.meta.env`: env substitution happens at
 * BUILD time, so a prebuilt library can never read its consumer's env — the
 * repo's documented rule is that runtime configuration for prebuilt code
 * travels through runtime channels. The plugin writes
 * `globalThis.__aiuiOracleDevKey` via an injected script tag; `devKeySource`
 * (keys.ts) reads it back.
 *
 * Why this cannot leak: `apply: "serve"` — the plugin does not exist during
 * `vite build`, so no production bundle can ever contain the key. The static
 * app deploys with paste-key (and optionally a mint endpoint); in dev the
 * same app just works with no separate server and nothing pasted.
 */

import type { Plugin } from "vite";
import { DEV_KEY_GLOBAL } from "./keys";

export interface OracleDevKeyOptions {
  /** The env var the DEV SERVER reads. Default `OPENAI_API_KEY`. */
  env?: string;
}

export function oracleDevKey(options: OracleDevKeyOptions = {}): Plugin {
  const envVar = options.env ?? "OPENAI_API_KEY";
  return {
    name: "aiui-oracle-dev-key",
    apply: "serve",
    transformIndexHtml() {
      const key = process.env[envVar];
      if (key === undefined || key === "") {
        return [];
      }
      return [
        {
          tag: "script",
          children: `globalThis.${DEV_KEY_GLOBAL} = ${JSON.stringify(key)};`,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
