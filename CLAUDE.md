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
   mode-engine core; `BEHAVIOR.md` in that package is the decided contract (the parity ledger is retired — git history keeps it). Its
   host-agnostic capture/transport runtime lives in `aiui-intent-runtime` (mic capture, frame
   sampler, selection watcher, channel wire). The historical surfaces — `aiui-dev-overlay` (the
   original web intent tool), `aiui-extension` (the first browser extension), and the
   `aiui-devtools-extension` panel — are DELETED (the dev-overlay-retirement notes and the
   code are both in git history). Lowering runs are traced to the project's user-level cache
   (`~/.cache/aiui/projects/<slug>-<hash8>/traces/`, keyed by the project's absolute path —
   the browser-profiles redesign moved the whole per-project cache out of the project tree);
   the trace debugger (`aiui-trace-ui`) is EMBEDDED in the intent panel and also
   reachable at `/__aiui/debug` — a client route of the **console** (`aiui-console`), the channel's
   own dashboard served at its root (`/` redirects there). `aiui dashboard` opens that console in the
   session browser. The channel serves **no HTML of its own** — JSON/data routes only
   (`/debug/api/*`, `/health`); every page belongs to a sidecar frontend. (The page-serving
   sidecars: the console at `/` + `/__aiui`; the intent client's panel under `/intent/`; the
   pencil client at `/pencil/`; the remote bar at `/bar/`.)
3. **Frontend for agents** — principles/utilities/Claude skills for agent-written scientific UI:
   SolidJS 2.0 (beta), Observable-style async dataflow in mainstream syntax, code debuggable by
   the agent's future self (source locators, self-installed debug hooks, HMR-mindful,
   WebMCP-superset form annotations). This instrumentation is also what makes lowering precise
   (screenshot rectangle → components → source); it ships as its own module, separate from the
   intent tool.

Longer form: `docs/guide/` (motivation, prompt-lowering, frontend-for-agents). Pre-implementation
exploratory notes and finished proposals are retired outright — git history is the archive
(the `archive/` directory itself was deleted in the 2026-08 docs slimdown).

**Security posture (deliberate, documented — do not "fix" without being asked):** `aiui claude`
passes `--dangerously-skip-permissions` only when it is present in the general `claude.args` list
(argv forwarded to `claude` on every launch); it is **opt-in and off by default** — add it with
`aiui config yolo` (the one explicit opt-in, which ALSO sets `channel.bind: "host"` after a
stated-consequences confirm), remove it with `aiui config unset claude.args` (see
`packages/aiui/src/commands/config.ts`; the retired `claude.skipPermissions` boolean is tolerated
and dropped for old configs). The channel's web bind is `channel.bind`: `loopback` keeps the
unauthenticated surface this-machine-only (the default — deliberately never asked at first run);
`host` binds `0.0.0.0` so a LAN iPad can reach the pencil sidecar — and everything else on the
port; the trusted-LAN posture. `aiui claude` loads
the custom channel via `--dangerously-load-development-channels`, resolves the vendor API keys
(OpenAI/Gemini/ElevenLabs) at channel boot — env-first in a source checkout (`.env`/direnv),
**OS-vault-only when installed** (macOS keychain / Secret Service; `aiui keys` manages the
secrets plus the per-provider `keys.*` decisions in the user config; `aiui-util`'s
vault/vendor-keys modules, promoted from `exploration/os-vault`), so installed users' keys never
enter the agent's environment — and by default attaches the Chrome DevTools
MCP — by default **attached** to a shared, user-visible session browser (launched
eagerly with an unauthenticated loopback debug port; browser identity belongs to **profiles**
under `~/.cache/aiui/userdata/<name>/`, not config; discovery via the profile's
`DevToolsActivePort`; see `packages/aiui/src/util/session-browser.ts`, `chrome.ts`, and
`packages/aiui/docs/chrome.md` + `remote.md`). Off
under CI or `--aiui-no-session-browser` (the old `chrome.enabled`/`chrome.mode` keys are
retired). Interactive launches prefer a managed browser install — **Chromium by default**
(`~/.cache/aiui/chromium/`; Chrome for Testing the alternate flavor) — offered/updated via
prompts (`chrome.manage` in config; `packages/aiui/src/util/managed-browser.ts`). The docs
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
- **Shared external deps are pinned through pnpm catalogs** in `pnpm-workspace.yaml`: the default
  catalog holds shared singleton versions (referenced as `"catalog:"` — vite, typescript, vitest,
  …), and named groups hold sets that move in lockstep (today `catalog:solid` for the Solid 2.0
  beta line, bumped together with the `babel-preset-solid`/`@solidjs/signals` overrides beside
  it). Bump a version there, once. `pnpm pack`/`publish` materialize literal versions, so
  published artifacts are unchanged (`pnpm test:packaging` guards this). Exception: create-aiui's
  app template keeps literal pins — its `package.json` ships as an asset npm/yarn must parse, and
  `catalog:` is pnpm-only — so bump the template in step; `new-demo` rewrites scaffolded demos to
  catalog references, so only the template itself carries literals.

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
code is only referenced from other fenced code, and the post-deletion tree must typecheck. (Watch
the import organizer here: a fenced import/export line must never share a module specifier with an
unfenced one, or biome merges them across the fence — the scenery controls re-export through
`scenery.ts` for exactly this reason.)

