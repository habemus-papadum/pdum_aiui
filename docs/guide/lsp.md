# Language Servers

The [code reader](/packages/aiui-code/) shows real, cross-file navigation — go-to-definition,
find-references, hover, outline — backed by genuine language servers speaking undiluted
[LSP](https://microsoft.github.io/language-server-protocol/). To make that work across a project's
languages without you hand-configuring anything, aiui keeps a **project-local, tested LSP setup**
and lets Claude Code build it for you.

The design constraint is **"no veneer"**: the browser runs a real LSP client, the backend is a
byte relay (`Content-Length`-framed JSON-RPC ↔ one JSON message per websocket frame), and nothing
in the middle understands or rewrites LSP semantics.

## The descriptor: an index of executable launchers

A project's deliberate setup lives under `.aiui/lsp/`, and it is **committable**: the launchers
are **portable** — each resolves the project root from its own on-disk location and its server
from the project's own `node_modules`/venv, with no absolute machine paths — so a clone + install
yields a working reader with no `aiui setup-lsp` step. The key decision: the on-disk record is an
**index of executable launchers**, not a config blob. A thin `manifest.json` maps each language to
a per-language `launch` script; the launcher is where all the real complexity lives (which
interpreter, which env, which project flags), so it's independently runnable and independently
testable. Each language also gets a human-readable `SETUP.md`.

There is a second home, split by provenance: with **no** setup at all, opening the reader
auto-bootstraps recipe launchers for the well-known languages into the **gitignored**
`.aiui-cache/lsp/` — the reader works out of the box, and merely opening it never dirties your
working tree with generated, untested files. A deliberate act (`aiui setup-lsp`,
`aiui lsp provision`) records the committed `.aiui/lsp/` setup, which then takes precedence.

```
.aiui/lsp/
  manifest.json          # languages → launcher + extensions + initializationOptions + verified
  python/
    launch               # executable, portable; ROOT=…; exec "$ROOT/node_modules/.bin/pyright-langserver" --stdio "$@"
    SETUP.md             # what the server is, how it was installed/configured, probe results
  typescript/
    launch               # exec "$ROOT/node_modules/.bin/typescript-language-server" --stdio "$@"
    SETUP.md
```

The channel (and the reader's dev server) read the manifest at startup, spawn each launcher with
the project root as cwd, and relay bytes to the browser. A launcher must speak LSP on **stdio**.

## `aiui setup-lsp`: let Claude figure it out

Rather than make you write launchers, `aiui setup-lsp` launches an interactive Claude Code session
seeded to run the **setup-lsp skill**. Claude detects the project's languages, provisions the
well-known ones from built-in recipes, **hand-authors** launchers for the exotic ones, **tests
every launcher before recording it**, and writes the manifest + `SETUP.md` for you to review.

```sh
aiui setup-lsp          # interactive: Claude configures this project's language servers
```

The self-test is the point — you should never be left debugging a silently-broken LSP. Claude has
a probe tool that runs a real handshake against a launcher and reports per-operation results;
a launcher whose probe fails is fixed and re-probed, never recorded.

```sh
aiui lsp list                     # show the configured servers + verified status
aiui lsp provision [--force]      # quick path: write recipe launchers for python / js·ts
aiui lsp probe <language> [--file <path>] [--position L:C] [--json]
```

`aiui lsp probe` prints one row per operation — `✓` supported, `○` excused (the server never
advertised that capability; pyright, for instance, has no folding-range provider), `✗` a real
failure — and exits non-zero if the launcher is broken.

## Built-in vs. hand-authored

Two languages have **built-in recipes** — `python` (pyright) and `typescript`/`javascript`
(typescript-language-server) — so the reader works out of the box: opening a project with no
manifest auto-provisions them into the gitignored `.aiui-cache/lsp/` (run `aiui lsp provision` to
record a committed setup instead).

Everything else is hand-authored by the setup skill, which carries concrete guidance for:

- **Julia** — `LanguageServer.jl`, launched via `julia --project=@. -e 'using LanguageServer; …'`
  (needs the package installed in an environment; slow to cold-start, so probes get a generous
  timeout).
- **Lean 4** — `lake serve` from the project root (needs a `lakefile` / elan toolchain).
- **C++** — `clangd`, pointed at a compile database (`compile_commands.json`, e.g. from CMake
  `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`).

Because a launcher is just an executable that speaks LSP on stdio, adding a language is "write a
script, probe it, record it" — no format to extend.

## In the reader

The reader learns the configured servers from the backend's `/lsp/servers` route and holds **one
LSP client per language**, connected lazily when a file of that language is first opened — a `.py`
file routes to pyright, a `.ts` file to tsserver, through one Monaco editor and one set of
providers. The status bar shows a chip per server with its live connection status; the current
file's language is highlighted.

The mechanics — descriptor format, byte-relay proxy, and probe harness — live in
[`@habemus-papadum/aiui-lsp`](/packages/aiui-lsp/), shared by the reader and the channel.
