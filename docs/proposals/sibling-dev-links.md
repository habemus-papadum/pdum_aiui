# Sibling dev links: develop against a split-off repo without committing the link

When a monorepo package moves to its own repository, its consumers switch from `workspace:^`
to a registry range. During the transition a consumer sometimes needs the old tight loop
again: edit the sibling repo, see the change in the consumer's dev server immediately. This
proposal is a small tool, `devlink`, that turns that loop on and off with no tracked change.

Status: **SPECULATIVE — NOT APPROVED.** An exploration only; nothing here is a decision or a
plan to build. A prototype was built and tested 2026-10-10 to see whether the idea holds up.
Nothing in this repo changed;
the prototype ran against throwaway fixtures (pnpm 11.9.0, Vite 8.3, Vitest 5.0.3, TypeScript
5.9, Node 26, git on macOS). Every claim under *Measured* was observed in those runs; the
items under *Not tested* were not. The full source is in the appendix.

## 1. The requirements

1. **Changes show up immediately in either repo.** An edit in the sibling repo reaches the
   consumer's dev server (and Vitest) with no build or publish step.
2. **No version confusion.** It is always obvious whether the registry copy or the linked
   copy is running, and code that needs unreleased sibling changes cannot merge silently.
3. **The link can't be committed by accident.** Linking and unlinking leave `git status`
   clean; no habit (`git add -A`, `commit -a`, `pnpm install`, `pnpm add`) leaks it.

## 2. Options considered

| Option | Verdict |
| --- | --- |
| `pnpm link <dir>` | Rejected. Measured on pnpm 11.9.0, run in a workspace package: it modified three tracked files — an `overrides` entry in `pnpm-workspace.yaml`, a new `link:` dependency in the *root* `package.json`, and the lockfile — all of which would have to be reversed before committing. |
| Bundler alias (`resolve.alias` + tsconfig `paths` to a gitignored `.links/` symlink) | Works, and is inert when the symlink is absent (TypeScript and tsx both fall back to `node_modules`; measured). Rejected as the base: it bypasses the package's `exports` (every subpath mapped by hand, twice), and only Vite/tsc/tsx see it — Node and pnpm don't. |
| **Generated `.pnpmfile.cjs` rewriting the dependency to `link:`** | **Chosen.** It produces the same symlink `workspace:^` does, so `exports`, subpaths, bins and plain Node all behave as in the monorepo. Its one leak, the lockfile, is handled below. |

## 3. Design

`devlink` is one Node script (no dependencies) plus a 25-line Vite plugin.

**`devlink link <dir>...`**, run at the consumer's pnpm root:

- records `{ name: absoluteDir }` in `.devlinks.json` and writes a generated `.pnpmfile.cjs`
  whose `readPackage` hook rewrites every matching dependency to `link:<dir>`, logging
  `devlink: web is-number@^7.0.0 -> LINKED /…/lib (local 7.1.0+dev)` on every install;
- excludes both files through `.git/info/exclude` (local to the clone; no `.gitignore` edit);
- installs a pre-commit hook (`.git/hooks/pre-commit`, untracked) — see §5;
- runs `pnpm install`, then marks `pnpm-lock.yaml` **skip-worktree** so git stops seeing the
  linked lockfile;
- refuses when the lockfile already has uncommitted changes, when the project has its own
  `.pnpmfile.cjs`, or when a devlink file is tracked.

**`devlink unlink [name...]`** (all links when no names): deletes the state and the pnpmfile,
removes the hook, clears skip-worktree, restores the committed lockfile, and runs a normal
`pnpm install`. A dependency added while linked re-resolves into the lockfile at this point and
shows up in git, correctly, as a real change.

**`devlink status`** lists the links and whether the lockfile is hidden.

**The Vite plugin** (`devlink({ dedupe: ['solid-js', …] })` in `vite.config`) is the one
committed edit per consumer, and it is inert: without a `.devlinks.json` at or above the Vite
root it returns nothing. While linked it adds `resolve.dedupe` for the named singletons and
prints a yellow `devlink: <pkg> is LINKED to <dir>` banner at server/test start.

