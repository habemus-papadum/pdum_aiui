# @habemus-papadum/aiui-registry

The aiui channel registry, single-sourced: the on-disk entry schema (v2), the atomic write API,
liveness with recycled-pid detection, the enriched channel listing every consumer surface
returns, the shared `claude agents` cache (per-client locks, 4 s TTL), and the Chrome
native-messaging host compiled from all of it (`scripts/build-binaries.mjs`, bun `--compile`).

**This package is deliberately special** (see `docs/proposals/aiui-registry.md` in the repo —
design; `aiui-registry-plan.md` — rollout):

- It lives in `bootstrap/`, **outside the pnpm workspace** — own lockfile, own semver, its own
  CI job. The `pnpm-workspace.yaml` here is a boundary marker, not a workspace.
- It is **manually published** to npm (not part of the repo's release pipeline), and the
  workspace consumes it **via npm at a pinned version** — the one place the repo does not run
  on source. Its formats (registry entries, agents cache, native-messaging frames) are a wire
  protocol between independently-installed aiui versions; pinning one implementation is what
  keeps them coherent.
- `PROTOCOL` (stamped on every host response) versions the wire + on-disk formats, separately
  from the package semver.

```sh
pnpm install        # standalone — does not touch the repo workspace
pnpm test           # unit tests
pnpm build          # tsc → dist/
pnpm binaries       # compile the host for all targets (or --target linux-x64)
pnpm smoke dist-bin/aiui-registry-host-<target>   # framed stdio smoke test
```
