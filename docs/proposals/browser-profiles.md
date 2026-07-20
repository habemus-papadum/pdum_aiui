# Browser profiles own the browser — and the project directory goes pristine

Status: **IMPLEMENTED** (2026-07-20, same day; open items answered inline below). Supersedes
[named-configs-and-setup-interview.md](./named-configs-and-setup-interview.md) entirely: the
profile model below absorbs what a "named configuration" would have bundled, and the
`server:aiui` warning fix that proposal grew from is **abandoned** (cosmetic banner, high effort
— not worth it). Compatibility stance: same as the registry work — no users yet, break freely,
no migration shims.

## The idea in one line

A browser **profile** (a user-data directory under the user cache) is the unit of browser
identity: the profile carries a marker file naming its browser, launches specify only a profile,
and the browser follows — nothing else gets to pick a binary. Config shrinks to almost nothing;
the project directory stops holding any aiui state at all.

## 1. Profiles live in the user cache

```
~/.cache/aiui/userdata/<name>/          # the Chrome user-data dir, name defaults to "default"
~/.cache/aiui/userdata/<name>/aiui-profile.json   # the marker (below)
```

- Replaces the project-local `.aiui-cache/chrome/<variant>/<name>` dirs AND `aiui remote`'s
  host-keyed `~/.cache/aiui/browser-profiles/<host>` — one namespace, three uses.
- **The profile named `default` is the default.** There is no default-profile config key;
  `--profile <name>` per invocation is the override.
- Names are validated like client names elsewhere (`[a-z0-9-]`, lowercase).

### The marker file — the profile picks the browser

```jsonc
// ~/.cache/aiui/userdata/<name>/aiui-profile.json
{
  "schema": 1,
  // Exactly one of the three, mirroring today's config trichotomy:
  "browser": { "managed": "chromium" | "chrome-for-testing" }
           | { "channel": "stable" | ... }        // branded Chrome by release channel
           | { "executablePath": "/abs/path" },
  "createdAt": "2026-07-20T..."
}
```

- Written when the profile is **created**; **immutable afterwards**. Distinct browser builds must
  never share a profile (Chrome errors or silently migrates state — the reason the old
  per-variant partitioning existed). "Change this profile's browser" is refused with "create a
  new profile". This inverts the old derivation (config → variant → dir) into dir → browser, and
  deletes the re-derivation footgun (`resolveChromeSettings`'s "patch the binary but don't
  re-derive the dir" dance) outright.
- Launch resolution becomes: profile name → user-data dir → marker → binary (sync the managed
  install if the marker says managed). No independent browser selection input exists at launch.
- A **non-empty dir with no marker** is foreign: refuse to guess a binary against unknown profile
  data; offer an adoption interview (`aiui profile adopt`?) or a new profile.
- Precedent for aiui-owned files inside a user-data dir: we already plant
  `NativeMessagingHosts/` and the extension-autoload-hint marker there. Chrome ignores unknowns.

### Shared-browser semantics (deliberate)

Concurrent `aiui claude` sessions in different projects attach to the **same** browser (the
`default` profile) — one window, multiple channels co-driving, which the architecture already
supports (CDP driver roster; the intent client's picker prefers real-session drivers and handles
many channels). Logins persist across projects. Isolation, when wanted, is a *named profile*, not
a per-project mechanism.

**`aiui remote` is not special.** It joins the `default` profile like everything else (its
browser is local; the remote box only sees the reverse-forwarded debug port). `--profile` works
there exactly as anywhere. `remoteProfileDir` / the `browser-profiles` namespace are deleted.

## 2. The `aiui profile` command

Its own noun — `aiui chrome` manages the shared managed **binaries**; profiles **reference**
them:

```
aiui profile list                 # name · browser · size · last used · running?
aiui profile new <name> [--chromium | --cft | --channel <c> | --executable <path>]
aiui profile rm <name>            # refuses while its browser is running
```

- First run with no `default` profile → the **profile-creation interview** (which browser —
  Chromium default, per the reCAPTCHA rationale) + the existing bind question. This is the
  surviving miniature of the retired setup-interview idea.
- Flags, present everywhere a profile is natural: plain `--profile` on `open`, `remote`, and
  `debug`; on `aiui claude` it is **`--aiui-profile`** (renaming `--aiui-chrome-profile`).
  `--data-dir` (`--aiui-chrome-data-dir`) stays as the escape hatch; the marker is read from
  whatever dir is given.

## 3. Config end state — one flat user-level file

The project config layer is **deleted** (`.aiui-cache/config.json`, the merge, and
`aiui config set --project`). What remains, all user-level:

| Key | Why it survives |
| --- | --- |
| `claude.args` | launcher argv (incl. the opt-in DSP flag) — machine/user fact |
| `claude.enterNudge` | first-run choice, as today |
| `channel.bind` | loopback/host posture — user fact (per-project bind loss: accepted) |
| `chrome.manage` | managed-BINARY update cadence (prompt/auto/off) — machine fact, not profile |
| `chrome.headless` | untouched by this proposal, with its flags, exactly as today |

Deleted from config (each absorbed or demoted): `chrome.enabled` (**flag-only** now —
`--aiui-no-chrome` / the sidecar suppress flag; `decideBrowserAction`'s config rung goes),
`chrome.mode` (attach is the model; the non-interactive launch fallback stays internal
behavior), `chrome.browserUrl` (the `--aiui-browser-url` flag remains — it's how `aiui remote`'s
printed invocation works — but no durable key), `chrome.debugPort`, `chrome.profile`,
`chrome.dataDir`, `chrome.executablePath`, `chrome.channel`, `chrome.managed`,
`chrome.forTesting` (already deprecated). Browser identity questions all have one answer: the
profile's marker.

## 4. Traces move too — `.aiui-cache/` is retired

Project-scoped runtime state moves to the user cache, keyed by the project's **full path**:

```
~/.cache/aiui/traces/<slug>-<hash8>/   # lowering traces (was .aiui-cache/traces)
~/.cache/aiui/logs/<slug>-<hash8>/     # channel logs   (was .aiui-cache/logs)
```

- `<slug>` = a readable tail of the project path (e.g. `pdum-aiui`), `<hash8>` = a short hash of
  the full absolute path — readable AND collision-free (`~/a/app` vs `~/b/app`).
- Consequences: the project directory is **pristine** (scaffolds need no `.aiui-cache` gitignore
  entry), `aiui clean` collapses to one root, and `projectCacheDir` becomes a user-cache path
  function. The trace debugger and channel log plumbing re-point; the registry package is
  untouched (it never used the project cache).

## What this deletes from the codebase (flavor, not exhaustive)

Variant partitioning + `chromeVariant` path logic; `remoteProfileDir`; the config merge +
project-file machinery; ~10 chrome config keys and their TUI/docs rows; the per-project
first-run re-asking that project-local profiles caused.

## Open items (small)

1. Marker filename (`aiui-profile.json`) and whether `rm`/`list` need `--json`.
   file name is fine, no json mode
2. Profile-name validation details; what `aiui profile adopt` does exactly.
   you decide
3. The trace-slug encoding function's exact shape (shared with logs).
   you decide
4. Sequencing vs. the docs rewrite — this lands first; docs describe the end state once.
   Ignore docs completely -- they will be rewritten two weeks from now form scratch