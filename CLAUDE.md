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
2. **Intent tools** — frontends for that pipeline. First one is working: the **web intent tool**
   (`mountIntentTool` in `aiui-dev-overlay`) — dev-gated, stateless, pluggable modalities; text PoC
   today, speech + screenshots + DOM capture next. Lowering runs are traced to the project-local
   `.aiui-cache/` (gitignored). Debugging lives in the **aiui Chrome DevTools panel**
   (`aiui-devtools-extension`, loaded unpacked): server monitor + websocket latency/size metrics (from
   `window.__AIUI__` page instrumentation) + the trace debugger (the shared `debug-ui` viewer — the
   widget's 🔍 opens it at `/__aiui/debug`, session-pinned; `aiui debug` serves it standalone with a
   channel switcher). The channel itself serves **no HTML** — JSON/data routes only (`/debug/api/*`,
   `/health`); every page belongs to a frontend process.
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
non-interactive default: skip — see `packages/aiui/src/util/first-run.ts`), loads
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
  points (subpath exports go in *both*, like `aiui-dev-overlay`'s `./vite`).
- **`bin` stays pointing at `dist/`** in both forms: bins are executed by plain `node` from
  installed tarballs; in-workspace CLI spawning already runs source via tsx
  (`packages/aiui/src/util/resolve-cli.ts`).
- **`pnpm test:packaging` is the guard for the published (dist) shape** — pack applies the
  `publishConfig` swap, so it tests what consumers install. Run it whenever packaging fields
  change. This matters doubly because source-first dev *masks* dist-only bugs: e.g.
  `import.meta.env.*` is substituted at build time, so `dist/` code can never read its consumer's
  env (the reason the overlay integrates via a Vite plugin — internals note in
  `docs/guide/web-intent-tool.md`). In-repo, source mode hides that class of bug; the packaging
  test and the plugin design are what stand between you and them.
- **Never `optimizeDeps.include` a workspace package** in a Vite config: the dep-optimizer cache
  is keyed by the lockfile, not package contents, so a linked package would be served stale (see
  the comment in `packages/aiui-dev-overlay/src/vite.ts`).

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
