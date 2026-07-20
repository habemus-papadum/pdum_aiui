/**
 * macOS backend: the login keychain, via the `security` CLI (`/usr/bin/security`,
 * ships with every macOS install — no dependency to acquire).
 *
 * Entries are "generic password" items: `-s <service>` / `-a <account>`
 * (Keychain Access shows these as "Where"/"Account"). `-U` on `add-generic-password`
 * makes store idempotent (update in place instead of erroring if it exists).
 *
 * ── The trailing-newline gotcha (OBSERVED LIVE, 2026-07-20, macOS, this
 * machine's `security`) ──
 *
 * Two things were tested against a throwaway keychain entry before writing
 * this file:
 *
 * 1. `security add-generic-password … -w` with NO value (its own "recommended"
 *    form — prompts interactively, or reads two matching lines from stdin
 *    when piped) reliably CORRUPTS the stored secret: every trial via a piped
 *    stdin (single value repeated on two lines, as required for the
 *    confirmation prompt) ended up with a stray trailing `\n` actually
 *    persisted in the keychain item (verified with `find-generic-password -g`,
 *    which prints the untouched `password: "…"` form). Because of this we do
 *    NOT use the bare/stdin `-w` prompt path for storing — see RESEARCH.md
 *    for the full trace.
 * 2. Passing `-w <secret>` as a normal argv value stores the secret
 *    byte-exact (confirmed with `-g`) — no corruption on the STORE side.
 *
 * The corruption is instead entirely on the READ side: `find-generic-password
 * -w` unconditionally appends a trailing `\n` to what it prints to stdout —
 * confirmed by comparing `-w | wc -c` (10 bytes for a 9-byte secret) against
 * `-g` (which showed the true 9-byte value). It does this whether or not
 * stdout is a tty, unlike Linux's `secret-tool` (see `vault-linux.ts`), so
 * `lookup` below strips exactly one trailing `\n` to recover the original.
 *
 * Net effect: `store` passes the secret via argv (see the tradeoff note in
 * RESEARCH.md — this briefly puts the secret in this one child process's argv,
 * visible to `ps` for other local users during that process's lifetime, but
 * never in a shell history since `spawn` is invoked with an argv array, not a
 * shell string); `lookup` trims the one byte `security` adds on the way out.
 */

import { runTool } from "./proc.ts";
import type { VaultBackend } from "./spec.ts";

const SECURITY_BIN = "security";
const NOT_FOUND_HELP =
  "This shouldn't happen on macOS — `security` ships with the OS at /usr/bin/security. Check your PATH.";

/** macOS `security` exit code for "no matching keychain item" (observed live; also documented as errSecItemNotFound). */
const EXIT_NOT_FOUND = 44;

function isNotFound(code: number | null, stderr: string): boolean {
  return code === EXIT_NOT_FOUND || /could not be found in the keychain/i.test(stderr);
}

export const macosVault: VaultBackend = {
  platform: "darwin",
  label: "macOS login keychain (security CLI)",

  async store(service, account, secret) {
    const { code, stderr } = await runTool(
      SECURITY_BIN,
      [
        "add-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
        secret,
        "-U", // update in place if it already exists (idempotent store)
        "-D",
        "aiui vendor API key",
        "-j",
        "stored by exploration/os-vault — see its README.md",
      ],
      {},
      NOT_FOUND_HELP,
    );
    if (code !== 0) {
      throw new Error(`security add-generic-password failed (exit ${code}): ${stderr.trim()}`);
    }
  },

  async lookup(service, account) {
    const { code, stdout, stderr } = await runTool(
      SECURITY_BIN,
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      {},
      NOT_FOUND_HELP,
    );
    if (code === 0) {
      // Strip the one trailing "\n" `security -w` always appends on output —
      // see the file-level doc comment. Only ever strip a single char here;
      // a real secret should never legitimately end in "\n".
      return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    }
    if (isNotFound(code, stderr)) return null;
    throw new Error(`security find-generic-password failed (exit ${code}): ${stderr.trim()}`);
  },

  async delete(service, account) {
    const { code, stderr } = await runTool(
      SECURITY_BIN,
      ["delete-generic-password", "-a", account, "-s", service],
      {},
      NOT_FOUND_HELP,
    );
    if (code === 0) return true;
    if (isNotFound(code, stderr)) return false;
    throw new Error(`security delete-generic-password failed (exit ${code}): ${stderr.trim()}`);
  },
};
