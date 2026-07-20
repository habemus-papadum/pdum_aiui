/**
 * The OS vault: vendor API keys at rest in the operating system's own secret
 * store — the macOS login keychain (via the `security` CLI) or the
 * freedesktop.org Secret Service (via `secret-tool`). Promoted from
 * `exploration/os-vault`, which live-verified the macOS backend and sourced
 * the Linux one from upstream (its RESEARCH.md holds the full trail); the two
 * platform quirks that shaped this code are kept in the backend doc comments
 * below because each one silently corrupts a secret if "fixed".
 *
 * Shelling out to the OS CLI is a deliberate choice over a native keyring
 * module (`keytar`, `@napi-rs/keyring`): nothing to install on macOS, one
 * well-known package on Linux, no native-build/ABI fragility — and this
 * repo's `pnpm-workspace.yaml` already explicitly denies `keytar`'s build
 * script, i.e. the equivalent call was made here once before.
 *
 * Every entry is `(service, account) = ("aiui-keys", "<ENV_VAR_NAME>")` — what
 * Keychain Access shows as "Where"/"Account", and two `secret-tool` attributes
 * of the same names on Linux. Searchable either way: `security dump-keychain |
 * grep aiui-keys`, or `secret-tool search service aiui-keys`.
 */

import { spawn } from "node:child_process";

/** The vault namespace every aiui entry lives under (the keychain "service"). */
export const DEFAULT_VAULT_SERVICE = "aiui-keys";

export interface ToolRunResult {
  /** Exit code, or `null` if the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The one process seam, injectable for tests: run `cmd args…` capturing
 * stdout/stderr, resolving even on a non-zero exit (backends distinguish
 * "not found" from real failure by inspecting `code` + `stderr` themselves).
 * `input`, when given, is written to stdin EXACTLY as-is and then closed —
 * no trailing newline is ever appended (see the byte-exactness notes below).
 */
export type ToolRunner = (
  cmd: string,
  args: string[],
  opts?: { input?: string },
) => Promise<ToolRunResult>;

/** The default runner: `spawn` with an argv ARRAY — never a shell, so secrets
 * never touch shell history or quoting. A missing binary (`ENOENT`) rejects;
 * `vaultToolFor` turns that into the platform's install hint. */
const spawnRunner: ToolRunner = (cmd, args, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input, "utf8");
    }
    child.stdin.end();
  });

export interface VaultOptions {
  /** The vault namespace; defaults to {@link DEFAULT_VAULT_SERVICE}. Tests and
   * dry-runs pass their own (e.g. `aiui-keys-test`) to never touch the real one. */
  service?: string;
  /** Injectable process runner for tests; defaults to spawning the real CLI. */
  runner?: ToolRunner;
}

interface VaultBackend {
  label: string;
  bin: string;
  notFoundHelp: string;
  store(run: ToolRunner, service: string, account: string, secret: string): Promise<void>;
  lookup(run: ToolRunner, service: string, account: string): Promise<string | null>;
  remove(run: ToolRunner, service: string, account: string): Promise<boolean>;
}

// ── macOS: the login keychain via `security` ─────────────────────────────────
//
// The trailing-newline gotcha (observed live, 2026-07-20, exploration/os-vault):
//  - `add-generic-password` with a bare `-w` (its own "recommended" prompting
//    form) silently CORRUPTS the stored secret when driven non-interactively:
//    a piped confirmation pair persists a stray trailing `\n` in the item, and
//    a single piped line stores an EMPTY password with exit 0. So `store`
//    passes the secret as `-w <value>` — a normal argv element via spawn's
//    array (never a shell), briefly visible to `ps` for other local users
//    while the child runs; judged the lesser risk vs silent corruption, per
//    the repo's trusted-machine posture.
//  - `find-generic-password -w` unconditionally appends one `\n` to stdout
//    (tty or not) — `lookup` strips exactly that one byte, never more.

/** macOS `security` exit code for "no matching keychain item" (observed live;
 * also documented as errSecItemNotFound). Matched with the stderr text too, in
 * case the numeric code drifts across macOS versions. */
const MACOS_EXIT_NOT_FOUND = 44;

const macosNotFound = (code: number | null, stderr: string): boolean =>
  code === MACOS_EXIT_NOT_FOUND || /could not be found in the keychain/i.test(stderr);

const macosBackend: VaultBackend = {
  label: "macOS login keychain (security)",
  bin: "security",
  notFoundHelp:
    "This shouldn't happen on macOS — `security` ships with the OS at /usr/bin/security. Check your PATH.",
  async store(run, service, account, secret) {
    const { code, stderr } = await run("security", [
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
      "stored by aiui — manage with `aiui keys`",
    ]);
    if (code !== 0) {
      throw new Error(`security add-generic-password failed (exit ${code}): ${stderr.trim()}`);
    }
  },
  async lookup(run, service, account) {
    const { code, stdout, stderr } = await run("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ]);
    if (code === 0) {
      // Strip the one trailing "\n" `security -w` always appends — see the
      // section comment. Only ever one char; a real secret never ends in "\n".
      return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    }
    if (macosNotFound(code, stderr)) {
      return null;
    }
    throw new Error(`security find-generic-password failed (exit ${code}): ${stderr.trim()}`);
  },
  async remove(run, service, account) {
    const { code, stderr } = await run("security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      service,
    ]);
    if (code === 0) {
      return true;
    }
    if (macosNotFound(code, stderr)) {
      return false;
    }
    throw new Error(`security delete-generic-password failed (exit ${code}): ${stderr.trim()}`);
  },
};

