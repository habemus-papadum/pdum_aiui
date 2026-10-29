# @habemus-papadum/create-aiui

Scaffold a fresh SolidJS + [aiui-viz](https://github.com/habemus-papadum/pdum_aiui) app, ready
for an agent to edit.

```sh
pnpm create @habemus-papadum/aiui@latest my-app   # or: npm create @habemus-papadum/aiui@latest my-app
cd my-app
pnpm install
pnpm dev          # Vite; open the printed URL
```

> Use the `@latest` tag: `pnpm create` runs through a dlx cache that can otherwise reuse a
> previously-resolved (older) scaffolder. And if you need a release published **within the last
> day**, pin it exactly (`…/aiui@0.9.0 my-app`) — pnpm's minimum-release-age gate silently holds
> back very fresh versions, even under `@latest`. Either way the version matters: each scaffolder
> build carries the release line of every aiui package it was built beside, and pins the app's
> dependencies to those, so an old scaffolder gives you old `@habemus-papadum/*` packages.

The scaffolded app opens on a banner that explains itself. Its starter content — a Maurer rose
driven by two sliders — is scenery built to be rebuilt, but its
*shape* is the [frontend-for-agents](https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/docs/frontend-for-agents.md)
methodology in miniature:

- **durable roots** (`src/model/store.ts`) — `durableSignal()` interaction state that survives
  hot edits;
- a **disposable cell graph** + agent tools (`src/model/graph.ts`) — Observable-style dataflow
  over the roots, built by `hotCellGraph()` and rebuilt on every hot edit, with the app's
  operations exposed as tools;
- an `.envrc` (direnv), a `.gitignore`, a `CLAUDE.md` with the agent's ground rules, and its own
  git repo so agent churn is versioned in the sandbox and nowhere else.

Re-running the command on an existing scaffold **continues** it (tops up `node_modules`, reprints
the next steps) — it never overwrites your or the agent's changes. Anything else at the target
path is refused.

This is the **only** starter aiui ships. (An older `aiui demo` subcommand scaffolded a second,
throwaway playground; it was removed in favour of one template that people actually build on.)

Advanced pieces the starter deliberately omits — the key layer and the mode engine
(`@habemus-papadum/aiui-viz/keys`, `…/mode-engine`), Web Worker cells, the Observable Plot and Mosaic bridges —
are shown in the repo's `demos/gallery` reference notebooks.

## Development notes

- The template lives in `templates/app` and ships in the published tarball (`files`). Dot-files
  are shipped undotted (`gitignore`, `envrc`) because npm strips dot-paths from tarballs; the
  scaffolder restores them.
- `__APP_NAME__` and `__AIUI_VERSION_RANGE__` in the template's `package.json` are resolved at
  scaffold time. The range is per package: `vite.config.ts` bakes each aiui dependency's version
  from its workspace manifest into the build (`<last release>+dev` between releases), and the
  scaffolder writes `^<last release>`; a source checkout run through tsx has nothing baked and
  writes `latest`. Packages release independently, so release the library before the scaffolder
  when the template needs a change in it.
- `pnpm typecheck` checks the template's source too (`tsconfig.template.json`, resolving
  `@habemus-papadum/*` through the workspace) — template code that doesn't compile fails CI here,
  not in a user's freshly scaffolded app.
