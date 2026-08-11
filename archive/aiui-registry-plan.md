# `aiui-registry` — implementation plan

Status: **ACTIVE** (2026-07-20). Executes [aiui-registry.md](./aiui-registry.md) (final). Six
milestones, delivered one at a time with review between each; sub-steps are deliberately coarse —
details get filled in per-milestone when it starts. Strategy per the proposal: **build the
standalone package first, existing codebase untouched**, duplicating code as needed and marking
every future fixup site with a `TODO(aiui-registry)` comment; then migrate writers, then readers,
then UI/docs, then consolidate the CLI surface.

## M1 — the standalone package (`bootstrap/aiui-registry/`)

Everything that can exist without touching the workspace. The repo's only change is the new
directory (plus `TODO(aiui-registry)` markers dropped where duplicated code will later be
deleted).

- Scaffold outside the workspace globs: own `package.json` (own semver, 0.1.0), tsconfig,
  Vitest, build. Not a workspace member; none of the release tooling sees it.
- Implement, with unit tests as we go:
  - **Types** — entry schema v2, enriched object (`resolvedName` top-level, nested `session?`),
    listing/response shapes, protocol constant.
  - **Write API** — atomic temp+rename `registerServer`, removal.
  - **Liveness** — pid probe + OS start-time cross-check (macOS `ps`, Linux `/proc`).
  - **Read/client API** — scan + prune + enrichment; the 4 s shared agents cache
    (atomic-rename writes); per-client lock files (30 s max age); claude-binary resolution +
    the loud-but-partial `agents.status` failure shape.
  - **Host `main()`** — NM framing (ported from `native-host.ts`) over the read API, protocol
    version on every response, `AIUI_CLAUDE_BIN` from env.
- Bun-compile script for the four targets (darwin-arm64/x64, linux-x64/arm64).
- **Testing (resolves the open testing question):** the package gets its **own CI step** — a
  dedicated job/workflow that installs, tests, compiles the linux-x64 binary, and runs a
  **compiled-host smoke test**: spawn the binary against a temp registry dir with fabricated
  entries, drive framed `listChannels`/`ping` over stdio, assert responses (including the
  claude-missing status path). This is the piece that keeps the compiled artifact honest in CI.

**Exit:** package builds, tests green in its own CI step, host binary answers framed requests
locally.

## M2 — publish

- Reserve the npm names (main package + four platform packages, all `--public`).
- Manual publish script (in the package): build all binaries, assemble the platform packages
  (`os`/`cpu`, `optionalDependencies` wiring), publish with 2FA. No OIDC/trust setup.
- Record the carve-outs: AGENTS.md publishing-rule exception; a short section in CLAUDE.md
  (`bootstrap/` exists, is special, and why).
- Publish `0.1.x`; verify a clean `npm install` on a scratch dir resolves the right platform
  binary.

**Exit:** `@habemus-papadum/aiui-registry@0.1.x` installable from npm.

## M3 — writers

The workspace starts consuming the package (pinned npm range, single repo-wide pin; temporary
`pnpm.overrides` → `bootstrap/aiui-registry` is the sanctioned dev loop).

- `aiui-claude-channel`: `registerServer` → package (schema-v2 entries; `browserUrl` plumbed
  from `LaunchInfo.chromeDevtools`; `kind` replaces `debug`; `assignedName` replaces `name`).
- **Hoist the browser find-or-start pipeline** (hard prerequisite for `remote`): the
  resolution + find-or-start orchestration moves out of `commands/browser.ts` into
  `packages/aiui`'s util modules as one command-agnostic pipeline (settings → find-or-start →
  session with port/browserUrl); `claude` and `remote` become thin callers (`open` follows in
  M6). Never duplicated per command; stays inside `packages/aiui` (no chrome package — see
  proposal §5).
- **`aiui remote`** in `aiui`: find-or-start local browser (first-run prompts included,
  deliberately) + one ssh invocation carrying the reverse browser-debug forward and the local
  channel/debug forwards + registry entry + foreground lifecycle. Retire `aiui browser
  --tunnel` (`runTunnel` and its flags).
