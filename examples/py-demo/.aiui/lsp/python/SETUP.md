# LSP setup — python

- **Server:** pyright 1.1.411 (`pyright-langserver --stdio`)
- **Language id:** `python`
- **Extensions:** `.py`, `.pyi`
- **Installed as:** a project-local devDependency (`pyright` in this project's
  `package.json`), so `node_modules/.bin/pyright-langserver` exists after
  `npm install`.

## How the launcher works

`launch` is a committable, **portable** executable. It computes the project root
from its own location — it lives at `.aiui/lsp/python/launch`, three levels down —
and exec's the project's own pyright:

```bash
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec "$ROOT/node_modules/.bin/pyright-langserver" --stdio "$@"
```

No absolute machine paths are baked in, so this works on any clone after
`npm install`. pyright is spawned with the project root as cwd and reads
`[tool.pyright]` from `pyproject.toml` (which points it at the uv-managed `.venv`
so numpy stubs resolve).

## Reproduce / re-verify

- Install servers: `npm install` (in this directory).
- Probe: `cd examples/py-demo && aiui lsp probe python` — expects ✓ on
  `initialize` + `documentSymbol` (pyright advertises no `foldingRangeProvider`,
  so that op is excused).