// ── Linux: the freedesktop Secret Service via `secret-tool` ──────────────────
//
// The mirror image of the macOS quirk (per upstream tool/secret-tool.c, cited
// in exploration/os-vault/RESEARCH.md): `store` persists stdin VERBATIM —
// including any newline you send — so the secret is written with NO trailing
// newline of its own; `lookup` appends a trailing newline only `if
// (isatty(1))`, and spawn's pipe is never a tty, so there is NOTHING to strip
// on read. Copying the macOS trim here would truncate the secret's last byte.
//
// Its exit contract is coarse (0 or "a non-zero failure code"; a plain no-match
// returns 1 with NO stderr): non-zero + empty stderr ⇒ not-found; non-zero +
// stderr text ⇒ a real failure, surfaced.

const linuxNotFound = (code: number | null, stderr: string): boolean =>
  code !== 0 && stderr.trim() === "";

const linuxBackend: VaultBackend = {
  label: "freedesktop Secret Service (secret-tool)",
  bin: "secret-tool",
  notFoundHelp:
    "Install it — Debian/Ubuntu: `sudo apt install libsecret-tools`; Fedora: `sudo dnf install libsecret`; " +
    "Arch: `sudo pacman -S libsecret`. It also needs a running Secret Service provider " +
    "(gnome-keyring-daemon, or KWallet's Secret Service shim) and an active D-Bus session.",
  async store(run, service, account, secret) {
    const { code, stderr } = await run(
      "secret-tool",
      ["store", "--label", `aiui-keys: ${account}`, "service", service, "account", account],
      { input: secret }, // no trailing "\n" — see the section comment
    );
    if (code !== 0) {
      throw new Error(`secret-tool store failed (exit ${code}): ${stderr.trim()}`);
    }
  },
  async lookup(run, service, account) {
    const { code, stdout, stderr } = await run("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      account,
    ]);
    if (code === 0) {
      return stdout; // byte-exact — see the section comment
    }
    if (linuxNotFound(code, stderr)) {
      return null;
    }
    throw new Error(`secret-tool lookup failed (exit ${code}): ${stderr.trim()}`);
  },
  async remove(run, service, account) {
    const { code, stderr } = await run("secret-tool", [
      "clear",
      "service",
      service,
      "account",
      account,
    ]);
    if (code === 0) {
      return true;
    }
    if (linuxNotFound(code, stderr)) {
      return false;
    }
    throw new Error(`secret-tool clear failed (exit ${code}): ${stderr.trim()}`);
  },
};

// ── the public surface ───────────────────────────────────────────────────────

function backend(): VaultBackend {
  if (process.platform === "darwin") {
    return macosBackend;
  }
  if (process.platform === "linux") {
    return linuxBackend;
  }
  throw new Error(
    `no OS vault backend for platform "${process.platform}" — aiui supports the macOS ` +
      "keychain and the freedesktop Secret Service (Linux).",
  );
}

/** Human label of this platform's vault, for status displays and logs. */
export function vaultLabel(): string {
  return backend().label;
}

/** Wrap a runner so a missing vault CLI reads as an actionable install hint. */
function runnerFor(b: VaultBackend, runner: ToolRunner): ToolRunner {
  return async (cmd, args, opts) => {
    try {
      return await runner(cmd, args, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`\`${b.bin}\` was not found on PATH. ${b.notFoundHelp}`);
      }
      throw err;
    }
  };
}

/** Create or overwrite the secret for `account` (idempotent). */
export async function vaultStore(
  account: string,
  secret: string,
  options: VaultOptions = {},
): Promise<void> {
  const b = backend();
  await b.store(
    runnerFor(b, options.runner ?? spawnRunner),
    options.service ?? DEFAULT_VAULT_SERVICE,
    account,
    secret,
  );
}

/** The secret for `account`, or `null` when no entry exists. */
export async function vaultLookup(
  account: string,
  options: VaultOptions = {},
): Promise<string | null> {
  const b = backend();
  return b.lookup(
    runnerFor(b, options.runner ?? spawnRunner),
    options.service ?? DEFAULT_VAULT_SERVICE,
    account,
  );
}

/** Remove the entry. Returns `false` (not an error) when nothing matched. */
export async function vaultDelete(account: string, options: VaultOptions = {}): Promise<boolean> {
  const b = backend();
  return b.remove(
    runnerFor(b, options.runner ?? spawnRunner),
    options.service ?? DEFAULT_VAULT_SERVICE,
    account,
  );
}