### Why skip-worktree and not "restore the lockfile after install"

The first prototype snapshotted the lockfile before the linked install and wrote the bytes
back after it. That fails on pnpm 11: pnpm verifies dependencies before **every**
`pnpm run`, sees that the lockfile and `node_modules` disagree, reinstalls (through the still
active pnpmfile), and rewrites the linked lockfile — measured three times in a row. So pnpm
keeps its linked lockfile, which keeps `pnpm run` quiet, and git is told to look away.

## 4. Measured

The fixture: a sibling repo `lib` publishing the name `is-number` (the real registry package
stands in for "the published copy"; the sibling is ESM, **source-first** — dev `exports`
point at `src/index.ts`, as in this repo — at version `7.1.0+dev`), and a consumer pnpm
workspace with `web` (Vite + Vitest) and `tool` (a plain `node` script), both on
`is-number@^7.0.0`. A singleton package (`@t/singleton`, a class with a `#private` field) is
installed separately in both repos. `kleur` was locked at 4.0.0 under `^4.0.0` while 4.1.5
exists, to detect re-resolution drift.

| # | Check | Result |
| --- | --- | --- |
| 1 | `devlink link ../lib`, then `git status` | Empty. `.git/info/exclude` gained the two paths; the hook was written. |
| 2 | Both workspace packages linked | `web/` and `tool/node_modules/is-number` → `../../../lib`. |
| 3 | Drift | `kleur` stayed at 4.0.0 through link and unlink. |
| 4 | `pnpm run` ×3 while linked | No reinstall, lockfile untouched (with skip-worktree). With byte-restore instead, every run rewrote it. |
| 5 | Plain `node` importing the linked package | Ran the sibling's `.ts` source directly (Node strips types outside `node_modules`; the realpath is outside it). |
| 6 | Vite dev server serves the linked source | HTTP 200 at `/@fs/…/lib/src/index.ts`, **with or without the plugin**. Vite 8 needed no `server.fs.allow` change, so the plugin doesn't set one. |
| 7 | Edit in the sibling repo while Vite runs | The HMR socket received an update for `lib/src/index.ts` (a `full-reload`, because the probe page has no HMR boundary), and the re-fetched module carried the edit. |
| 8 | Singleton in the Vite dev server | One copy, **with or without the plugin**: the dep optimizer pre-bundles `@t/singleton` once and serves it to every importer. |
| 9 | Singleton in Vitest | **Two copies without the plugin** (`instanceof` false, test fails); one with `dedupe` (test passes). This is the plugin's real job. |
| 10 | Singleton in plain Node | Two copies; nothing short of making them one install fixes it. |
| 11 | `tsc` with the singleton at the same version in both repos | Passes: TypeScript merges packages with the same name and version. |
| 12 | `tsc` with the sibling on 1.0.1, the consumer on 1.0.0 | `TS2322 … Property '#secret' … refers to a different member` — the nominal clash. Aligned versions (one shared catalog) avoid it. |
| 13 | `git add -A && git commit` after `pnpm add -D vitest` while linked | **Blocked** by the hook: a `package.json` is staged while the lockfile is hidden (committing it alone would break CI's frozen install). |
| 14 | `git add pnpm-lock.yaml` / `git add --force` while linked | Git refuses to stage a skip-worktree path. After clearing skip-worktree by hand and staging, the hook **blocked** it (`pnpmfileChecksum` present). |
| 15 | `git commit -a` while linked | **Blocked** (same rule as 13). |
| 16 | Ordinary code commit while linked | Allowed. |
| 17 | `git pull` of a teammate's lockfile change while linked | Refused by git (`local changes would be overwritten`); nothing corrupted. Git's advice (commit or stash) is wrong here — the sequence is unlink, pull, link. |
| 18 | `devlink unlink` | State, pnpmfile and hook removed; skip-worktree cleared; registry copy back; the vitest addition re-resolved into the lockfile with no `link:` or `pnpmfileChecksum`. |
| 19 | CI simulation: fresh clone, `pnpm install --frozen-lockfile` | Passes; the plugin is silent. |
| 20 | Committed code using the sibling's unreleased API, run in that clone | Fails (`who is not a function`). This is the versioning guard working. |

## 5. How the requirements are met

**Immediate changes** (rows 5–7) need the sibling repo to stay **source-first**: dev `exports`
pointing at `src/`, with `dist/` only in `publishConfig`. A split-off repo that points its
dev `exports` at `dist/` falls back to running its build watcher alongside — still a working
link, no longer zero-step. Keep the convention when splitting.

**Versioning** is not solved by the link — a dev link bypasses semver by definition — and the
tool does not pretend to check ranges (under `X.Y.Z+dev` stamping the sibling's `main` usually
does not satisfy a 0.x caret range, so a check would only get in the way). Instead, two guards
take its place:

- *Which copy is running* is never silent: the install log names each linked dependency with
  its declared range and the sibling's local version, and the plugin's banner opens every dev
  server and test run.
- *Code that needs unreleased sibling changes* fails CI (row 20), because CI installs the
  registry version with `--frozen-lockfile`. That enforces the merge order: release the
  sibling, bump the consumer's range, then merge the consumer.

**No accidental commit** rests on three layers: the generated files are excluded locally
(row 1), the linked lockfile is skip-worktree (rows 4, 14), and the hook refuses the two
remaining leak paths — a staged linked lockfile, or a manifest staged without its lockfile
(rows 13–15). CI's frozen install remains the backstop for anyone who bypasses the hook
(`--no-verify`): a linked lockfile fails it with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`
(measured in an earlier probe).

## 6. Limits and open items

**Not tested:**

- SSR builds and `vite build` while linked (`dedupe` should apply to SSR by the same
  mechanism as Vitest).
- Real HMR hot-updates through a Solid HMR boundary (only the watcher → socket → re-served
  module path was observed).
- A registry package that itself depends on the linked package (the hook rewrites every
  manifest pnpm reads, so it should link too).
- Windows; git worktrees (the paths come from `git rev-parse --git-path`, which should handle them).

**Known friction:**

- **Pulling a lockfile change while linked** (row 17) needs unlink → pull → link. A
  `devlink pull` wrapper would remove the step.
- **Hooks managed elsewhere.** If `core.hooksPath` is set (husky, lefthook) or a non-devlink
  `pre-commit` exists, devlink prints the two checks to paste instead of installing them.
- **A project with its own `.pnpmfile.cjs`** is refused; merging hooks is not implemented.
- **Plain Node keeps two singleton copies** (row 10). Scripts that hand objects between the
  consumer and the linked package need the versions aligned or the singleton linked as well.

## 7. Where it would live (owner's call)

The prototype is two files. If it were ever adopted (it is not), they would ship as one small published package — a
`devlink` bin plus a `./vite` subpath for the plugin — that every split-off repo depends on.
The plugin import in `vite.config` is the only committed footprint per consumer. Choosing the
package name, and whether the bin also becomes an `aiui` subcommand, is left open.

## Appendix A: `devlink.mjs`

```js
#!/usr/bin/env node
// devlink — link a sibling repo's package into this pnpm project for development,
// leaving no tracked change behind. Run from the pnpm project (or workspace) root.
//
//   devlink link <dir>...     link each <dir>'s package in place of its registry copy
//   devlink unlink [name...]  drop links (all when no names) and reinstall from the lockfile
//   devlink status            show links and whether the lockfile is hidden from git
//
// Everything devlink writes is untracked: .devlinks.json + .pnpmfile.cjs (excluded via
// .git/info/exclude), a pre-commit hook in .git/hooks, and node_modules. While linked, the
// lockfile carries the link and is marked skip-worktree; unlink restores the committed one.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MARK = 'devlink-managed'
const root = process.cwd()
const STATE = path.join(root, '.devlinks.json')
const PNPMFILE = path.join(root, '.pnpmfile.cjs')
const LOCK = path.join(root, 'pnpm-lock.yaml')

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const die = (msg) => {
  console.error(`devlink: ${msg}`)
  process.exit(1)
}
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
const isOurs = (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK)
const tracked = (file) => {
  try {
    git('ls-files', '--error-unmatch', path.relative(root, file))
    return true
  } catch {
    return false
  }
}

// The generated pnpmfile: rewrites every matching dependency spec to `link:<dir>` and says so.
const PNPMFILE_SOURCE = `// ${MARK}: generated by devlink, untracked (.git/info/exclude). Remove with \`devlink unlink\`.
const fs = require('node:fs')
const path = require('node:path')
const links = JSON.parse(fs.readFileSync(path.join(__dirname, '.devlinks.json'), 'utf8'))
module.exports = {
  hooks: {
    readPackage(pkg, ctx) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, dir] of Object.entries(links)) {
          const range = pkg[field]?.[name]
          if (!range || range.startsWith('link:')) continue
          pkg[field][name] = 'link:' + dir
          const local = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
          ctx.log('devlink: ' + pkg.name + ' ' + name + '@' + range + ' -> LINKED ' + dir + ' (local ' + local + ')')
        }
      }
      return pkg
    },
  },
}
`

// Two ways a link leaks into a commit: the linked lockfile itself gets staged, or a manifest
// changed while linked gets committed without the lockfile (which git is hiding) — CI's
// frozen install would then fail. Both are refused.
const HOOK_SOURCE = (lockPath) => `#!/bin/sh
# ${MARK}: generated by devlink; removed by \`devlink unlink\`.
lock="${lockPath}"
if git show ":$lock" 2>/dev/null | grep -q '^pnpmfileChecksum:'; then
  echo "devlink: the staged $lock was written while a dev link was active." >&2
  echo "devlink: restore it with: git checkout HEAD -- $lock && git add $lock" >&2
  exit 1
fi
if git ls-files -v -- "$lock" | grep -q '^S ' && git diff --cached --name-only | grep -qE '(^|/)package\\.json$'; then
  echo "devlink: a package.json is staged while a dev link hides $lock from git." >&2
  echo "devlink: run \\\`devlink unlink\\\` first so the lockfile records the change, then commit both." >&2
  exit 1
fi
`

function preflight() {
  if (!fs.existsSync(path.join(root, 'package.json'))) die('run from the pnpm project root')
  if (fs.existsSync(PNPMFILE) && !isOurs(PNPMFILE))
    die('this project has its own .pnpmfile.cjs; devlink would have to merge into it (not supported)')
  if (tracked(PNPMFILE) || tracked(STATE)) die('a devlink file is tracked by git; refusing')
}

function ensureExcluded() {
  const exclude = path.resolve(root, git('rev-parse', '--git-path', 'info/exclude'))
  const prefix = git('rev-parse', '--show-prefix')
  const want = [`/${prefix}.devlinks.json`, `/${prefix}.pnpmfile.cjs`]
  const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  const missing = want.filter((line) => !have.split('\n').includes(line))
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
  }
}

