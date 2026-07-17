# pdum_aiui

Guidance for humans and agents working in this repo. See also [AGENTS.md](./AGENTS.md) for
version/release guardrails.

## What this project is

Tooling and knowledge for building scientific/technical visualization UIs with AI agents in a
tight iteration loop, keeping an **interactive Claude Code CLI session** (and its watchable
transcript) at the center. Three layers:

1. **Prompt lowering / intent compilation** — high-level multimodal prompts (voice, screenshots,
   DOM context, deictic references like "make *this* wider") are lowered, compiler-style, through
   inspectable stages into agent-optimal prompts — **interleaved text and images, not just text**
   (and, as hooks allow, dynamically shaped tool surfaces) — then injected into the *running*
   session via the custom channel (`aiui-claude-channel`: MCP server + on-disk registry + local
   web backend). Treated as an open research area — the pipeline should expose its intermediate
   representations.
2. **Intent tools** — frontends for that pipeline. The current one is the **intent client**
   (`aiui-intent-client`): one client, three hosts — the channel-served plain page at
   `/intent/` (drives real tabs over CDP, no extension) and the MV3 side panel (`dist-ext`,
   the ONE extension `aiui claude` auto-loads; warm `tabCapture` video), both over the same
   mode-engine core; `PARITY.md`/`BEHAVIOR.md` in that package are the decided contract. Its
   host-agnostic capture/transport runtime lives in `aiui-intent-runtime` (mic capture, frame
   sampler, selection watcher, channel wire). The historical surfaces — `aiui-dev-overlay` (the
   original web intent tool), `aiui-extension` (the first browser extension), and the
   `aiui-devtools-extension` panel — are DELETED (`docs/proposals/dev-overlay-retirement.md`;
   read them in git history). Lowering runs are traced to the project-local `.aiui-cache/`
   (gitignored); the trace debugger (`aiui-trace-ui`) is EMBEDDED in the intent panel and served
   at `/__aiui/debug` by its `./vite` plugin (what `aiui debug` runs, session-pinned).
   The channel itself serves **no HTML** — JSON/data routes only (`/debug/api/*`, `/health`);
   every page belongs to a frontend process. (Two sidecar exceptions: the paint sidecar's
   self-contained iPad client page at `/paint/` — an iPad has no frontend process — and the
   intent client's panel page under `/intent/`.)
3. **Frontend for agents** — principles/utilities/Claude skills for agent-written scientific UI:
   SolidJS 2.0 (beta), Observable-style async dataflow in mainstream syntax, code debuggable by
   the agent's future self (source locators, self-installed debug hooks, HMR-mindful,
   WebMCP-superset form annotations). This instrumentation is also what makes lowering precise
   (screenshot rectangle → components → source); it ships as its own module, separate from the
   intent tool.

Longer form: `docs/guide/` (motivation, prompt-lowering, frontend-for-agents). Pre-implementation
exploratory notes are retired to `archive/` — readable on GitHub, deliberately not part of the
docs site.

**Security posture (deliberate, documented — do not "fix" without being asked):** `aiui claude`
asks on the first interactive run whether to launch Claude Code with
`--dangerously-skip-permissions` and persists the answer (`claude.skipPermissions`;
non-interactive default: skip — see `packages/aiui/src/util/first-run.ts`), asks where the
channel's web server binds and persists that too (`channel.bind`: `loopback` keeps the
unauthenticated surface this-machine-only, non-interactive default; `host` binds `0.0.0.0` so a
LAN iPad can reach the always-on paint sidecar — and everything else on the port; the trusted-LAN
posture), loads
the custom channel via `--dangerously-load-development-channels`, and by default attaches the
Chrome DevTools MCP — by default **attached** to a shared, user-visible session browser (launched
eagerly with an unauthenticated loopback debug port, project-local profile under
`.aiui-cache/chrome/`; discovery via the profile's `DevToolsActivePort`; see
`packages/aiui/src/util/browser.ts`, `chrome.ts`, and `docs/guide/chrome.md` + `remote.md`). Off
under CI, `--aiui-no-chrome`, or `chrome.enabled: false`; `chrome.mode: "launch"` reverts to a
lazy MCP-private browser. Interactive launches prefer a managed **Chrome for Testing** install
(`~/.cache/aiui/chrome/`, offered/updated via prompts — `chrome.forTesting` in config;
`packages/aiui/src/util/cft.ts`). The docs
(`docs/guide/warning.md`, README) tell readers this repo is safer to read than to run — keep that
warning intact and accurate as behavior evolves.

## Workspace dependencies are editable (source-first) — the convention

Every package's dev manifest points at **source**, and the `dist/` mapping lives in
`publishConfig`, which `pnpm pack`/`pnpm publish` swap in at publish time:

```json
"exports": { ".": "./src/index.ts" },
"main": "./src/index.ts", "module": "./src/index.ts", "types": "./src/index.ts",
"publishConfig": {
  "access": "…",
  "main": "./dist/index.js", "module": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" }
  }
}
```

