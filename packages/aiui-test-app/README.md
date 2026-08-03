# @habemus-papadum/aiui-test-app

**Internal, never published.** A deliberately small SolidJS app for exercising the
intent client and the [channel](../../docs/guide/channel.md)
without the weight of `demos/gallery`.

It fits a **mixture of 2-D Gaussians that you draw**: sketch each component as an
ellipse on the board (centre = mean, shape and tilt = covariance, read as the 2σ
contour), and the app samples the mixture, hex-bins it, and recovers the
components with EM — streaming one iteration at a time, on a JS or WebGPU
backend, in a Web Worker.

## The graph

```
ellipses (drawn) ──→ samples ──┬─→ hexes
                               └─→ fit  (worker: JS or WebGPU)
```

| cell | kind | what it shows off |
| --- | --- | --- |
| `samples` | async, abortable | `ctx.signal` + `ctx.progress`; a new stroke aborts the draw in flight |
| `hexes` | sync | the 2-D histogram (pointy-top hexbin) |
| `fit` | **async iterable** | `fromWorker` streaming — one EM iteration per partial; cancel actually stops the worker |

The drawing surface is a `PencilSurface` (`@habemus-papadum/aiui-pencil`, the
circle demo's instrument): a finished stroke is fitted by its second moments
(`fitStrokeEllipse`) and REPLACED by the ellipse — ink never persists. Drawing
another ellipse while EM runs supersedes the `fit` cell, which posts `cancel`
to the worker: the running computation stops, the typical pattern everywhere
in this framework.

`src/model/mixture2d.ts` is pure mathematics — no Solid, no aiui, no async
(sampling via Cholesky, hexbin, EM with log-sum-exp; unit-tested, including
monotone log-likelihood). `src/model/em.worker.ts` is the thin protocol shell;
`src/model/em-gpu.ts` is the WebGPU E-step kernel (central-moment accumulation
so f32 survives; falls back to JS when no adapter exists — the fit panel
reports which backend actually computed).

**No cell writes its own `name` or `loc`.** The source-locator babel pass (the
`aiui()` plugin in `vite.config.ts`) injects both at compile time from the
declaration, so `const samples = cell(…)` registers as `"testapp/samples"` and
`CellView` stamps `data-cell` on the element that renders it.

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
`packages/aiui/src/util/channel-launch.ts`), so it hosts the standard sidecars on its own port.

Against a **real** session instead, run `aiui claude` in one terminal and `pnpm test-app` in another;
the selector will offer the real channel.

## Agent tools

Registered under the `testapp` namespace via `registerStandardTools` and
reachable as `page_tools_*` MCP tools: `report` / `set` / `locate` derived
from the declarations (controls `testapp/sampleCount`, `testapp/backend`),
plus one named tool per action — `testapp/reseed`, `testapp/clear`,
`testapp/undo`, and `testapp/add-ellipse` (the tool twin of drawing one).
