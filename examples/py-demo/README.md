# py-demo

A small, deliberately **cross-referenced** Python project used as a fixture for the
aiui *code reader* tool. It exists so a language server (pyright) run against it has
interesting "go to definition" / "find references" targets: functions and classes are
defined in one module and used from several others, and it depends on a real
third-party package (`numpy`) so import resolution is non-trivial.

## Layout

```
src/pydemo/
  geometry.py   Vec3 + distance/centroid   (foundation)
  mesh.py       Mesh, built on geometry
  stats.py      summary/normalize          (shared leaf)
  signals.py    DSP helpers, uses stats
  pipeline.py   Pipeline, ties everything together
  __main__.py   `python -m pydemo` entry point
```

## Setup

```sh
bash setup.sh   # Python: uv venv + editable install (pulls numpy>=1.26)
npm install     # language servers: pyright + typescript-language-server
```

`setup.sh` uses [`uv`](https://docs.astral.sh/uv/) to create a `.venv` and install
the project, so pyright can resolve numpy's types. `npm install` populates the
`node_modules` that the committed `.aiui/lsp/*/launch` scripts resolve their
language servers from — that pair is what makes "clone + install → working code
reader" true here.

## Run

```sh
uv run python -m pydemo
```

(or, after setup, `.venv/bin/python -m pydemo`).

The `.venv/` directory is gitignored — recreate it any time with `bash setup.sh`.

## Polyglot: TypeScript alongside Python

This fixture is deliberately **multi-language** so the aiui code reader can demo a
_second_ language server (`typescript-language-server`) in the same project root,
next to pyright. The two halves mirror each other in spirit:

```
src/pydemo/      Python  (pyright)
web/src/         TypeScript (typescript-language-server)
  vec3.ts        Vec3 + distance/centroid   (foundation, ~ geometry.py)
  mesh.ts        Mesh, built on vec3        (~ mesh.py)
  signals.ts     movingAverage/fftMagnitude/summary (~ signals.py + stats.py)
  pipeline.ts    Pipeline, ties everything together  (~ pipeline.py)
  index.ts       barrel re-exports + main() entry point
```

The TypeScript is self-contained: it has **no runtime npm dependencies** and only
imports across its own files, so cross-file "go to definition" / "find
references" have real targets. `web/tsconfig.json` uses
`moduleResolution: "Bundler"` (extensionless relative imports) and is
type-clean under strict mode. Typecheck it with the example's own TypeScript
(installed by `npm install` above):

```sh
cd web && ../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

It is typecheck-only — `index.ts`'s `main()` is conceptually runnable via a
bundler but is not wired to a runtime here.