function hookPath() {
  if (git('config', '--default', '', 'core.hooksPath')) return null
  return path.resolve(root, git('rev-parse', '--git-path', 'hooks/pre-commit'))
}

function ensureHook() {
  const hook = hookPath()
  const lockPath = git('rev-parse', '--show-prefix') + 'pnpm-lock.yaml'
  if (!hook || (fs.existsSync(hook) && !isOurs(hook))) {
    console.warn('devlink: a pre-commit hook is already managed elsewhere; add these checks to it:')
    console.warn(HOOK_SOURCE(lockPath).split('\n').slice(2).join('\n'))
    return
  }
  fs.mkdirSync(path.dirname(hook), { recursive: true })
  fs.writeFileSync(hook, HOOK_SOURCE(lockPath), { mode: 0o755 })
}

function removeHook() {
  const hook = hookPath()
  if (hook && isOurs(hook)) fs.rmSync(hook)
}

// A linked install: pnpm writes link: entries + pnpmfileChecksum into the lockfile. Restoring
// the committed bytes does not work — pnpm 11 verifies deps before every `pnpm run` and
// reinstalls (re-writing the link) when lockfile and node_modules disagree. So pnpm keeps its
// linked lockfile and git is told to look away (skip-worktree) until `devlink unlink`.
const lockRel = () => path.relative(root, LOCK)
function linkedInstall() {
  execFileSync('pnpm', ['install'], { cwd: root, stdio: 'inherit' })
  git('update-index', '--skip-worktree', lockRel())
}
// Back to the committed lockfile, then a normal install: re-resolves anything added while
// linked (that change then shows up in git, correctly) and otherwise reproduces the lockfile.
function unlinkedInstall() {
  git('update-index', '--no-skip-worktree', lockRel())
  git('checkout', '--', lockRel())
  execFileSync('pnpm', ['install'], { cwd: root, stdio: 'inherit' })
}
const lockHidden = () => git('ls-files', '-v', '--', lockRel()).startsWith('S ')

