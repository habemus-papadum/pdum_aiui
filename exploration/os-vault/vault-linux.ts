/**
 * Linux backend: the freedesktop.org Secret Service, via the `secret-tool`
 * CLI (package `libsecret-tools` on Debian/Ubuntu, `libsecret` on
 * Fedora/Arch — part of libsecret, the same library GNOME Keyring / KWallet's
 * Secret Service shim implement).
 *
 * **UNTESTED ON THIS MACHINE** — this box is macOS and has no `secret-tool`
 * (confirmed: `which secret-tool` → not found). Written carefully against
 * upstream's documented + source-level behavior (see RESEARCH.md for the
 * citations: the Debian manpage and `tool/secret-tool.c` in GNOME/libsecret).
 * README.md has exact manual steps to verify this on a real Linux desktop
 * before trusting it.
 *
 * Entries use two freeform attributes, `service` and `account`, mirroring the
 * macOS backend's `-s`/`-a` so the two backends are conceptually symmetric
 * even though secret-tool's attribute schema is arbitrary (no fixed
 * service/account fields like Keychain has — we're defining that shape
 * ourselves via matching attribute names on store/lookup/clear).
 *
 * ── Byte-exactness, the mirror image of the macOS quirk ──
 *
 * Per `tool/secret-tool.c` (see RESEARCH.md): `store` reads stdin verbatim,
 * including any newlines, and stores exactly those bytes — so `store` below
 * writes the secret with NO trailing newline of its own. `lookup` writes the
 * raw secret to stdout and appends a trailing newline ONLY `if (isatty(1))` —
 * i.e. only for a human at a terminal. Node's `spawn` captures stdout via a
 * pipe, which is never a tty, so the byte-exact secret comes back with
 * nothing to strip. (Contrast `vault-macos.ts`, where `security` appends that
 * newline unconditionally and `lookup` has to trim it.)
 */

import { runTool } from "./proc.ts";
import type { VaultBackend } from "./spec.ts";

const SECRET_TOOL_BIN = "secret-tool";
const NOT_FOUND_HELP =
  "Install it — Debian/Ubuntu: `sudo apt install libsecret-tools`; Fedora: `sudo dnf install libsecret`; " +
  "Arch: `sudo pacman -S libsecret`. It also needs a running Secret Service provider (gnome-keyring-daemon, " +
  "or KWallet's Secret Service shim) and an active D-Bus session — see README.md's Linux test steps.";

/**
 * secret-tool's own exit-code contract is coarse: "0 on success, non-zero
 * failure code otherwise" (its manpage), and its C source returns a bare `1`
 * for both "no matching item" AND certain silent errors (see RESEARCH.md).
 * We treat any non-zero exit from `lookup`/`clear` as "not found" UNLESS
 * stderr has actual text, in which case something more specific went wrong
 * and we surface it rather than silently reporting "not found".
 */
function isNotFound(code: number | null, stderr: string): boolean {
  return code !== 0 && stderr.trim() === "";
}

export const linuxVault: VaultBackend = {
  platform: "linux",
  label: "freedesktop Secret Service (secret-tool)",

  async store(service, account, secret) {
    const { code, stderr } = await runTool(
      SECRET_TOOL_BIN,
      ["store", "--label", `aiui-keys: ${account}`, "service", service, "account", account],
      { input: secret }, // no trailing "\n" added — see file-level doc comment
      NOT_FOUND_HELP,
    );
    if (code !== 0) {
      throw new Error(`secret-tool store failed (exit ${code}): ${stderr.trim()}`);
    }
  },

  async lookup(service, account) {
    const { code, stdout, stderr } = await runTool(
      SECRET_TOOL_BIN,
      ["lookup", "service", service, "account", account],
      {},
      NOT_FOUND_HELP,
    );
    if (code === 0) return stdout; // byte-exact — see file-level doc comment
    if (isNotFound(code, stderr)) return null;
    throw new Error(`secret-tool lookup failed (exit ${code}): ${stderr.trim()}`);
  },

  async delete(service, account) {
    const { code, stderr } = await runTool(
      SECRET_TOOL_BIN,
      ["clear", "service", service, "account", account],
      {},
      NOT_FOUND_HELP,
    );
    if (code === 0) return true;
    if (isNotFound(code, stderr)) return false;
    throw new Error(`secret-tool clear failed (exit ${code}): ${stderr.trim()}`);
  },
};
