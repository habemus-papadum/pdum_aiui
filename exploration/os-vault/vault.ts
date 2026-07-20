/**
 * Platform-selected vault: picks the macOS or Linux backend by
 * `process.platform` and exposes it as three plain functions, per the spike's
 * brief — `vaultStore` / `vaultLookup` / `vaultDelete`.
 *
 * Everything platform-specific lives in `vault-macos.ts` / `vault-linux.ts`;
 * this file is deliberately thin.
 */

import type { VaultBackend } from "./spec.ts";
import { linuxVault } from "./vault-linux.ts";
import { macosVault } from "./vault-macos.ts";

function selectBackend(): VaultBackend {
  switch (process.platform) {
    case "darwin":
      return macosVault;
    case "linux":
      return linuxVault;
    default:
      throw new Error(
        `os-vault: unsupported platform "${process.platform}" — only macOS (darwin) and Linux are ` +
          `implemented (see vault-macos.ts / vault-linux.ts). No vault backend exists for this OS.`,
      );
  }
}

/** The backend selected for the current `process.platform`. */
export const activeVault: VaultBackend = selectBackend();

/** Create or overwrite a vault entry. */
export const vaultStore: VaultBackend["store"] = (service, account, secret) =>
  activeVault.store(service, account, secret);

/** Read a vault entry, or `null` if it doesn't exist. */
export const vaultLookup: VaultBackend["lookup"] = (service, account) =>
  activeVault.lookup(service, account);

/** Remove a vault entry. Returns `false` (not an error) if nothing matched. */
export const vaultDelete: VaultBackend["delete"] = (service, account) =>
  activeVault.delete(service, account);
