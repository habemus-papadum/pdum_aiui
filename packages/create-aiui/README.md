# @habemus-papadum/create-aiui

Scaffold a fresh SolidJS app pre-wired for the [aiui](https://habemus-papadum.github.io/pdum_aiui/)
loop — a Claude Code session with a custom channel, a shared agent+human browser, and the web
intent tool floating over your page.

```sh
pnpm create @habemus-papadum/aiui my-app     # or: npm create @habemus-papadum/aiui my-app
cd my-app
npm run claude    # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev       # terminal 2 — the app (Vite + the intent tool)
npx aiui open http://localhost:5173
```

The scaffolded app opens on a banner that explains itself: the page is alive, arm the ✳ aiui
overlay and start talking about the app you want. Its starter content — a Maurer rose driven by
one slider, two modal keyboard commands (**T** tunes the angle with the arrow keys, **R** cycles
the petal count) — is scenery built to be rebuilt, but its *shape* is the
[frontend-for-agents](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-for-agents)
methodology in miniature:

- **durable roots** (`src/model/store.ts`) — interaction state that survives hot edits;
- a **disposable cell graph** + agent tools (`src/model/graph.ts`) — Observable-style dataflow
  over the roots, rebuilt on every hot edit, with the app's operations exposed as tools;
- a **modal shell** on the `@habemus-papadum/aiui-viz/modal` kit (`src/model/modal.ts`) — modes,
  key layers, and surfaces as data, with a hint bar derived from the working keymap;
- an `.envrc` (direnv), a `.gitignore`, a `CLAUDE.md` with the agent's ground rules, and its own
  git repo so agent churn is versioned in the sandbox and nowhere else.

Re-running the command on an existing scaffold **continues** it (tops up `node_modules`, reprints
the loop) — it never overwrites your or the agent's changes. Anything else at the target path is
refused.

## How `aiui demo` relates

`npx @habemus-papadum/aiui demo` scaffolds a *disposable playground* — deliberately throwaway
scenery with no framework code, for trying the loop. `create-aiui` scaffolds a *starting point* —
the same loop plus the viz methodology, for building something you mean to keep.

## Development notes

- The template lives in `templates/app` and ships in the published tarball (`files`). Dot-files
  are shipped undotted (`gitignore`, `envrc`) because npm strips dot-paths from tarballs; the
  scaffolder restores them.
- `__APP_NAME__` and `__AIUI_VERSION_RANGE__` in the template's `package.json` are resolved at
  scaffold time (release builds pin `^X.Y.Z`; dev builds fall back to `latest`).
- `pnpm typecheck` checks the template's source too (`tsconfig.template.json`, resolving
  `@habemus-papadum/*` through the workspace) — template code that doesn't compile fails CI here,
  not in a user's freshly scaffolded app.
