# LSP setup — typescript

- **Server:** typescript-language-server 5.3.0
- **Language id:** `typescript`
- **Extensions:** `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- **Provisioned:** 2026-07-07T15:17:04.727Z (built-in recipe)

The launcher next to this file (`launch`) is an executable that speaks LSP on
stdio. The channel/reader spawns it with the project root as cwd and pipes
bytes to the browser's LSP client — nothing rewrites LSP semantics.

Re-run `aiui setup-lsp` to re-provision, add languages, or replace this with a
hand-tuned launcher (e.g. to activate a venv or point at a compile database).
A setup under `.aiui-cache/lsp/` was bootstrapped automatically and is
gitignored; `aiui lsp provision` records a committed one under `.aiui/lsp/`.