**Every scaffolded app has the dual shape** — standalone app AND library. `src/main.tsx` mounts
`src/page.tsx`, the app as a mountable `SitePage` (aiui-viz's page contract: title/App/
activate/deactivate, pause-not-destroy); `src/index.ts` is the library barrel behind the `.`
export; `src/card.tsx` is the app's **landing card** (aiui-viz's `DemoCard`: a blurb + a LIVE,
self-contained preview mini-app) behind the `./card` export; `package.json` carries the
`aiui.sitePage` marker (title/desc/order/card) and all three export subpaths (`.`/`./page`/`./card`).
The card is deliberately SEPARATE from the page so a landing page can mount every app's preview
without booting each one's heavy durable graph — a preview is built from the app's *pure* model
only. Identity is scoped: `appScope = scope("<slug>")` in `store.ts` qualifies every
control/durable/cell/action and names the graph key + agent toolkit, so any two aiui apps can
share one document (the reason the gallery can mount them all — see below).

**There is exactly one starter template.** It used to be two: `aiui demo` scaffolded a throwaway
playground from `packages/aiui/templates/demo`, predating `create-aiui`. That command and its
template are gone — scaffolding is `create-aiui`'s job, and `pnpm new-demo` is its in-repo twin.

**The reference notebooks are first-class demo packages**: `demos/morphogen` (WebGL
reaction–diffusion + worker analysis), `demos/aztec` (streaming domino shuffling), `demos/seismos`
(DuckDB-WASM/Mosaic crossfilter; its 4 MB catalog rides as `?url` asset imports so the data
travels with the package), `demos/circle` (the pencil-package demo, promoted from its old
gitignored-scratch status), `demos/gears` (an involute-gear studio, pure SVG geometry), and the
wave-optics pair `demos/gratings` + `demos/holograms` (diffraction and holography taught at
design level: streamed 2-D wave maps from a worker, WebGL field islands, paraxial design
equations overlaid on the honest wave — both riding `demos/optics`, the internal scalar-wave
engine package whose unit tests pin the physics claims). Each
is deliberately far richer than the starter, runs standalone (`pnpm -C demos/<slug> claude` +
`dev`), exports its widgets/store/pure model from `src/index.ts`, ships a live landing card
(`src/card.tsx`), and is scoped under `scope("<slug>")` throughout. Their shared dark-journal look
lives in `demos/journal` (`@habemus-papadum/aiui-journal`, internal like `demos/oscillator` and
`demos/optics`): the
theme literals plus the tokens/notebook-chrome stylesheet (the sidebar + landing-card chrome too).
A demo's page CSS uses demo-prefixed class names (or is scoped under a root class, like
`demos/gears`' `.gears`) so nothing leaks onto a sibling mounted in the same document.

