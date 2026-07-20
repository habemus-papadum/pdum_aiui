/**
 * Convenience command — remove one or more vault entries. NOT one of the
 * spike's two required deliverables (store, resolve); this exists because
 * `vaultDelete` is part of the required backend interface and because
 * cleaning up a test/rotated entry is otherwise a hunt through Keychain
 * Access / `seahorse`. Used by this spike's own live verification to remove
 * the `aiui-keys-test` entries it created.
 *
 *   npm run delete -- --service aiui-keys-test OPENAI_API_KEY
 */

import { DEFAULT_VAULT_SERVICE } from "./spec.ts";
import { heading, info, ok, parseArgs } from "./util.ts";
import { vaultDelete } from "./vault.ts";

async function main(): Promise<void> {
  const { keys, service = DEFAULT_VAULT_SERVICE } = parseArgs(process.argv.slice(2));

  heading(`Deleting ${keys.length} key(s) from service "${service}"`);

  for (const name of keys) {
    const deleted = await vaultDelete(service, name);
    if (deleted) ok(`${name}  →  deleted`);
    else info(`${name}  →  no entry found (nothing to delete)`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
