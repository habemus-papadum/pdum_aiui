# pdum_aiui

Guidance for humans and agents working in this repo. See also [AGENTS.md](./AGENTS.md) for
version/release guardrails.

## What this project is

A UI framework for **agent-written scientific/technical interfaces**, the AI utilities around
it, and the notebooks that demonstrate both. Three pillars:

1. **Frontend for agents** — `aiui-viz` (SolidJS 2.0 with Observable-style async *cells*,
   durable/disposable HMR structure, scoped identity, a derived agent tool surface),
   `aiui-source-processor` (the compile-time pass that stamps identity and source locators),
   `aiui-design`, `aiui-slides`, `create-aiui`. The methodology lives in
   `packages/aiui-viz/docs/` (`frontend-for-agents.md` is the concepts page; playbook, user
   guide, design choices, hard-won ledger and style guide go deeper); the root skill
   `skills/aiui-architecture` is its operational digest.
2. **AI utilities** — `aiui-prompts` (+ `-inspector`, `-vite`; `docs/architecture.md` is the
   contract), `aiui-oracle` (the app's cells as tools over OpenAI Realtime), `aiui-live`
   (GPT-Live with pluggable delegation backends; its `docs/` carry the measured findings),
   `aiui-dock` (both voice engines in any aiui page), `aiui-stt`, `aiui-cf-creds`, `aiui-pencil`,
   `aiui-remote-bar`, `aiui-room-relay`, `aiui-util` (the sidecar contract + client-surface
   serving). The sidecar packages publish a `./sidecar` subpath for a host *outside this repo*
   to mount — nothing in here mounts them.
3. **The demo notebooks and the gallery** — `demos/*`, composed into the published static site.

**House rules for prose.** Design notes live in the owning package's `docs/`. `docs/proposals/`
keeps the finished proposals as a record — not wired into any build or site, each marked with its
status. Pre-implementation explorations retire outright — git history is the archive (no
`archive/`, no root docs site). The README is the repo's index.

## The repo IS the Claude plugin (one skill at the root)

The repo root carries `.claude-plugin/plugin.json` (one plugin, `aiui`) plus a one-entry
self-catalog `.claude-plugin/marketplace.json` (marketplace `pdum-aiui`, source `./`); the one
skill lives in `skills/aiui-architecture`. Because the plugin is the whole repo, the skill links
straight into `packages/*/docs/` with ordinary relative links — installs get the live docs,
nothing is bundled or generated. `pnpm skills:check` (CI) is the only guard: manifests parse,
every relative link resolves. The plugin manifest's `version` is **lockstep** (stamped by
`scripts/versioning.mjs`; never hand-edit — AGENTS.md), which pins marketplace updates to
release bumps. Install: `claude plugin marketplace add habemus-papadum/pdum_aiui` +
`claude plugin install aiui@pdum-aiui`; a checkout loads with `claude --plugin-dir <repo root>`.

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
installed consumers once; `pnpm test:packaging` now asserts it).

