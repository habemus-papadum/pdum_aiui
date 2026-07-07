# LSP setup — typescript

- **Server:** typescript-language-server 5.3.0 (`typescript-language-server --stdio`)
- **Language id:** `typescript` (also serves `.js`/`.jsx`/`.mjs`/`.cjs`)
- **Extensions:** `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- **Installed as:** project-local devDependencies (`typescript-language-server` +
  `typescript` in this project's `package.json`), so
  `node_modules/.bin/typescript-language-server` exists after `npm install`.

## How the launcher works

`launch` is a committable, **portable** executable. It computes the project root
from its own location — it lives at `.aiui/lsp/typescript/launch`, three levels
down — and exec's the project's own server:

```bash
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec "$ROOT/node_modules/.bin/typescript-language-server" --stdio "$@"
```

No absolute machine paths are baked in. In particular there is **no**
`initializationOptions.tsserver.path`: an absolute tsserver path would break
portability. typescript-language-server is spawned with the project root as cwd
and finds this project's own `typescript` (a devDependency) from there. The
TS sources live under `web/` with `web/tsconfig.json`.

## Reproduce / re-verify

- Install servers: `npm install` (in this directory).
- Probe: `cd examples/py-demo && aiui lsp probe typescript` — expects ✓ on
  `initialize` + `documentSymbol`.
