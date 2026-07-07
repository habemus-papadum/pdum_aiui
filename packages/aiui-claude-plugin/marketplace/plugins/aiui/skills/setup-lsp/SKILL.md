---
name: setup-lsp
description: Use when setting up (or repairing) language servers for a project so the aiui code reader and channel can offer LSP features — hover, go-to-definition, document symbols. Detects the project's languages, provisions or hand-authors a portable, committable executable stdio launcher per language under .aiui/lsp/, tests each with a real LSP handshake, and records only servers that pass. Triggered by `aiui setup-lsp`, the `/aiui-setup-lsp` command, or a user asking to configure/fix LSP for this project.
---

# Set up language servers for this project

Your job: give this project a working, **tested** language-server setup under
`.aiui/lsp/`. The channel and code reader spawn a per-language **launcher** (an
executable shell script that speaks LSP on stdio) and byte-relay JSON-RPC to the
browser. A thin `manifest.json` indexes those launchers. The hard,
project-specific part (venv activation, compile databases, toolchains) lives in
the launcher — which you write and **prove works before recording it**.

Never record a server whose probe fails. A launcher that isn't tested is not
done.

## The layout you're producing

```
.aiui/lsp/
  manifest.json          # thin index → LspServerEntry[]
  <lang>/launch          # executable, #!/usr/bin/env bash, resolves ROOT then exec's <server> --stdio "$@"
  <lang>/SETUP.md        # human record: what/how installed, config, probe results
```

`.aiui/lsp/` is **committable**, and that is the point: write **portable**
launchers (resolve the server from the project itself, no absolute machine
paths) so a clone + install yields a working reader with **no** `aiui setup-lsp`
step. Do not write into `.aiui-cache/lsp/` (gitignored) — that is where the
reader's *automatic* bootstrap lands so it never dirties the working tree; your
deliberate, probe-tested setup goes under `.aiui/lsp/`, which takes precedence.
Make sure `.aiui/` is tracked (not caught by a `.gitignore` `.aiui*` glob).

## Your tools (`aiui lsp …`)

- `aiui lsp list` — show the current manifest (or "no LSP configured").
- `aiui lsp provision [--force]` — write tested-recipe launchers for **well-known
  languages** (python → pyright, typescript/javascript → typescript-language-server)
  and index them. This is the fast path; still probe afterward.
- `aiui lsp probe <language> [--file <relpath>] [--position line:col] [--json]` —
  the **self-test**. Spawns the launcher, runs a real `initialize → didOpen →
  documentSymbol/hover/foldingRange` handshake (adds `definition`/`references`
  with `--position`), prints ✓/✗ per op, and **exits non-zero on failure**. Run
  this against every launcher.

All three operate on the current working directory as the project root.

## Steps

### 1. Detect the project's languages

Look at file extensions and build files:

- **python** — `pyproject.toml`, `requirements.txt`, `setup.py`, `.py` files
- **typescript/javascript** — `package.json`, `tsconfig.json`, `.ts`/`.tsx`/`.js` files
- **julia** — `Project.toml`, `.jl` files
- **lean 4** — `lakefile.lean` / `lakefile.toml`, `lean-toolchain`, `.lean` files
- **c++** — `CMakeLists.txt`, `compile_commands.json`, `.cpp`/`.hpp`/`.cc` files

List every language you'll try to configure, and note the ones you're skipping.

### 2. Well-known languages: provision

Run `aiui lsp provision`. It writes **portable** recipe launchers for python
(pyright) and typescript/javascript (typescript-language-server) under
`.aiui/lsp/` and indexes them. Each launcher resolves its server from the
**project's own** `node_modules/.bin` at runtime — so the project must have the
server as a dependency. If a server isn't installed, add it to the project (e.g.
`pnpm add -D pyright`, `pnpm add -D typescript-language-server typescript` — or
`npm install` in a non-workspace subproject) and re-run
`aiui lsp provision --force`.

Then **probe each one** (step 4).

### 3. Other languages: hand-author a launcher

For a language `provision` doesn't cover, create an **executable, portable**
launcher at `.aiui/lsp/<lang>/launch`. Compute the project root from the
script's own location (the launcher lives three levels down at
`.aiui/lsp/<lang>/launch`) and resolve everything relative to it:

