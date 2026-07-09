# @habemus-papadum/aiui-test-app

**Internal, never published.** A deliberately small SolidJS app for exercising the
[intent overlay](../../docs/guide/intent-overlay.md) and the [channel](../../docs/guide/channel.md)
without the weight of `aiui-demo` (no workers, no DuckDB, no Mosaic, no multi-page routing).

It fits a **mixture of two Gaussians**: draw a sample, bin it, measure it, and recover the
parameters with EM — five computation cells, four widgets, one file of mathematics.

## The graph

```
samples ──┬─→ histogram ──┐
          │               ├─→ curves
          ├─→ moments ──┐ │
          │             │ │
          └─────────────┴─┴─→ fit ─→ (curves)
```

| cell | kind | what it shows off |
| --- | --- | --- |
| `samples` | async, abortable | `ctx.signal` + `ctx.progress`; a slider drag aborts the run in flight |
| `histogram` | sync | a cheap derived cell that only some sliders invalidate |
| `moments` | sync | a second, independent reading of the same upstream |
| `fit` | **async iterable** | one yield per EM iteration — downstream recomputes per partial |
| `curves` | sync | a join of three upstreams; redraws as `fit` streams |

`src/model/mixture.ts` is pure mathematics — no Solid, no aiui, no async. Everything reactive is in
`src/model/graph.ts`; everything visual is in `src/ui/`.

**No cell writes its own `name` or `loc`.** The source-locator babel pass (`aiuiDevOverlay({ locator
})` in `vite.config.ts`) injects both at compile time from the declaration, so `const samples =
cell(…)` registers as `"samples"` and `CellView` stamps `data-cell="samples"`. Writing them by hand
is redundant and goes stale the moment the code moves.

## Run it

The point of this app is to drive the wire without a Claude Code session anywhere in the loop. Two
terminals:

```sh
pnpm test-app:channel   # a standalone debug channel — lowered prompts print to stdout
pnpm test-app           # the app; pick "aiui test app · debug" from the selector
```

The selector always prompts here: a lone **debug** channel never auto-selects (`select.ts`), on the
theory that you should have to say out loud that your prompts are going to a terminal instead of an
agent. To skip it, name the tag — `pnpm test-app --aiui-mcp aiui-test-app`.

Arm the overlay with `` ` ``, say something, press Enter, and the lowered prompt appears in the first
terminal between `--- lowered prompt ---` delimiters. Nothing can reach an agent: the debug server
has no MCP transport at all (see `aiui-claude-channel serve`).

The standalone channel is configured exactly like a session's — `aiui mcp serve` resolves
`channel.bind` and `sidecars.*` from config the same way `aiui claude` does (see
`packages/aiui/src/util/channel-launch.ts`), so it hosts the [iPad paint](../../docs/guide/paint-stream.md)
sidecar on its own port. `aiui paint url` lists it alongside real sessions.

Against a **real** session instead, run `aiui claude` in one terminal and `pnpm test-app` in another;
the selector will offer the real channel.

## Agent tools

Registered under the `testapp` namespace and reachable as `page_tools_*` MCP tools:
`get-params`, `set-params`, `reseed`, plus `cells` and `params` report sections.
