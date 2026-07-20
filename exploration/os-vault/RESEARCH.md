# OS-vault research notes

Distilled, implementation-facing findings for storing/reading the channel's
three vendor API keys in the OS's own secret store. See `spec.ts` for the
in-scope keys and `vault-macos.ts` / `vault-linux.ts` for the code these
findings are baked into.

## OBSERVED LIVE (this exploration, 2026-07-20, macOS) — the ground truth

`store.ts` / `resolve.ts` / `delete.ts` ran end-to-end against the real login
keychain under a throwaway `aiui-keys-test` service (never the real
`aiui-keys`). Findings below are what `security` actually did, which in two
places surprised the initial plan:

| Question | Expected (before testing) | Actually observed |
|---|---|---|
| Does `add-generic-password -w` (bare, prompts / reads stdin) avoid argv exposure cleanly? | Yes — "recommended" per its own `-h` text | **No** — piping the confirmation pair via stdin reliably left a stray trailing `\n` PERSISTED in the keychain item (confirmed with `-g`, which prints the untouched value). One trial even accepted a mismatched empty/empty pair silently (`0` exit, empty password stored) when the piped input didn't supply a second line — see "the double-prompt trap" below. |
| Does `find-generic-password -w` print the stored bytes exactly? | Yes | **No** — it appends a trailing `\n` to stdout unconditionally, even when stdout is a pipe (not a tty). Confirmed via `-w \| wc -c` (10 bytes for a 9-byte secret) vs. `-g` (shows the true unquoted value, 9 bytes). |
| Exit code for "no matching item" (`find-generic-password` / `delete-generic-password`)? | Undocumented in `-h` text | **44**, consistently, on this machine/OS version. `errSecItemNotFound` is `-25300` as a `OSStatus`, but the CLI's process exit code is `44` — matched defensively in code via BOTH the exit code and a `stderr` substring match, in case the numeric code isn't stable across macOS versions. |
| Does a non-interactive shell (this agent's bash tool) hit a GUI keychain-unlock prompt? | Maybe, since the login keychain is usually unlocked at login, but... | **No prompt, no hang** — add/find/delete all returned immediately. The login keychain was already unlocked (normal desktop login session), and an item created via `security` is trusted for further `security` access without a per-app ACL prompt (no `-T`/`-A` needed for our own round-trip). A machine where the login keychain is locked (freshly rebooted, no GUI login) would likely need `security unlock-keychain` first — not exercised here. |

### The double-prompt trap (why `store` uses `-w <value>`, not bare `-w`)

`security add-generic-password`'s own help text says `-w` "put at end of
command to be prompted (**recommended**)" — implying the safe move is to omit
the value and let `security` collect it out-of-band. In a real terminal that
works exactly as advertised (`getpass`-style, no echo). But this tool needs to
be driven non-interactively (piped stdin, or a CI step), and there:

- `security`'s stdin path asks for the password TWICE (an entry + a
  confirmation, "password data for new item:" / "retype password for new
  item:"), matching them before accepting.
- Piping the secret once (a single line) makes the SECOND prompt read EOF as
  its answer. Every trial in this exploration where that happened stored an
  **empty password**, silently, with exit code `0` — no error surfaced.
- Piping the secret twice (two identical lines) avoids the empty-password
  trap, but every trial still left a trailing `\n` byte in the STORED value
  (not just on read-back — confirmed independently via `-g`).

Neither failure mode throws or warns. Both are silent data corruption. This
is the reason `vault-macos.ts`'s `store` passes the secret as `-w <value>`
(a normal argv element, via `spawn(cmd, args)` with `args` as an array — never
through a shell, so it doesn't touch shell history) rather than following the
tool's own "recommended" stdin path. See `vault-macos.ts`'s file-level doc
comment for the exact citations/repro. The argv tradeoff this accepts —
brief visibility to `ps`/`/proc` for other local users while the child process
runs — is judged the lesser risk versus reliably corrupting a vendor API key;
documented, not hidden.

### The trailing-newline tax on read (why `lookup` strips one byte)

Separately from the store-side issue above, `find-generic-password -w` was
found to unconditionally suffix its stdout with one `\n`, regardless of
whether stdout is a tty. `vault-macos.ts`'s `lookup` strips exactly one
trailing `\n` (never more) to undo this and hand back the byte-exact secret —
verified live by round-tripping `sk-test-fake-value-…` (40 chars) through
`store` → `lookup` and asserting `value.length === 40` and strict equality.

## Linux (`secret-tool` / libsecret) — UNTESTED ON THIS MACHINE, sourced not guessed

This box is macOS; `which secret-tool` found nothing here, so nothing below
was run. It's written against two primary sources instead of memory/guesswork:

1. The Debian manpage (`secret-tool(1)`, libsecret-tools package):
   - `store: secret-tool store --label='Label' {attribute} {value} …` — "You
     must also specify a label for the password with the `--label` argument."
   - Password input: "If invoked from a terminal or tty, then the password to
     store will be prompted for and only one line will be accepted." Otherwise
     "A password to store can also be piped in via stdin" — and (from the Arch
     manpage's phrasing of the same passage) piped input "will include newline
     characters if provided that way", i.e. stdin is stored **verbatim,
     including whatever you send** — the opposite of macOS's silent-corruption
     behavior above. This is why `vault-linux.ts`'s `store` deliberately writes
     the secret with **no** trailing `\n` of its own.
   - `lookup`/`clear`: "Specify the same attribute name(s) and value pairs
     that you passed when storing the password." `clear` "removes all
     unlocked matching items."
   - Exit codes: "On success 0 is returned, a non-zero failure code
     otherwise" — no documented distinct code for "not found" vs. other
     failures.

2. `tool/secret-tool.c` in `GNOME/libsecret` (upstream source, read directly
   rather than assumed):
   - `lookup`: on no match, `secret_password_lookupv_binary_sync()` returns
     `NULL` and the command returns exit code `1` with **no stderr message**.
     On success, the raw password is written to stdout via
     `write_password_data()`, and a trailing `\n` is appended **only**
     `if (isatty(1))`. Node's `spawn` captures stdout via a pipe (never a
     tty), so `vault-linux.ts`'s `lookup` does NOT strip anything — the
     mirror image of the macOS quirk, and the reason that file's doc comment
     calls this out explicitly (easy to reflexively "fix" by copying the
     macOS trim logic, which would be wrong here and would truncate the last
     real character of the secret).
   - `clear`: on failure, prints `g_printerr("%s: %s\n", prgname,
     error->message)` **only if a GLib error object exists**; a plain "zero
     items matched" case returns `1` with **no stderr text**. `vault-linux.ts`
     encodes this as: nonzero exit + empty stderr ⇒ treat as "not found"
     (return `null`/`false`, not an error); nonzero exit + non-empty stderr ⇒
     surface it as a real failure. This is a best-effort reading of an
     under-specified contract, not a guarantee — the manual test steps in
     README.md exist specifically to validate or correct it on a real box.

### Caveats specific to Linux, not exercised here

- **Needs a running Secret Service provider** (gnome-keyring-daemon in a
  GNOME/most-desktop session, or KWallet's Secret Service compatibility
  layer in Plasma) **and an active D-Bus session bus**. A bare SSH session
  with no desktop session and no `dbus-run-session`/forwarded `DBUS_SESSION_
  BUS_ADDRESS` is a plausible failure mode (hang waiting for a prompter, or a
  D-Bus connection error) — not reproducible on this machine, called out in
  README.md's manual test steps instead.
- **Locked keyring**: `lookup` "unlocks one as needed" per the manpage, which
  on a graphical session pops a keyring-unlock prompt (harmless, but not
  "silent" the way macOS's already-unlocked login keychain was in this
  exploration).
- `secret-tool` binary location isn't hardcoded in `vault-linux.ts` (unlike
  the temptation to hardcode `/usr/bin/secret-tool`) — it's resolved via
  `PATH`, since its install path is less standardized across distros than
  macOS's `/usr/bin/security`.

## Native module vs. CLI-shelling — the tradeoff, and why CLI-shelling won

Two implementation strategies exist for talking to an OS secret store from
Node:

| | Native module (`keytar`, `@napi-rs/keyring`) | Shelling out to the OS CLI (`security` / `secret-tool`) |
|---|---|---|
| Install | Prebuilt binary per Node ABI/platform/arch, or a native build (node-gyp/napi + a C/C++ or Rust toolchain) if no matching prebuild exists | Nothing to install beyond what the OS/desktop already ships (macOS: always present; Linux: usually present on a graphical desktop, one `apt`/`dnf`/`pacman` command otherwise) |
| Fragility | Breaks silently across Node major version bumps, Electron ABI changes, or an uncommon arch/libc (musl/Alpine) without a prebuild; `keytar` itself is **deprecated/unmaintained** upstream | A subprocess call; the only failure modes are "binary missing" (handled explicitly, see `NOT_FOUND_HELP` in both backends) and documented CLI quirks (the whole point of this file) |
| This repo's own stance | `pnpm-workspace.yaml`'s `allowBuilds` **explicitly denies `keytar`'s build script** (comment: "keytar's native build backs the legacy credential store" — pulled in transitively by `@vscode/vsce`, not trusted) — i.e. this monorepo already has a documented, deliberate distrust of keytar's native build in exactly this codebase | No footprint in `allowBuilds` at all — `spawn` needs no install-time trust decision |
| Fits the packaging convention | Would need a `dist/`-shape native addon or `optionalDependencies` per platform, plus `pnpm test:packaging` coverage | N/A — pure TS, `tsx`-run, no build step, matching every other exploration spike in this repo |

**Chosen: shell out to the OS CLI.** It is dependency-light (nothing to
install on macOS; one well-known package on Linux, handled with a clear error
if missing), has no native-build/prebuild-availability risk, and this repo has
already made the equivalent call once before (denying keytar's build script).
The cost — CLI quirks like the two macOS gotchas above — is real but a fixed,
one-time cost paid by writing (and, on Linux, testing) the two backend files
carefully; it doesn't recur per install/per machine the way native-module
prebuild gaps do. `@napi-rs/keyring` is the more modern native alternative
(actively maintained, unlike `keytar`) and would be the thing to reach for if
this spike's CLI-quirk list ever grew large enough to outweigh the
install-fragility tradeoff — worth a note for whoever revisits this, not
reason enough on its own to switch here.