Every conditional-exports object in `publishConfig` must end with a `"default"` condition.
Without it, `require.resolve()` on the *installed* package throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` — and source-first dev masks this completely, because the dev
`exports` are bare strings that match any condition (this silently broke a sidecar subpath for
installed consumers before PR #1's review caught it).

So `workspace:^` deps behave like Python *editable installs*: edit a package, and every
in-workspace consumer (the demo's dev server, sibling tests, the tsx-run CLI) picks it up with
**no build step** — Vite, Vitest, and tsx all transpile TS from linked packages. The registry
artifact is unchanged. Rules that keep this working:

- **New packages get the shape from the skeleton** (`scripts/_skeleton/package.json.tmpl`) via
  `pnpm new-package`; keep dev fields and `publishConfig` overrides in sync when adding entry
  points (subpath exports go in *both*, like `aiui-trace-ui`'s `./vite`).
- **`bin` stays pointing at `dist/`** in both forms: bins are executed by plain `node` from
  installed tarballs; in-workspace CLI spawning already runs source via tsx
  (`packages/aiui/src/util/resolve-cli.ts`).
- **`pnpm test:packaging` is the guard for the published (dist) shape** — pack applies the
  `publishConfig` swap, so it tests what consumers install. Run it whenever packaging fields
  change. This matters doubly because source-first dev *masks* dist-only bugs: e.g.
  `import.meta.env.*` is substituted at build time, so `dist/` code can never read its consumer's
  env (the reason runtime configuration for prebuilt code travels through runtime channels —
  injected globals, plugin-generated modules). In-repo, source mode hides that class of bug; the
  packaging test and that design rule are what stand between you and them.
- **Never `optimizeDeps.include` a workspace package** in a Vite config: the dep-optimizer cache
  is keyed by the lockfile, not package contents, so a linked package would be served stale (see
  the comment in `packages/aiui-trace-ui/src/vite.ts`).

## In-repo demo apps — `pnpm new-demo <name>`

`demos/<slug>` holds demo apps that live in source control and consume the workspace. They are the
internal twin of `pnpm create @habemus-papadum/aiui`: **the same template**
(`packages/create-aiui/templates/app`), scaffolded by `scripts/new-demo.ts` with two substitutions —
`workspace:^` instead of a published range, and `../../bin/aiui` instead of the bare `aiui` bin
(which resolves to `dist/cli.js` and so does not exist in a fresh checkout). The script *imports*
create-aiui's `scaffoldApp` rather than copying the starter, so the two paths cannot drift; that is
why it is TypeScript run through tsx while its sibling `new-package.mjs` is plain node. Fix the
template once, both scaffolders get it.

```sh
pnpm new-demo spectra          # -> demos/spectra
pnpm install                   # link the new workspace member
pnpm -C demos/spectra claude   # terminal 1 — Claude Code + channel
pnpm -C demos/spectra dev      # terminal 2 — Vite + the intent tool
```

**The template's scenery is fenced.** Every piece of the starter's placeholder content sits
between `<aiui-scenery>` markers (whole scenery files carry `<aiui-scenery-file>` on line 1), so
"reset to a blank app" is a mechanical deletion documented in the template's `CLAUDE.md` — cheap
models can do it without reading the code. When editing the template, keep the invariant: fenced
code is only referenced from other fenced code, and the post-deletion tree must typecheck.

**There is exactly one starter template.** It used to be two: `aiui demo` scaffolded a throwaway
playground from `packages/aiui/templates/demo`, predating `create-aiui`. That command and its
template are gone — scaffolding is `create-aiui`'s job, and `pnpm new-demo` is its in-repo twin.

**`demos/gallery` is the one demo that was not scaffolded.** It is the reference notebooks
(morphogen · aztec · seismos), formerly `packages/aiui-demo`, moved into `demos/` because it is a
demo, not a published package. `pnpm demo` serves it. It is deliberately far richer than the
starter — workers, WebGL, DuckDB/Mosaic, the modal kit — and it is *not* a template: nothing
scaffolds from it.

**`demos/twins` is the composability worked example**: one reusable slice
(`demos/oscillator`, an internal never-published package) instantiated twice under
`scope("left")`/`scope("right")` and composed into a Lissajous figure — the living reference for
slices, scopes, and cross-package compiler identity (user guide, "Composing bigger apps").

**`demos/walkthrough` is the teaching demo**: the frontend playbook executed in order on 1-D
diffusion, with every layer left standing as its own page (`step1.html` → the finished index;
multi-entry Vite) and `WALKTHROUGH.md` narrating the diffs. Its steps must stay truthful — an
edit that leaks a later layer into an earlier step breaks its point (see its `CLAUDE.md`).

Three things follow from `demos/*` being a workspace glob in `pnpm-workspace.yaml`:

- **Demos are never published.** The template's `package.json` already carries `"private": true` —
  npm's own opt-out, which makes `pnpm -r publish` skip them. No `publishConfig` belongs in a demo.
  `scripts/packaging-test.mjs` reads `packages/` directly, so demos stay out of it for free.
- **Demos are in version lockstep.** `scripts/versioning.mjs` derives its package set from the
  `packages:` globs, so every demo carries the shared `X.Y.Z+dev` or `pnpm version:check` fails in
  CI. `new-demo` stamps it; the release pipeline rewrites it. Don't hand-edit it (see AGENTS.md).
- **Demos are typechecked by CI.** Each gets a `typecheck` script, so `pnpm -r typecheck` keeps them
  compiling against the packages they demo — a demo that stops building is a signal, not noise.

Unlike a scaffolded sandbox, a demo is not its own git repo and ships no `.gitignore` / `.envrc`
(the root `.gitignore` already covers `node_modules/`, `dist/`, `.aiui-cache/`), and it drops the
`"aiui": { "scaffold": true }` marker — which makes `create-aiui` classify it as `occupied` and
refuse to touch it. Exactly right.

## Publication convention

> **Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) —
> no long-lived `NPM_TOKEN`.** The release workflow authenticates to npm via its GitHub Actions
> identity (`habemus-papadum/pdum_aiui` · `release.yml`), which each package is configured to trust.
> There is no publish token stored anywhere. See [Trusted publishing](#trusted-publishing-two-steps)
> below for the one-time-per-package setup.
>
> **Assumption: this project has a paid npm account/org.** Publishing scoped packages
> (`@habemus-papadum/*`) as private (`--private`, `restricted` access) requires it. On the free tier,
> scoped packages can only be published as `--public`. (This is about visibility, independent of the
> token-vs-OIDC auth question above.)

### Every package declares a publication level at creation time

There is **no default**. `pnpm new-package <name>` requires exactly one of three flags, so the
publish/visibility decision is made deliberately when the package is born:

```sh
pnpm new-package foo --public       # published to npm, publicly visible
pnpm new-package foo --private       # published to npm, private (restricted access)
pnpm new-package foo --no-publish    # never published — internal/experimental only
```

Passing none, or more than one, is an error.

| Flag           | `package.json` result                     | On the npm registry                          |
| -------------- | ----------------------------------------- | -------------------------------------------- |
| `--public`     | `"publishConfig": { "access": "public" }` | Public package, anyone can install.          |
| `--private`    | `"publishConfig": { "access": "restricted" }` | Private package, only your npm org can install. |
| `--no-publish` | `"private": true` (no `publishConfig`)    | Never published — `pnpm -r publish` skips it. |

#### `--private` relies on the paid-account assumption

Publishing a **scoped** package as `restricted` needs the paid npm org noted at the top of this
section, or every `--private` package's publish will error. (Were this project ever on the free tier,
the only non-public option would be `--no-publish`: hold a package back and flip it to `--public`
when ready.)

### Trusted publishing (two steps)

npm requires a package to **exist** before you can attach a trusted publisher to it, so standing up
OIDC publishing for a name is two deliberately separate acts — both run **locally** with your own
npm login (they may prompt for 2FA), never from CI:

1. **Reserve** the name — `pnpm npm:reserve <slug>` publishes a tiny placeholder
   (`@habemus-papadum/<slug>@0.0.0-reserve.0`, under the `reserve` dist-tag, so it never becomes
   `latest`). Idempotent: names already on the registry are skipped. `pnpm new-package … --public`
   does this automatically (opt out with `--no-reserve`).
2. **Trust** this repo — `pnpm npm:trust <slug>` runs `npm trust github` to register
   `habemus-papadum/pdum_aiui` · `release.yml` as an allowed publisher (needs npm ≥ 11.15.0).

With no slug, both default to **all** publishable packages. After both steps, `release.yml` publishes
real versions over OIDC with zero stored secrets. `pnpm npm:list` shows what's publishable.

### Changing a package's level later

The level lives in `packages/<slug>/package.json`; edit it and the next release reflects the change.

- **`--no-publish` → publish it:** remove `"private": true`, add the `"files": ["dist"]` array
  and the full `publishConfig` — `access` plus the `dist/` overrides for
  `main`/`module`/`types`/`exports` (copy the shape from another package; see
  [Workspace dependencies are editable](#workspace-dependencies-are-editable-source-first--the-convention)).
  The next release publishes it.
- **`--private` → `--public` (open it up):** the registry does **not** flip visibility implicitly.
  Run `npm access set access=public @habemus-papadum/<slug>` (or toggle it on npmjs.com), and set
  `publishConfig.access` to `"public"` so future releases stay public. This direction is free.
- **`--public` → `--private` (lock it down):** requires a paid plan, and npm restricts making a
  public package private once it has dependents. Avoid unless you know the package has no consumers.

Note: `publishConfig.access` only sets the access level on a package's **first** publish. After
that, `npm access` is the source of truth for visibility — changing `publishConfig` alone won't
retroactively change an already-published package.

### Publishing is CI-only

Releasing real versions happens **exclusively** through `.github/workflows/release.yml` (a manual
`workflow_dispatch`), over OIDC. Never run `pnpm publish` / `npm publish` to cut a release locally.
The **only** local npm-write exceptions are the provisioning steps above (`pnpm npm:reserve` /
`pnpm npm:trust`) — one-time name reservation and trusted-publisher setup, not releases. See
[AGENTS.md](./AGENTS.md).