function writeState(links) {
  if (Object.keys(links).length) {
    fs.writeFileSync(STATE, `${JSON.stringify(links, null, 2)}\n`)
    fs.writeFileSync(PNPMFILE, PNPMFILE_SOURCE)
  } else {
    fs.rmSync(STATE, { force: true })
    fs.rmSync(PNPMFILE, { force: true })
  }
}

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'link': {
    if (!args.length) die('usage: devlink link <dir>...')
    preflight()
    const links = readState()
    if (!Object.keys(links).length && git('status', '--porcelain', '--', lockRel()))
      die('pnpm-lock.yaml has uncommitted changes; commit or discard them before linking')
    for (const arg of args) {
      const dir = fs.realpathSync(path.resolve(arg))
      const { name } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      links[name] = dir
    }
    ensureExcluded()
    ensureHook()
    writeState(links)
    linkedInstall()
    break
  }
  case 'unlink': {
    preflight()
    const links = readState()
    for (const name of args.length ? args : Object.keys(links)) delete links[name]
    writeState(links)
    if (Object.keys(links).length) linkedInstall()
    else {
      removeHook()
      unlinkedInstall()
    }
    break
  }
  case 'status': {
    const links = readState()
    if (!Object.keys(links).length) console.log('devlink: no links')
    for (const [name, dir] of Object.entries(links)) console.log(`devlink: ${name} -> ${dir}`)
    console.log(`devlink: pnpm-lock.yaml ${lockHidden() ? 'hidden from git (skip-worktree) while linked' : 'tracked normally'}`)
    break
  }
  default:
    die('usage: devlink link <dir>... | unlink [name...] | status')
}
```

## Appendix B: the Vite plugin

```js
// devlink's Vite half. Inert unless a .devlinks.json is found at or above the Vite root.
// While linked it dedupes the named singletons — the linked source otherwise resolves its
// own copies from the sibling repo's node_modules (measured in Vitest; the browser dev
// server's dep optimizer already shares one copy) — and says loudly that a link is active.
import fs from 'node:fs'
import path from 'node:path'

function findLinks(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const file = path.join(dir, '.devlinks.json')
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
    if (fs.existsSync(path.join(dir, '.git')) || dir === path.dirname(dir)) return null
  }
}

export function devlink({ dedupe = [] } = {}) {
  return {
    name: 'devlink',
    config(config) {
      const links = findLinks(config.root ?? process.cwd())
      if (!links) return
      for (const [name, dir] of Object.entries(links))
        console.warn(`\x1b[33mdevlink: ${name} is LINKED to ${dir}\x1b[0m`)
      return { resolve: { dedupe } }
    },
  }
}
```

Consumer side, committed once:

```js
// vite.config.ts
import { devlink } from '@scope/devlink/vite'
export default defineConfig({ plugins: [devlink({ dedupe: ['solid-js'] }), /* … */] })
```
