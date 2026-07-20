/**
 * Standalone command — store one or more of the channel's vendor keys into
 * the OS vault (macOS Keychain / Linux Secret Service).
 *
 *   npm run store                                  (from exploration/os-vault/)
 *   npm run store -- OPENAI_API_KEY
 *   npm run store -- OPENAI_API_KEY GEMINI_API_KEY ELEVEN_LABS_API_KEY
 *   npm run store -- --service aiui-keys-test OPENAI_API_KEY
 *
 * For each requested key (default: all three), the value comes from:
 *   1. the matching env var, if set and non-empty — printed as "[env]"; or
 *   2. stdin, otherwise — piped input reads one line non-interactively
 *      (`echo "$SECRET" | npm run store -- OPENAI_API_KEY`), a real terminal
 *      gets a masked prompt (see `readSecret` in util.ts). Never argv, never
 *      shell history, never echoed to the terminal.
 *
 * Every entry is written under (service, account) = (`--service` or
 * "aiui-keys", the env var name) — e.g. service "aiui-keys", account
 * "OPENAI_API_KEY" — so it's trivially findable/removable later (Keychain
 * Access on macOS, `seahorse`/`secret-tool search` on Linux, or this spike's
 * own `delete.ts`).
 */

import { DEFAULT_VAULT_SERVICE } from "./spec.ts";
import { fail, heading, ok, parseArgs, readSecret } from "./util.ts";
import { vaultStore } from "./vault.ts";

async function main(): Promise<void> {
  const { keys, service = DEFAULT_VAULT_SERVICE } = parseArgs(process.argv.slice(2));

  heading(`Storing ${keys.length} key(s) into service "${service}"`);

  let anyFailed = false;
  for (const name of keys) {
    const fromEnv = process.env[name];
    const usingEnv = fromEnv !== undefined && fromEnv !== "";
    const value = usingEnv ? fromEnv : await readSecret(`${name}`);

    if (!usingEnv && value === "") {
      fail(`${name} — empty input, skipped (nothing was written)`);
      anyFailed = true;
      continue;
    }

    try {
      await vaultStore(service, name, value);
      ok(`${name}  →  stored  ${usingEnv ? "[source: env]" : "[source: stdin]"}`);
    } catch (e) {
      fail(`${name} — ${(e as Error).message}`);
      anyFailed = true;
    }
  }

  console.log("");
  if (anyFailed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
