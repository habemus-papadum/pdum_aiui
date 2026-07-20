/**
 * Standalone command — resolve one or more of the channel's vendor keys with
 * lookup order **environment variable → OS vault → error-and-exit**.
 *
 *   npm run resolve                              (from exploration/os-vault/)
 *   npm run resolve -- OPENAI_API_KEY
 *   npm run resolve -- --service aiui-keys-test GEMINI_API_KEY
 *
 * `resolveKey` is also the importable primitive other code would use — this
 * file's `main` is just a thin CLI wrapper around it. Never prints a secret
 * value; only where it came from (env vs vault) or, on failure, which key is
 * missing and how to store it.
 *
 * Exit code: 0 if every requested key resolved, 1 if any did not.
 */

import { pathToFileURL } from "node:url";
import {
  DEFAULT_VAULT_SERVICE,
  KeyNotFoundError,
  type ResolvedKey,
  type VendorKeyName,
} from "./spec.ts";
import { color, fail, heading, info, ok, parseArgs } from "./util.ts";
import { vaultLookup } from "./vault.ts";

/**
 * Resolve one key: env var first (if set to a non-empty string), else the OS
 * vault under `service`/`name`, else throw `KeyNotFoundError`.
 */
export async function resolveKey(
  name: VendorKeyName,
  service: string = DEFAULT_VAULT_SERVICE,
): Promise<ResolvedKey> {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== "") {
    return { name, from: "env", value: fromEnv };
  }
  const fromVault = await vaultLookup(service, name);
  if (fromVault !== null && fromVault !== "") {
    return { name, from: "vault", value: fromVault };
  }
  throw new KeyNotFoundError(name, service);
}

async function main(): Promise<void> {
  const { keys, service = DEFAULT_VAULT_SERVICE } = parseArgs(process.argv.slice(2));

  heading(`Resolving ${keys.length} key(s) — env → vault (service "${service}") → error`);

  let anyMissing = false;
  for (const name of keys) {
    try {
      const resolved = await resolveKey(name, service);
      ok(`${name}  →  ${color.bold(resolved.from)}`);
    } catch (e) {
      if (e instanceof KeyNotFoundError) {
        fail(e.message);
        anyMissing = true;
      } else {
        throw e;
      }
    }
  }

  console.log("");
  if (anyMissing) {
    info("one or more keys are missing — see the ✗ lines above for exactly how to store each one");
    process.exit(1);
  }
}

// Only run the CLI when this file is the entrypoint — never as a side effect
// of `import { resolveKey } from "./resolve.ts"` (this file is both the CLI
// and the importable primitive; importing it must not run `main`, or a
// consumer's own argv would get parsed as key names — as happened live while
// writing the verification script for this spike's README).
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
