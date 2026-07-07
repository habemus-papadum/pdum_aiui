# @habemus-papadum/aiui-lsp

Project-local, multi-language LSP subsystem for aiui: a **tested executable-launcher
descriptor format**, a stdio **byte-relay proxy**, and a **self-test probe harness** —
shared by the code reader and the channel, driven by `aiui setup-lsp`.

## The descriptor format

A project's language-server setup lives under `.aiui/lsp/` — **committable**, because
the launchers are **portable** (they resolve their server from the project's own
`node_modules`/venv at runtime, with no absolute machine paths), so a clone + install
yields a working reader with no `aiui setup-lsp` step. A thin `manifest.json` **indexes**
languages to per-language **executable launchers**; the launcher is where all the
complexity (interpreter, env, project flags) lives, so the index stays trivial and the
launcher stays independently testable. (Setups written before the relocation lived under
the gitignored `.aiui-cache/lsp/`; reads fall back there for old checkouts.)

```
.aiui/lsp/
  manifest.json          # { version, servers: [{ language, languageId, extensions, launcher, name?, initializationOptions?, verified? }] }
  python/
    launch               # #!/usr/bin/env bash … ROOT=…; exec "$ROOT/node_modules/.bin/pyright-langserver" --stdio "$@"  (chmod +x)
    SETUP.md             # human-readable record of what/how/why
  typescript/
    launch
    SETUP.md
```

The channel/reader spawn a launcher with the project root as cwd and pipe bytes to the
browser's LSP client. Nothing in the middle understands or rewrites LSP semantics — the
**"no veneer"** constraint (see `docs/proposals/code-reader.md`).

## API

- `ensureDefaultManifest(root, { force?, onLog? })` — detect well-known languages
  (python→pyright, typescript/javascript→typescript-language-server) and write
  launchers + `SETUP.md` + manifest from built-in recipes. Idempotent; returns the
  `LspManifest`. This is what makes the reader work out of the box.
- `detectLanguages(root)`, `PROVIDERS` — the language scanner and built-in recipes.
- `loadManifest(root)`, `validateManifest`, `serverForLanguageId`, `serverForExtension`,
  `languageIdForPath`, `manifestPath`, `lspDir`, `launcherPath` — manifest plumbing.
- `createLspProxy(launch, { onLog?, label? })` — the byte relay. One child process per
  attached socket; `frameMessage` / `createMessageDecoder` handle `Content-Length`
  framing ↔ one JSON message per frame.
- `probeLauncher({ launch, rootUri, sample, ops?, position?, initializationOptions?,
  timeoutMs? })` — the self-test. Runs a real `initialize`→`didOpen`→ops→`shutdown`
  handshake against a launcher and returns a `ProbeReport` (per-op ✓/✗ + server
  capabilities). This is how a launcher is verified **before** it's recorded.
- `writeLauncher`, `writeSetupDoc`, `writeManifest`, `provisionServer` — generation.

## Who uses it

- **`@habemus-papadum/aiui-code`** (the reader) — mounts the manifest, serves
  `/lsp/servers`, and byte-relays each language over `/lsp?lang=…`.
- **`aiui setup-lsp` / `aiui lsp`** — the CLI that lets Claude Code figure out, test
  (`aiui lsp probe`), and record each project's launchers. Well-known languages come
  from the recipes; exotic ones (Julia, Lean 4, C++) get hand-authored, probed
  launchers.

Launchers speak LSP on **stdio** and must pass `probeLauncher` before being recorded.
