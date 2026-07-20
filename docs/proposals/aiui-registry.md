# The channel registry, redesigned — semantics + the `aiui-registry` package

Status: **FINAL** (2026-07-20 — open questions resolved; see [Resolved decisions](#resolved-decisions)).
No code yet; the implementation plan is [aiui-registry-plan.md](./aiui-registry-plan.md).

**Compatibility stance:** there are no external users of this toolkit yet. Decisions here spend
effort on **future protection** (schema and protocol version fields) and **zero** effort on
backward compatibility with the current on-disk format — we break it freely, once.

Two halves, orthogonal but designed together:
**Part I** re-specifies the on-disk channel registry (write discipline, liveness, entry schema,
the enrichment convention, remote channels). **Part II** moves the registry implementation — and
the native-messaging host built on it — into a new package, `aiui-registry`, that deliberately
inverts the repo's source-first convention: it is npm-pinned, independently versioned, manually
published, and ships a compiled host binary. The baseline this supersedes is recorded in
[native-host-flow.md](./native-host-flow.md) (descriptive, as-of-today).

The connecting idea: once a compiled NM host, channel servers from different checkouts, the VS
Code extension, and an `npx`-run `aiui` all cooperate through shared on-disk state, the registry
entry format, the agents cache, and the lock protocol become a **wire protocol between
independently-installed versions**. Part I defines that protocol; Part II pins every participant
to one implementation of it.

---

## Part I — registry semantics

### 1. Write discipline: write-once, atomic

Entries stay **write-once** (the current invariant: written at `registerServer`, then only ever
deleted). What changes: the write becomes **atomic** — serialize to `<pid>.json.tmp` in the same
directory, then `rename(2)` over the final name. Readers see either nothing or a complete entry,
never a tear.

- **No locks on the registry itself** — single-writer-per-file (the filename *is* the writer's
  pid) plus write-once plus atomic rename means there is nothing to lock. This is deliberate;
  do not add locking here.
- **Torn/corrupt leftovers are accepted litter.** A crash between open and rename leaves a
  `.tmp` file; a pre-atomic writer's crash leaves a truncated `.json`. Both are skipped by
  readers (`readEntry` → null) and deliberately **not** cleaned up. Known, ignored.

### 2. Liveness: pid probe + start-time cross-check

Today liveness is `kill(pid, 0)` (with `EPERM` counted alive), which lies when the OS recycles
a hard-killed server's pid onto an unrelated process — a phantom channel with a dead port that
never prunes. Fix: cross-check the entry's `startedAt` against the **OS's start time for the
current holder of that pid** (`/proc/<pid>/stat` field 22 on Linux; `ps -p <pid> -o lstart=` on
macOS).

Invariant: the real server started *before* its registration was written, so
`osStartTime(pid) ≤ startedAt + slack` (a few seconds of slack for clock granularity). A holder
that started **after** `startedAt` is a recycled pid → the entry is stale → prune it. The check
runs wherever `isProcessAlive` runs today, and works unchanged for remote entries because their
pid is the *local* tunnel-owner process (§5).

### 3. Entry schema v2

```jsonc
{
  "schema": 2,                    // required; readers skip entries without it
  "tag": "…",                     // unchanged: uuid or launcher-chosen
  "pid": 12345,                   // unchanged: the registering process
  "ppid": 12344,                  // unchanged: the owning Claude Code session (local channels)
  "port": 51234,                  // unchanged — but for kind:"remote" this is the LOCAL proxy port
  "cwd": "/abs/path",             // unchanged
  "startedAt": "2026-…",          // unchanged (now also feeds the liveness cross-check, §2)
  "kind": "channel",              // "channel" | "debug" | "remote"  (replaces the debug boolean)
  "assignedName": "…",            // optional; replaces `name` — given at registration
                                  // (debug servers' --name, remote entries' --name)
  "browserUrl": "http://127.0.0.1:9222",  // optional; the Chrome DevTools endpoint associated
                                  // with this session, captured at registration
  "host": "dev-box"               // kind:"remote" only: display metadata, NOT addressing
}
```

**Naming is a resolved triple.** The raw `name` field is **replaced** (accepted UI regressions;
we know where the seams are):

- `assignedName` — stored in the entry, set at registration. Typical for debug servers and
  remote entries; real local channels usually have none.
- `sessionName` — never stored; the live `claude agents --json` join by `ppid` (§4).
- `resolvedName` — computed at read time: `assignedName ?? sessionName ?? fallback`
  (fallback: `host` for remotes, else the tag/pid the selectors show today).

No migration shims: readers recognize only `schema: 2` and skip anything else exactly like a
malformed file (a stale v1 entry from an old build dies with its process anyway). The `schema`
field exists for *future* protection, not for migrating a past that has no users.

**`browserUrl` is captured at registration and can drift.** `aiui claude` already knows the
DevTools endpoint at channel-spawn time (`LaunchInfo.chromeDevtools.browserUrl`, built in
`claude.ts` and passed via `--launch-info`); recording it in the entry is plumbing an
already-present value. If the session browser restarts on a new port mid-session, the entry is
stale — **documented limitation**, consistent with write-once. Locally, the profile's
`DevToolsActivePort` file remains the live source of truth for anyone who must double-check.

### 4. The enrichment convention: every consumer surface returns the enriched object

Today only the CLI selector and the self-info endpoint do the `ppid → claude agents` join; the
native host, `/debug/api/channels`, and the VS Code listing return raw entries — which is
exactly why a renamed session never updates in those UIs. New rule: **every listing surface
returns the fully-enriched object** — never a raw entry.

**Enriched shape (decided — least churn):** entry fields stay top-level, the computed
`resolvedName` joins them top-level (it is the one field every consumer displays), and the live
join nests under `session?: { name, status, sessionId, … }` — the shape `enrichServers()`
already produces today, so existing consumers keep their access patterns.

**The join is cached across processes.** `claude agents --json --all` costs a subprocess (5 s
timeout); `sendNativeMessage` spawns one NM host process *per request*, so in-process caching is
worthless there. Design:

- **One shared cache file** (e.g. `~/.cache/aiui/agents-cache.json`): the parsed agents list +
  `fetchedAt` + the claude-binary status. Written by **atomic temp+rename** — any writer's fresh
  result is equally valid, last-writer-wins is correct, no lock needed for safety.
- **TTL: 4 s** — long enough that a cold NM host usually finds a warm cache, short enough that
  a session rename surfaces promptly.
- **Per-client lock files** (`native-host.lock`, `vscode.lock`, `channel.lock`, …) guard only
  the *decision to refresh a stale cache*. What a lock buys is **spawn dedup within one client
  class**; it is never needed for write correctness (rename handles that). Per-class locks
  bound a stale lock's blast radius to one client class — worst case, one concurrent
  `claude agents` spawn per class. **Max lock age 30 s**, then broken. A stale lock can delay
  one class's refresh; it can never block a read (readers use the stale cache meanwhile).
- **Who runs `claude agents`: every client, including the NM host.** The host is spawned by
  Chrome with a minimal environment (no user PATH), so it cannot find `claude` by name — the
  wrapper script bakes the resolved absolute path (Part II §8). Other clients resolve it from
  their own PATH as today.
- **Failure is loud but partial.** If the claude binary is missing/broken, listing responses
  still carry the raw channels, plus an explicit status the UI must surface:
  `agents: { status: "ok" | "claude-missing" | "error", claudePath?, fetchedAt }`. The
  extension shows a visible warning ("aiui can't find Claude Code at <path> — session names
  unavailable; re-run aiui to repair"), never a silent fallback to unnamed channels. Discovery
  itself must not fail because naming did.

### 5. Remote channels

A registrable proxy to a channel whose Claude Code runs on another machine. Two-step flow; only
step 1 is this work:

1. **Local: `aiui remote <host> --port <local> [--name <n>] [--browser-port <p>]`** — a
   foreground command that **subsumes and retires `aiui browser --tunnel`**: it finds **or
   starts** the local session browser, opens the ssh connection carrying *both* directions — the
   reverse forward handing the local browser's debug port to the remote box (what `--tunnel`
   did) and the local forward(s) proxying the remote channel's web backend (and optionally its
   Chrome debug endpoint) — and writes a `kind: "remote"` registry entry: `pid` = **its own
   pid**, `port` = the local proxy port, `assignedName` from `--name` (as debug servers do),
   `browserUrl` = the local debug proxy if given, `host` = display metadata. It stays in the
   foreground; on exit (Ctrl-C, kill) the entry is removed, and a hard kill is caught by normal
   pruning, since liveness probes the tunnel-owner's pid.

   The local debug endpoint is resolved by the **same shared pipeline `aiui claude` uses**
   (config defaults < `--profile` < explicit `--data-dir`/ports; `DevToolsActivePort` for a
   running browser) — hoisted out of `commands/browser.ts` into `packages/aiui`'s util modules
   as a command-agnostic find-or-start pipeline, never duplicated per command. Find-or-start
   means the first-run interactive prompts (managed-browser download, bind question) apply on
   `aiui remote`'s first run too — deliberate, not inherited. This Chrome-resolution logic stays
   **inside `packages/aiui`**: the registry only stores/transports `browserUrl`; `aiui`
   produces it. Extracting a separate chrome package is **deferred until a second *package*
   consumer exists** (today there is none).
2. **Remote: an invocation the user runs on the remote host** to start `aiui claude` wired
   through the tunnel. Printed by step 1, out of scope here (parallel work).

Why this is nearly free: the tunnel-owner-as-registrar reuses the entire lifecycle — pid-keyed
file, `kill(pid,0)` + start-time liveness, prune-on-death — with zero new machinery. And because
`port` is a **local** proxy port, every consumer that dials `http://127.0.0.1:<port>` (VS Code's
`fetchPeers`, the intent client, the console) works against a remote channel unmodified. The
`ppid → claude agents` join structurally cannot work for remotes (the remote Claude is not in
the local agents list); the naming triple handles this with no special case —
`resolvedName = assignedName ?? host`.

---

## Part II — the `aiui-registry` package

### 6. Why a separate, npm-pinned package

The package exists to make the Part I protocol **single-sourced across installations**. It
deliberately inverts three repo conventions:

| Convention (everything else) | `aiui-registry` |
| --- | --- |
| `workspace:^`, runs from source | consumed **via npm** at a pinned version — the one place we don't run on source |
| version lockstep (`versioning.mjs`) | **own semver**, evolves on its own cadence |
| CI-only publishing (`release.yml`, OIDC) | **manually published** (local `npm publish`, 2FA) — an explicit carve-out to record in AGENTS.md |

It lives in the monorepo (shared review, shared tooling knowledge) but **outside the workspace
globs** — and outside `packages/` entirely, at **`bootstrap/aiui-registry/`** (`bootstrap/`
holds things that need special treatment), because `scripts/packaging-test.mjs` reads
`packages/` directly and `versioning.mjs` derives its set from the globs; a location neither
touches means zero special-casing in release tooling.

Rejected alternative — keep the library in-workspace, compile only the host binary from it: the
binary would embed a *snapshot* of the cache/lock/entry code while workspace consumers run newer
source, and the on-disk formats drift between cooperating processes. Pinning everyone to the
same published version is the point.

### 7. Contents

One package, four consumable surfaces:

1. **Types** — entry schema v2, the enriched channel object, the listing/response shapes.
   Consumed by everything, including the intent client (which never touches the filesystem: it
   makes a REST/NM call, gets JSON, and wraps it in these types).
2. **Write API** — `registerServer` (atomic, v2 schema) + removal. Consumed by the channel
   server (`aiui-claude-channel`) and the remote-registrar command.
3. **Read/client API** — enriched listing (registry scan + liveness w/ start-time check +
   cached agents join + name resolution), the shared-cache/lock implementation, claude-binary
   resolution. Consumed by the channel's `/debug/api/channels` + selectors, the VS Code
   extension (whose private `agents.ts` copy is deleted), the `aiui` CLI, and the host binary.
4. **The host `main()`** — the NM stdio loop (framing as today) over the read API.

`aiui-util` keeps `cacheDir` and the rest; its registry read side (`RegistryEntry`, `readEntry`,
`isProcessAlive`, `registryDir`) **moves here**. `aiui`'s `native-host.ts` subcommand is retired
in favor of the compiled host; `extension.ts`'s installers are rewritten to install the new
artifacts (§9) with the same two-scope split (profile-scoped automatic, global explicit).

### 8. The compiled host

- **Bun-compiled** (`bun build --compile`), one binary per target: `darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`. **Windows out**, matching today's installer.
  Bun cross-compiles all targets from one machine, so the manual publish script builds the
  full set locally.
- **Per-platform distribution** via the esbuild/biome pattern: one platform package per target
  (`@habemus-papadum/aiui-registry-host-<platform>-<arch>`), each with `os`/`cpu` fields,
  all listed as `optionalDependencies` of `aiui-registry` — the installer's package manager
  fetches only the matching binary. (All `--public`; new names need `pnpm npm:reserve`-style
  reservation, but no OIDC trust — publishing is manual.)
- **Protocol version on every response** (not just `cmd:"version"`): every frame the host
  returns carries `protocol: <n>`. The extension checks a minimum and shows an actionable
  "update the aiui native host" state on mismatch instead of misbehaving. The protocol integer
  is distinct from the package semver: it versions the wire + on-disk formats, and bumps only
  when they change.

### 9. Installation flow

Performed by `aiui` (any invocation that loads the intent extension — including the `npx` /
first-demo flow), idempotent on every launch:

1. **Copy the platform binary into the user cache under a version-suffixed name**
   (`~/.cache/aiui/native-host/aiui-registry-host-<version>`). Never overwrite a fixed path — a
   running `connectNative` host may be executing it (ETXTBSY / corrupted image); version-suffix
   + repoint is the safe swap. Old versions are left behind (best-effort GC later, not now).
2. **Write the wrapper script** (same location-class as today): a two-line shim that bakes the
   machine-specific facts as env and `exec`s the binary —
   `AIUI_CLAUDE_BIN=/abs/path/to/claude exec /abs/…/aiui-registry-host-<version>`. The claude
   path is resolved by the *installer* (which has the user's PATH); the binary itself stays
   generic. Re-resolved and rewritten via `writeIfChanged` on **every launch** — a moved Claude
   install self-heals on the next `aiui claude`, no reinstall step.
3. **Write the NM manifest** pointing at the wrapper, into the launched browser's
   **profile** (`<user-data-dir>/NativeMessagingHosts/`) — the demo/default path, same scoping
   as today's `installProfileNativeHost`: project-local, no system browser touched. The
   explicit global installer (`aiui extension install-native-host`) keeps its current scoping
   (user-level dirs for Chrome/Chromium/Edge) but points at the same shared wrapper/binary.

Multi-install coexistence: N checkouts/installs all write the *same* shared wrapper + cache
path. Writes are idempotent when versions match; when they differ, last-launched wins with its
bundled registry version — safe, because every participant speaks the pinned protocol and the
version rides on every response.

### 10. Versioning, publishing, consumption

- **Own semver**, starting 0.x; the protocol integer (§8) is separate and bumps rarely.
- **Manual publish, local, 2FA** — the AGENTS.md publishing rule gets an explicit exception
  clause naming this package (alongside the existing `npm:reserve`/`npm:trust` carve-outs).
- **Workspace consumption via a single pinned range** — one entry (pnpm catalog or a root-level
  convention) so no two workspace packages ever compile against different versions of the
  types/protocol.
- **Dev loop**: iterating on registry internals happens against the local directory via a
  temporary `pnpm.overrides` entry, dropped once the change is published. This friction is the
  accepted price of npm-pinning; the convention is named here so it doesn't get re-litigated
  mid-development.

---

## What this retires / changes elsewhere

- `packages/aiui/src/commands/native-host.ts` — retired (host `main()` moves to the package,
  shipped compiled).
- `packages/aiui/src/commands/extension.ts` — installers rewritten per §9; scoping split kept.
- `packages/aiui-vscode/src/agents.ts` — deleted; the extension consumes the enriched read API.
- `packages/aiui-util` registry read side — moves to `aiui-registry`.
- `aiui-claude-channel`: `registry.ts`/`agents.ts`/`list.ts` collapse onto the package;
  `/debug/api/channels` returns enriched objects (the existing 10 s self-info cache folds into
  the shared cache).
- `select.ts` / VS Code `channelLabel` — switch to `resolvedName` (the known UI seams for the
  naming-triple regression).
- `aiui browser --tunnel` (the `runTunnel` path in `browser.ts`) — retired, subsumed by
  `aiui remote` (§5); `remote.md` rewritten around the new command.
- [native-host-flow.md](./native-host-flow.md) — gets a header note pointing here once this
  lands.

## Accepted limitations (deliberate, documented)

- Torn/orphaned registry files and `.tmp` litter are never cleaned up.
- `browserUrl` in an entry can go stale if the browser restarts mid-session.
- Naming-triple migration may cause minor UI regressions in selectors/labels.
- Per-class lock files allow one concurrent `claude agents` spawn per client class.
- Windows unsupported, as today.

## Resolved decisions

Formerly the open questions; all settled 2026-07-20 and folded into the body above.

1. **Agents-cache TTL: 4 s** (§4).
2. **Remote command**: `aiui remote <host> --port … [--name …] [--browser-port …]`; it creates
   the tunnel itself and **subsumes/retires `aiui browser --tunnel`** (§5).
3. **Enriched shape**: entry fields + `resolvedName` top-level, live join nested under
   `session?` — matches today's `enrichServers()` output, least churn (§4).
4. **Tunnel creation**: the remote command owns it; no register-only mode (§5).
5. **Binary GC: deferred** — old version-suffixed binaries accumulate for now.
6. **Location: `bootstrap/aiui-registry/`** (§6).
7. **Compatibility: none** — no users yet; readers recognize only `schema: 2`, no migration
   shims anywhere (§3, header note).