So `workspace:^` deps behave like Python *editable installs*: edit a package, and every
in-workspace consumer (a demo's dev server, sibling tests, tsx-run scripts) picks it up with
**no build step** — Vite, Vitest, and tsx all transpile TS from linked packages. Rules:

- **New packages get the shape from the skeleton** (`scripts/_skeleton/package.json.tmpl`) via
  `pnpm new-package`; keep dev fields and `publishConfig` overrides in sync when adding entry
  points (subpath exports go in *both*, like `aiui-pencil`'s `./sidecar`). **`bin` stays on
  `dist/`** in both forms — bins run under plain `node` from installed tarballs.
- **`pnpm test:packaging` is the guard for the published (dist) shape** — pack applies the
  `publishConfig` swap, so it tests what consumers install; run it whenever packaging fields
  change. Source-first dev *masks* dist-only bugs: `import.meta.env.*` is substituted at build
  time, so `dist/` code can never read its consumer's env — runtime configuration for prebuilt
  code travels through injected globals (`window.__AIUI__.devKeys`) or plugin-generated modules.
- **Never `optimizeDeps.include` a workspace package** in a Vite config: the dep-optimizer cache
  is keyed by the lockfile, not package contents, so a linked package would be served stale.
- **Shared external deps are pinned through pnpm catalogs** in `pnpm-workspace.yaml`: the default
  catalog holds shared singleton versions (`"catalog:"`), named groups hold sets that move
  together (`catalog:solid` for the Solid 2.0 release-candidate line, bumped with the
  `@solidjs/signals` override beside it). Bump a version there, once; `pnpm pack`/`publish`
  materialize literals. Exception: create-aiui's app template keeps literal pins (its
  `package.json` ships as an asset npm/yarn must parse) — bump it in step; `new-demo` rewrites
  scaffolded demos to catalog references.

## In-repo demo apps — `pnpm new-demo <name>`

`demos/<slug>` holds demo apps that live in source control and consume the workspace. They are the
internal twin of `pnpm create @habemus-papadum/aiui`: **the same template**
(`packages/create-aiui/templates/app`), scaffolded by `scripts/new-demo.ts`, which *imports*
create-aiui's `scaffoldApp` rather than copying the starter, so the two paths cannot drift.

```sh
pnpm new-demo spectra          # -> demos/spectra
pnpm install                   # link the new workspace member
pnpm -C demos/spectra dev      # Vite dev server (the voice dock reads OPENAI_API_KEY via devKeys)
```

**The template's scenery is fenced.** Every piece of placeholder content sits between
`<aiui-scenery>` markers (whole scenery files carry `<aiui-scenery-file>` on line 1), so "reset to
a blank app" is a mechanical deletion documented in the template's `CLAUDE.md`. Keep the
invariant: fenced code is only referenced from other fenced code, and the post-deletion tree must
typecheck (`pnpm test:template` proves it). A fenced import/export line must never share a module
specifier with an unfenced one, or biome merges them across the fence.

**Every scaffolded app has the dual shape** — standalone app AND library. `src/main.tsx` mounts
`src/page.tsx`, the app as a mountable `SitePage` (aiui-viz's page contract: title/App/
activate/deactivate, pause-not-destroy); `src/index.ts` is the library barrel behind the `.`
export; `src/card.tsx` is the **landing card** (aiui-viz's `DemoCard`: a blurb + a LIVE preview
built from the app's *pure* model only) behind `./card`; `package.json` carries the
`aiui.sitePage` marker and the `.`/`./page`/`./card` subpaths. Identity is scoped:
`appScope = scope("<slug>")` in `store.ts` qualifies every control/durable/cell/action and names
the graph key + agent toolkit, so any two aiui apps can share one document — the reason the
gallery can mount them all.

**The reference notebooks are first-class demo packages** (the README lists them): each runs
standalone, exports its widgets/store/pure model from `src/index.ts`, ships a live card, and is
scoped under `scope("<slug>")` throughout. `gratings` + `holograms` ride `demos/optics` and
`twins` rides `demos/oscillator` — internal, never-published workspace packages. Their shared
look is the **design system**, `packages/aiui-design` (`DESIGN.md` is the language — cotton
paper, slate ink, one accent, editorial type, light only): one `site.css` import per host
carries tokens, fonts, the skin for every stable aiui-viz class, and the notebook chrome; its
theme module carries the palette as literals for canvases and Plot. `demos/styleguide` is the
visual acceptance test. A demo's page CSS is unlayered and wins over the package sheet; it uses
demo-prefixed class names (or a root class, like `.gears`) so nothing leaks onto a sibling in the
same document.

**`demos/gallery` is the thin composer** — the SPA shell and the published static site at
https://habemus-papadum.net/aiui/ (`pnpm demo` serves it; `pnpm publish:gallery` deploys;
`release.yml` deploys on every release). It depends on NO demo: a Vite plugin
(`demos/gallery/demo-discovery.ts`) scans `demos/*/package.json` for the `aiui.sitePage` marker
and serves `virtual:demo-pages` — sidebar, routes, lazy page and card loaders all derive from
it. Adding a demo to the gallery = the marker existing. The shell drives pause-not-destroy across
client-side routing so an open voice session survives switching notebooks. **`demos/twins`** is
the composability worked example (one slice under `scope("left")`/`scope("right")`);
**`demos/walkthrough`** is the teaching demo (the playbook in order on 1-D diffusion, every layer
left standing as its own page — its steps must stay truthful; see its `CLAUDE.md`).

Three things follow from `demos/*` being a workspace glob in `pnpm-workspace.yaml`:

- **Demos are never published.** The template's `package.json` carries `"private": true`, so
  `pnpm -r publish` skips them; no `publishConfig` belongs in a demo.
- **Demos are in version lockstep.** `scripts/versioning.mjs` derives its set from the workspace
  globs, so every demo carries the shared `X.Y.Z+dev` or `pnpm version:check` fails in CI.
- **Demos are typechecked by CI.** A demo that stops building is a signal, not noise.

A demo is not its own git repo, ships no `.gitignore`/`.envrc`, and drops the
`"aiui": { "scaffold": true }` marker, so `create-aiui` classifies it as `occupied` and refuses
to touch it.

## Publication convention

Publishing authenticates with the **`NPM_TOKEN` repo secret** (rotate with
`gh secret set NPM_TOKEN --repo habemus-papadum/pdum_aiui`) and runs one recursive
`pnpm -r publish`; a NEW package needs **no provisioning** — its first release publishes it.
Assumption: a paid npm org (publishing scoped packages as `restricted` requires one).

**Every package declares a publication level at creation time.** `pnpm new-package <name>`
requires exactly one of `--public` (`publishConfig.access: "public"`), `--private`
(`"restricted"`) or `--no-publish` (`"private": true`, never published). To change a level
later, edit `packages/<slug>/package.json`: un-publishing → publishing means removing
`"private": true` and adding `"files": ["dist"]` plus the full `publishConfig` (the shape above);
private → public also needs `npm access set access=public @habemus-papadum/<slug>`, since
`publishConfig.access` only applies on a package's *first* publish.

**Name reservation (optional).** `pnpm npm:reserve <slug>` placeholder-publishes
`@habemus-papadum/<slug>@0.0.0-reserve.0` under the `reserve` dist-tag (never `latest`) to claim
a name early; idempotent; `pnpm new-package … --public` does it automatically (`--no-reserve`
opts out). `pnpm npm:list` shows what is publishable.

**Publishing is CI-only.** Real versions ship **exclusively** through
`.github/workflows/release.yml` (a manual `workflow_dispatch`). Never run `pnpm publish` /
`npm publish` locally; the only local npm-write is the optional reservation above. See
[AGENTS.md](./AGENTS.md).