```bash
#!/usr/bin/env bash
# aiui LSP launcher — <lang>.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec "$ROOT/node_modules/.bin/<server-bin>" --stdio "$@"
```

`chmod +x` it. **Never bake in absolute machine paths** — no
`/opt/homebrew/...node`, no `/Users/...`, no `.pnpm` store paths — because the
setup is committed and must work on any clone. Resolve the server **from the
project**: an npm server from `"$ROOT/node_modules/.bin/<bin>"`, a Python venv
server from `"$ROOT/.venv/bin/<bin>"`, otherwise a binary on `PATH`. Use `node`
from `PATH` (the `.bin` shim already does). Point any project-specific paths at
`$ROOT/...` too. Concrete guidance:

- **Python** (`pyright`): add `pyright` to the project, then:
  ```bash
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  exec "$ROOT/node_modules/.bin/pyright-langserver" --stdio "$@"
  ```
  (pyright reads `[tool.pyright]` / the project's venv from its cwd = `$ROOT`.)
- **Julia** (`LanguageServer.jl`): install the package into the project's `@.`
  environment, then:
  ```bash
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  exec julia --startup-file=no --project="$ROOT" -e 'using LanguageServer; runserver()' "$@"
  ```
  It needs `LanguageServer` available in that environment, and it can be **slow
  to start** — probe with a generous timeout.
- **Lean 4** (`lake serve`): from a project with a `lakefile` and an elan
  toolchain, the launcher runs (cwd is the project root):
  ```bash
  exec lake serve "$@"
  ```
- **C++** (`clangd`): clangd needs a **compile database**. Generate
  `compile_commands.json` into a project-relative build dir (for CMake, configure
  with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`), then point at it via `$ROOT`:
  ```bash
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  exec clangd --compile-commands-dir="$ROOT/build" "$@"
  ```

For any other language, find its standard LSP server, install it into the
project, and wrap it the same way: executable, **portable** (project-relative,
no absolute machine paths), speaking LSP on **stdio**.

### 4. Test every launcher

Run `aiui lsp probe <language>` for each. It must exit 0 with ✓ on `initialize`
and `documentSymbol` at minimum. If it fails, read the printed log, fix the
launcher (wrong path, missing dependency, wrong flags, missing compile db), and
re-probe. Some servers (Julia especially) are slow to cold-start — the probe
already allows a generous timeout, but if a server needs more, note it.

**Do not record a server whose probe fails.** Fix it or skip it.

### 5. Update the manifest

Make sure `.aiui/lsp/manifest.json` lists every **working** server. Each entry
has: `language`, `languageId`, `extensions` (dot-prefixed, e.g. `.py`),
`launcher` (relative, e.g. `julia/launch`), `name`, `doc` (e.g. `julia/SETUP.md`),
optional `initializationOptions`, and a `verified` block from the probe
(`{ at, ops, ok }`). Keep the manifest **thin** — it's an index; the complexity
belongs in the tested launcher. Keep `initializationOptions` **portable** too:
never store an absolute path there (e.g. don't pin `tsserver.path` — let
typescript-language-server find the project's `typescript` from its cwd).
`provision` writes valid entries for the well-known languages; add hand-authored
ones alongside them.

### 6. Write/refresh each `<lang>/SETUP.md`

A human-readable record so the user can review the setup: what the server is, how
it was installed, how the launcher is configured, which project-specific options
were chosen (venv, compile-db path, toolchain), and the probe results. Keep it
honest — this is the doc the user reads to understand and trust what you did.

### 7. Summarize

Tell the user: which languages were configured (with server names), which were
skipped and why (server not installed, no compile db, etc.), and how to re-run
(`aiui setup-lsp`, or `aiui lsp provision` / hand-editing a launcher then
`aiui lsp probe <language>`).

## Reminders

- The launcher must be **executable**, **portable** (resolve `ROOT` from its own
  location and the server from the project — no absolute machine paths, since
  `.aiui/lsp/` is committed), speak LSP on **stdio**, and be **probe-tested**
  before it's saved. After writing one, grep it for `/Users/`, `/opt/`, `.pnpm`,
  or an absolute node path — there should be none.
- Keep the manifest an index only. No server-start logic, and no absolute paths,
  in JSON.
- If nothing is configurable (no recognized languages, no installable servers),
  say so plainly rather than recording something untested.