**`demos/gallery` is the thin composer** — the notebook site's SPA shell, and the published
static site (`pnpm demo` serves it; `pnpm run publish` / `pnpm publish:gallery` deploys). It does
NOT depend on the demos: a Vite plugin (`demos/gallery/demo-discovery.ts`) scans
`demos/*/package.json` for the `aiui.sitePage` marker, resolves each demo's page AND card entries
through its own `exports` map, and serves `virtual:demo-pages` — the sidebar items, routes, lazy
page loaders, and lazy card loaders all derive from it (`publish.sh` derives its deep-link routes
from the same markers). The shell is a left **sidebar** (`SiteNav`, collapsing to a top bar +
drawer on a phone) plus a content area; the site HOME is a **landing** page (`src/site/Landing.tsx`)
with a card per demo — each card's live preview is the demo's own `DemoCard.Preview`, lazily
imported. Every demo lives at its own `/slug`. Adding a demo to the gallery = the marker existing;
a fresh `pnpm new-demo` scaffold carries page + card already. The demos stay self-contained pages
behind aiui-viz's `SitePage` contract — the shell drives pause-not-destroy
(`activate`/`deactivate`) across client-side routing so an open intent turn survives switching
notebooks.

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

## The `apps/` directory — products staged for eviction

`demos/*` are illustrations: they exist to be read, composed into the gallery,
and to keep the packages honest. `apps/*` are **products** — things meant to end
up in their own repository, installed by people who do not have this checkout.
Today: `cc-miner` (a dashboard over your own Claude Code usage) and `cc-assay`
(the tool that mines transcripts into Parquet).

`cc-miner` is also where the **two-host pattern** is being worked out: the same
app runs in a browser tab (`pnpm dev`) and in an Electron window
(`pnpm dev:electron`), from two Vite configs over a shared
`vite.config.base.ts`. Both are dev servers — Electron is a window pointed at a
Vite server, not a different build — and there is deliberately no packaging yet.
The renderer is byte-identical between them; where it needs to know its shell it
asks at *runtime* (`src/host.ts` sniffs the Electron user-agent) rather than
through a `define`, precisely so "it runs the same in both" stays a claim
anyone can check. `apps/cc-miner/electron/` stays in-package until the shape has
earned a home of its own (see the deployment-shapes proposal, git history).

They are full workspace members right now — `workspace:^` source-first editing,
CI typecheck, version lockstep — because that is what makes iteration fast while
the `aiui-*` packages underneath them are still moving. What makes them
*apps* rather than demos is where they are going, and one guarantee:

**`pnpm evict:check` verifies every app can still leave.** An app may only be
evicted if each workspace package it depends on is either evicted alongside it
or already published to npm. Running that in CI turns "this can stand alone"
into a maintained property rather than a discovery made on the day someone
tries. It has already earned its keep: `cc-miner` depended on
`@habemus-papadum/aiui-journal`, which is unpublished — and, as it turned out,
never imported.

```sh
pnpm evict:check                                   # can every app still leave?
pnpm evict cc-miner cc-assay --out /tmp/cc         # produce the standalone tree
pnpm evict cc-miner cc-assay --out /tmp/cc --history   # …and carry the commits
```

`scripts/evict.mjs` rewrites `workspace:^` to the published range, drops the
lockstep `+dev` version, hoists the packages to the new root, and carries the
things a package copy silently leaves behind. That last list was found by
running the eviction and watching it fail, not by reasoning:

- **`tsconfig.base.json`** — extended by relative path, so both `tsc` and vite's
  esbuild fail on an unresolvable `extends`. The tree installs, then cannot
  compile.
- **root `devDependencies`** — hoisted, therefore invisible to a package.
  `cc-assay` compiled here and failed there on `Cannot find type definition file
  for 'node'`.
- **`overrides` and `allowBuilds`** from `pnpm-workspace.yaml` — without the
  first, Mosaic's exact older `duckdb-wasm` pin installs a second copy and the
  types stop unifying; without the second, install fails on esbuild's build
  script.
