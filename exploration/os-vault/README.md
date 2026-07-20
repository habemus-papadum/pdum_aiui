# OS vault — exploration

> **PROMOTED (2026-07-20).** This spike shipped: the vault backends (with both
> live-discovered `security` quirks), the masked/piped secret input, and the
> resolver now live in `packages/aiui-util` (`vault.ts`, `secret-input.ts`,
> `vendor-keys.ts`), managed by `aiui keys` and resolved by the channel at
> boot — see `docs/guide/config.md` "Vendor API keys". This folder stays as
> the research record (RESEARCH.md is cited from the shipped code) and as a
> standalone harness for the still-pending live Linux verification below.

Standalone spike (not wired into anything) that answers: **can the channel's
three vendor API keys live in the OS's own secret store instead of (or in
addition to) the environment, with a resolver that prefers the environment
and falls back to the vault?**

This is independent of the sibling `exploration/ephemeral-keys` spike, which
mints short-lived *derived* credentials from these same parent keys — this
spike is about where the long-lived parent keys themselves rest at all.

The keys in scope (the channel's three vendors — the Anthropic key belongs to
the `claude` CLI, not the channel, so it's out of scope, same carve-out as the
ephemeral-keys spike):

| Env var | Vendor |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Gemini |
| `ELEVEN_LABS_API_KEY` | ElevenLabs |

## Run it