- Testing: unit-test the pure parts (ssh argv construction — the existing `runTunnel` tests are
  the model — and entry shapes); **one manual end-to-end pass** of `aiui remote`, then move on
  (accepted).

**Exit:** all registry writes are v2 via the package; remote registration works; old tunnel
command gone.

## M4 — readers + host swap

- `aiui` CLI: selectors, `debug`, `pencil-url`, `clean` → the enriched read API;
  `native-host.ts` subcommand retired; `extension.ts` installers rewritten to the §9 flow
  (version-suffixed binary copy into the user cache, env-baking wrapper rewritten every launch,
  profile-scoped manifest; global installer keeps its scoping).
- `aiui-claude-channel`: `/debug/api/channels` returns enriched objects; `registry.ts` /
  `agents.ts` / `list.ts` collapse onto the package (self-info's 10 s cache folds into the
  shared 4 s cache).
- `aiui-vscode`: consume the package; delete its private `agents.ts` and `channels.ts` read
  side.
- `aiui-util`: delete the registry read side (`cacheDir` duplication in both packages is
  accepted and stays).
- `clean`: minimal awareness of the new artifacts the moment they exist — version-suffixed host
  binaries, the agents cache + lock files, the shared wrapper. (Full command rework is M6; this
  just keeps clean's "reset toward fresh install" promise true mid-migration.)
- Sweep the `TODO(aiui-registry)` markers from M1 — each is either resolved here or explicitly
  deferred to M5/M6.

**Exit:** one registry implementation in the tree; extension discovers channels through the
compiled host end-to-end (manual check in the session browser).

## M5 — UI surfaces + docs

- Intent client: typed enriched responses, protocol-version floor check, visible
  claude-missing / stale-host warning states; labels → `resolvedName` (console, trace UI,
  selectors — the accepted UI-regression seams get a look here).
- Docs: `remote.md` rewritten around `aiui remote`; `chrome.md`, `warning.md`,
  `browser-extension.md` touched where behavior changed; `native-host-flow.md` gets its
  superseded-by header note; CLAUDE.md updated where it describes the old flow.
- Remaining `TODO(aiui-registry)` markers resolved except those explicitly deferred to M6;
  full repo gates (biome, `pnpm -r typecheck`, tests, `pnpm test:packaging`) green.

**Exit:** registry proposal fully landed; docs describe only what the code does.

## M6 — CLI surface consolidation

Pure subtraction with a docs-heavy blast radius; deliberately last, depends on everything
before it being stable.

- Retire commands: **`vite`** (blast radius: the create-aiui template's `"dev": "aiui vite
  dev"` script, every `demos/*` twin, getting-started docs — the template is the public
  first-run surface, handle with care; the replacement in templates/demos is plain
  `"dev": "vite"` — decided 2026-07-20), **`env`** (development.md + prerequisites), **`pencil`**
  (subsumed into `debug`/console), **`browser`** (the rump find-or-start already hoisted in
  M3).
- **`open` becomes the human-facing browser entry**: grows find-or-start semantics via the M3
  pipeline.
- **`clean` full rework**: command surface + coverage audit against everything this project
  added or moved.
- Docs/template sweep for the removed commands; `chrome` and `extension` stay as-is.
- Note in passing, not work: a separate chrome package stays deferred (proposal §5); the
  **named-profiles / power-user bundling review is explicitly out of scope** — it is the
  existing `named-configs-and-setup-interview.md` proposal's job, to be revived **after** this
  milestone with `aiui remote` added to its consumer list (a named "remote dev-box" bundle:
  host + ports + browser identity).

**Exit:** the command list is `claude · debug · chrome · remote · extension · clean · open ·
config · mcp`; templates, demos, and docs reference nothing else.

## Standing conventions for all milestones

- Existing code is never edited before its milestone; cross-milestone coupling is expressed
  only as `TODO(aiui-registry)` markers.
- Registry-package changes needed mid-migration follow: edit in `bootstrap/`, test, publish a
  patch, bump the pin (override covers the gap).
- Real exit-code gates before any push (no piping through `tail`).