- **the `catalog:`/`catalogs:` blocks**, same file (this one carried by
  reasoning when catalogs were introduced, not discovered by a failure: a
  manifest's `catalog:` reference is unresolvable without its definition, so
  the evicted tree could not even install).
- **`../../` paths** — `apps/<name>/` is two levels below the root, `<name>/` in
  the evicted repo is one.
- **a root `.gitignore`** — `biome.json` sets `vcs.useIgnoreFile`, so lint
  hard-errors without one.

Adding a new app is `pnpm new-demo` followed by a move, for now; there is no
`new-app` scaffolder and none is warranted until a third one exists.

## The `bootstrap/` directory — standalone, npm-pinned packages

`bootstrap/*` packages (today: `bootstrap/aiui-registry`) deliberately invert every workspace
convention: they live **outside the pnpm workspace globs** (own lockfile; a local
`pnpm-workspace.yaml` boundary marker plus a local `vitest.config.ts` stop pnpm/vitest walking up
to the repo root), carry their **own semver** (never the lockstep `X.Y.Z+dev`), are published
**manually** via their own `scripts/publish.mjs` (never `release.yml` — see AGENTS.md), and the
workspace consumes them **via npm at a pinned version** — the one place this repo does not run on
source. Why: aiui-registry's on-disk formats (registry entries, agents cache, native-messaging
frames) are a wire protocol between independently-installed aiui versions, and pinning one
published implementation is what keeps them coherent (the aiui-registry proposal, git history). Its own CI
is `.github/workflows/registry.yml` (path-filtered; includes a compiled-host smoke test and an
installed-shape pack→install test). The compiled host binaries ship as per-platform packages
(`…-host-<platform>-<arch>`, esbuild-style `optionalDependencies`, injected at stage time). The
one accepted duplication: `cacheDir` path resolution exists in both `aiui-util` and
`bootstrap/aiui-registry/src/paths.ts` and the two must stay byte-identical.

## Publication convention

> **Publishing authenticates with a stored npm token.** The release workflow reads the
> `NPM_TOKEN` repo secret (an npm token from the owner's account; set or rotate it with
> `gh secret set NPM_TOKEN --repo habemus-papadum/pdum_aiui`) and runs one recursive
> `pnpm -r publish`. A NEW package needs **no provisioning** — its first release simply
> publishes it. This replaced npm trusted publishing (OIDC) on 2026-08-11: OIDC bound auth to a
> per-package trusted-publisher registration, a manual step for every new package (and
> website-only on a passkey npm account). `--provenance` attestation still rides the workflow's
> `id-token: write` permission — that half is independent of auth. See
> [Name reservation](#name-reservation-optional) below for the one remaining (optional) act.
>
> **Assumption: this project has a paid npm account/org.** Publishing scoped packages
> (`@habemus-papadum/*`) as private (`--private`, `restricted` access) requires it. On the free tier,
> scoped packages can only be published as `--public`. (This is about visibility, independent of
> the auth question above.)

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

### Name reservation (optional)

With token auth, nothing must exist before a release — the first publish creates the package. The
one remaining provisioning act, now purely optional, is claiming a name **early** (before the next
release ships it for real): `pnpm npm:reserve <slug>` publishes a tiny placeholder
(`@habemus-papadum/<slug>@0.0.0-reserve.0`, under the `reserve` dist-tag, so it never becomes
`latest`). Idempotent: names already on the registry are skipped. `pnpm new-package … --public`
does this automatically (opt out with `--no-reserve`); it runs locally with your own npm login.

`pnpm npm:trust` (attaching an OIDC trusted publisher) is **retired** — nothing requires it. The
command remains in the tree for a future return to OIDC, but never suggest it as a setup step.
`pnpm npm:list` shows what's publishable.

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
`workflow_dispatch`), authenticated by the `NPM_TOKEN` secret. Never run `pnpm publish` /
`npm publish` to cut a release locally. The **only** local npm-write exception is the optional
name reservation above (`pnpm npm:reserve`) — a placeholder, not a release. See
[AGENTS.md](./AGENTS.md).
