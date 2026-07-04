# Introduction

**pdum_aiui** is a [pnpm](https://pnpm.io) + TypeScript monorepo of packages and knowledge for
building scientific UIs in collaboration with AI agents. Packages live under `packages/*` in the
`@habemus-papadum` scope and are versioned in **lockstep** — one shared version across the whole
repo.

This documentation site is organized around the two altitudes the monorepo cares about:

- **Top-level, conceptual docs** — cross-cutting material that spans packages: motivation,
  workflows, design notes. These live at the repo top level under [`docs/`](./) (this section and
  the auto-listed **Notes**).
- **Per-package docs** — one section per package under [Packages](/packages/), each built from that
  package's `README.md`, any hand-written guides in `packages/<slug>/docs/`, and an auto-generated
  **API Reference** extracted from its TypeScript source.

## How the docs stay in sync

The site is generated from the same `packages/*` glob the rest of the repo uses, so **adding a
package requires no changes to any doc config** — its README becomes a page and its exports get an
API reference automatically. See [The Documentation System](./documentation) for how it works and
how to extend it.

## Where to go next

- [Getting Started](./getting-started) — install, build, and serve the docs locally.
- [Packages](/packages/) — the package index and per-package references.
- [The Documentation System](./documentation) — how this site is built and extended.