Self-contained — its own `node_modules`, nothing from the workspace (this
folder sits outside `pnpm-workspace.yaml`'s globs on purpose).

```sh
cd exploration/os-vault
npm install                      # one-time

# store — reads from the env var if set, else a single line from stdin
# (piped, or masked-prompt if you're at a real terminal — see "Secret input")
npm run store -- OPENAI_API_KEY
echo "$OPENAI_API_KEY" | npm run store -- OPENAI_API_KEY   # equivalent, explicit
npm run store                    # all three keys, one line of stdin per missing one

# resolve — env -> vault -> error, per key; never prints a secret value
npm run resolve -- OPENAI_API_KEY
npm run resolve                  # all three

# delete — convenience/hygiene, not one of the two required commands
npm run delete -- OPENAI_API_KEY

npm run typecheck                # npx tsc --noEmit
```

Every command accepts `--service <name>` to target a different vault
namespace than the default `aiui-keys` (used below to test against
`aiui-keys-test` without touching anything real):

```sh
npm run store -- --service aiui-keys-test OPENAI_API_KEY
```

## What this is (the two required deliverables)

1. **`store.ts`** — stores one or more keys into the OS vault, service
   `aiui-keys` (or `--service`), account = the env var name. Idempotent
   (re-running overwrites).
2. **`resolve.ts`** — exports `resolveKey(name, service?)`, the importable
   primitive: **env var → OS vault → throw `KeyNotFoundError`**. Its `main`
   is a thin CLI wrapper: prints `NAME → env` or `NAME → vault` per key
   (never the value), or `✗ NAME is not set …` with the exact store command
   to fix it, and exits non-zero if anything is missing.

`delete.ts` is a small third command, not one of the two asked for — it
exists because the interface needs a `vaultDelete`, and this exploration's
own live verification needed a way to clean up its test entries.

### Naming scheme

Every vault entry is `(service, account) = ("aiui-keys", "<ENV_VAR_NAME>")` —
e.g. service `aiui-keys`, account `OPENAI_API_KEY`. On macOS this is exactly
what Keychain Access shows as "Where"/"Account"; on Linux it's two
`secret-tool` attributes of the same names. Namespaced and searchable either
way — `security dump-keychain | grep aiui-keys` or `secret-tool search
service aiui-keys` finds everything this tool wrote.

## Secret input: never argv, never shell history

`store.ts` takes a key's value from the matching env var if set; otherwise it
reads **one line from stdin** — either piped (`echo "$X" | npm run store --
FOO`, the expected scripting path) or, at a real interactive terminal, a
raw-mode masked prompt (keystrokes aren't echoed, same technique `npm`'s own
password prompts use — see `readSecret` in `util.ts`). The value is never a
CLI argument and never touches shell history.

Internally, forwarding the secret to the OS tool differs by platform (see
`RESEARCH.md` for the full why): macOS's `security` gets it as a normal argv
element via `spawn(cmd, args)` — an array, not a shell string, so it still
never touches *shell history*, though it's briefly visible to `ps`/`/proc` for
other local users on a shared machine (this repo's documented "trusted-LAN /
trusted-machine" posture already accepts a comparable tradeoff elsewhere).
Linux's `secret-tool` gets it purely via stdin, with no argv exposure at all —
`secret-tool` supports that cleanly; `security` does not (see below).

## The vault mechanism: shelling out to the OS CLI, not a native module

**Chosen: `security` (macOS) / `secret-tool` (Linux), via `node:child_process`
`spawn`.** Weighed against a native keyring module (`keytar`,
`@napi-rs/keyring`) in `RESEARCH.md` in detail; short version: nothing to
install on macOS, one common package on Linux (handled with a clear error if
missing) vs. a native addon needing a prebuild for your exact Node ABI/arch or
a full native toolchain — and this repo's own `pnpm-workspace.yaml` already
explicitly **denies `keytar`'s build script** (pulled in transitively by
`@vscode/vsce`), i.e. this codebase has already made the equivalent call once.

Both backends sit behind one interface (`spec.ts`'s `VaultBackend`:
`store`/`lookup`/`delete`), selected by `process.platform` in `vault.ts`,
exported as the three plain functions the brief asked for: `vaultStore`,
`vaultLookup`, `vaultDelete`. An unsupported `process.platform` throws
immediately with a clear message.

## Live macOS verification (this machine) — results

Run against the real login keychain under a throwaway `--service
aiui-keys-test`, never the real `aiui-keys`, then deleted. Full trace and the
two live-discovered `security` quirks that shaped the implementation
(a corrupting stdin double-prompt on store; an unconditional trailing `\n` on
read) are in `RESEARCH.md`'s "OBSERVED LIVE" section — summary:

| Scenario | Result |
|---|---|
| `resolve` — key absent from env AND vault | Clean `✗ … Store it with: npm run store -- OPENAI_API_KEY` message, exit `1`. No stack trace. |
| `store` — value from env, then `resolve` with env unset | Resolves `from: vault`. Byte-exact round trip confirmed (40-char test string, strict equality). |
| `resolve` — value present in BOTH env and vault, but different | Resolves `from: env`, using the env value — env wins, as specified. |
| `store` — 2 keys in one invocation via 2 piped stdin lines | Both stored correctly (see the readline bug fixed along the way, below). |
| `delete` — existing entry | Reports `deleted`, exit `0`. |
| `delete` — already-gone entry (idempotent re-run) | Reports `no entry found (nothing to delete)`, exit `0` — not an error. |
| Any GUI/keychain-unlock prompt in this non-interactive shell? | **No.** The login keychain was already unlocked (normal desktop session); add/find/delete all returned immediately. A freshly-rebooted, no-GUI-login machine might behave differently (`security unlock-keychain`) — not exercised. |
| Real `aiui-keys` service touched? | Confirmed absent/untouched both before and after (`find-generic-password … -s aiui-keys` → exit `44`, not found, throughout). |

One real bug was caught and fixed by this live testing, not just the two
`security`-specific ones documented in `RESEARCH.md`: the first cut of the
piped-stdin reader used a single shared `readline.Interface#question()` in a
loop, which throws `ERR_USE_AFTER_CLOSE` on the second call — `readline`
auto-closes as soon as the underlying (piped, EOF-terminated) stream ends,
which for a `printf 'a\nb\n' | …` pipe happens right after the first line is
delivered. Fixed in `util.ts` by buffering all of stdin once and serving
lines from that buffer instead. (Also caught: `resolve.ts`'s `main()` was
originally running unconditionally at import time, meaning `import {
resolveKey } from "./resolve.ts"` from anywhere else would try to parse the
importing script's own `process.argv` as key names. Fixed with an
`import.meta.url`-vs-`process.argv[1]` entrypoint guard.)

## Linux status: UNTESTED ON THIS MACHINE

This machine is macOS (`which secret-tool` → not found here). `vault-linux.ts`
is written against `secret-tool`'s manpage plus a direct read of
`tool/secret-tool.c` upstream (GNOME/libsecret) — not memory or guesswork; see
`RESEARCH.md` for the exact citations, including the one place its behavior is
the deliberate mirror-image of the macOS quirks (secret-tool does NOT need a
trailing-newline strip on read; macOS does).

**To verify on a real Linux desktop (GNOME/KDE, or any Secret-Service-backed
session):**

```sh
which secret-tool || sudo apt install libsecret-tools   # or: dnf install libsecret / pacman -S libsecret

cd exploration/os-vault && npm install

# 1. store, from env
export OPENAI_API_KEY=sk-test-not-a-real-key
npm run store -- --service aiui-keys-test OPENAI_API_KEY

# 2. resolve with env unset -> should say "vault"
env -u OPENAI_API_KEY npm run resolve -- --service aiui-keys-test OPENAI_API_KEY

# 3. byte-exactness: compare directly against secret-tool
secret-tool lookup service aiui-keys-test account OPENAI_API_KEY
#   should print exactly "sk-test-not-a-real-key" with no extra/missing chars

# 4. env wins over vault
OPENAI_API_KEY=sk-test-ENV-WINS npm run resolve -- --service aiui-keys-test OPENAI_API_KEY
#   should say "env"

# 5. clean error when neither is set
env -u OPENAI_API_KEY npm run resolve -- --service aiui-keys-test-nonexistent OPENAI_API_KEY
#   should print the ✗ message and exit 1, NOT hang or stack-trace

# 6. cleanup
npm run delete -- --service aiui-keys-test OPENAI_API_KEY
secret-tool lookup service aiui-keys-test account OPENAI_API_KEY; echo "exit=$?"  # should be nonzero, no output
```

Also worth checking on a real box, per the caveats in `RESEARCH.md`: behavior
over SSH with no D-Bus session (a plausible hang or connection error — see
`NOT_FOUND_HELP` in `vault-linux.ts` for the install-side error message; the
D-Bus-session case isn't covered by that message and would show up as
whatever `secret-tool` itself prints), and whether a locked keyring pops an
unlock prompt on `lookup` as the manpage suggests ("unlocks one as needed").

## Files

| File | Role |
|---|---|
| `spec.ts` | Shared types (`VendorKeyName`, `VaultBackend`, `ResolvedKey`) + the `KeyNotFoundError` message + the default service name |
| `proc.ts` | `run`/`runTool` — the one child-process helper both backends use (never throws on non-zero exit; turns a missing-binary `ENOENT` into a clear message) |
| `vault-macos.ts` | macOS backend (`security` CLI) — see its file-level doc comment for the two live-discovered quirks |
| `vault-linux.ts` | Linux backend (`secret-tool` CLI) — untested here; written from upstream source + manpage, cited in `RESEARCH.md` |
| `vault.ts` | Picks a backend by `process.platform`; exports `vaultStore` / `vaultLookup` / `vaultDelete` |
| `util.ts` | Logger, `redact`, `readSecret` (masked-TTY / piped-stdin secret input), shared CLI arg parsing (`--service` + key names) |
| `resolve.ts` | **Command** — exports `resolveKey(name, service?)` + a CLI wrapper (env → vault → error) |
| `store.ts` | **Command** — store one or more keys (env or stdin → vault) |
| `delete.ts` | Convenience command — remove one or more vault entries (not one of the two required deliverables) |
| `RESEARCH.md` | The macOS quirks found live + the Linux research + the native-module-vs-CLI tradeoff writeup |
