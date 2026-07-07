# Proposal: rewrite the dev overlay as a SolidJS widget

Status: **superseded by [solid-rewrite-b2.md](./solid-rewrite-b2.md)** (July 2026), which revises
this plan around the modal-kit extraction (`aiui-viz/modal`) and demotes cells to
where-genuinely-async; kept for the original motivation and constraints. The package was made
*Solid-capable* first (deps + `vite-plugin-solid` + `jsxImportSource`, mirroring `aiui-viz`) so new
components can be Solid `.tsx` today; this doc was the plan to migrate the **existing vanilla
surface** onto the same SolidJS 2.0 + `aiui-viz` principles the rest of the project uses.

## Why

The overlay is the one first-party frontend in this repo written as **hand-rolled vanilla DOM**
(`document.createElement`, manual event wiring, imperative show/hide) inside a Shadow root. That was
expedient for a floating tool surface, but it is now out of step with the project's own thesis:

- **"Frontend for agents"** (`docs/guide/frontend-for-agents.md`) says first-party UIs should be
  SolidJS 2.0, Observable-style async cells, debuggable-by-the-agent's-future-self, with a built-in
  agent tool surface. The code reader (`@habemus-papadum/aiui-code`) and the demo follow this; the
  overlay does not.
- The overlay is exactly the kind of **reactive, multi-state widget** (arming, preview, peers, toasts,
  talk mode, tool bridge status) that the durable/disposable cell model is designed for — today that
  state is threaded by hand through closures and manual DOM updates.
- We want the overlay's own UI to be **inspectable through the same instrumentation it provides to
  apps**: `data-source-loc` stamps, `data-cell` attribution, an `agentToolkit` namespace so a session
  can drive the overlay itself.

Vanilla is not wrong, it is just *inconsistent* — and the overlay is where a newcomer looks to learn
"how does aiui build UI." It should model the principles, not the exception.

## Current surface (what has to move)

Vanilla, in `src/`:

- `overlay.ts` / `intent.ts` — the FAB + panel shell, arming ink layer, prompt preview, toasts.
- `session-bus.ts`, `session-contrib.ts` — the multi-view session bus + contribution model (logic;
  realm-free; mostly stays as-is, consumed by components).
- `tools-bridge.ts`, `instrumentation.ts`, `turn-store.ts`, `drag.ts`, `errors.ts` — supporting logic.
- `intent-pipeline/` — framework-free lowering pipeline (stays framework-free by design).

Node-side (unaffected, stays as-is):

- `vite.ts` — the dev-server plugin. Node code, no JSX; keep it vanilla.
- `source-locator.ts` — the compile-time babel pass.

## Target shape

Follow the frontend-design skill + `aiui-viz`:

- **`model/store.ts`** — durable roots (`durable(...)`): the Shadow host, the bus handle, drag state,
  the arming/preview signals. Survive HMR.
- **`model/graph.ts`** — the disposable cell graph: async work (transcription, correction, lowering
  previews) as `cell(deps, compute)`; published through a durable box.
- **`ui/`** — Solid components for the FAB, panel, preview, peer list, toasts, `SessionPanel`. Render
  into the Shadow root via `render(() => <App/>, shadowRoot)`.
- **Agent surface** — `agentToolkit("aiui_overlay")` (already exists as `overlay-tools.ts`; re-expose
  its operations next to the components).
- **Imperative islands** — the ink/pointer-capture layer stays an imperative island bridged with
  `createEffect`, exactly the pattern the guide prescribes for canvas/WebGL.

## Migration strategy (incremental, island by island)

1. **Solid-capable** — done. `solid-js` + `@solidjs/web` peers, `vite-plugin-solid` in the lib build,
   `jsx: preserve` + `jsxImportSource: @solidjs/web`. Vanilla and Solid coexist: `render()` mounts into
   nodes the existing vanilla code creates.
2. **First Solid island: `SessionPanel`** (this is the reader-integration work). It is self-contained,
   reactive off `reader.selection()`, and has no entanglement with the FAB/ink internals — the ideal
   first component. It ships as a Solid `.tsx` while everything around it stays vanilla.
3. **Panel shell** → Solid: the preview, peer list, toasts become components fed by signals adapted
   from the current bus/turn-store.
4. **FAB + arming/ink** → Solid last: the ink layer becomes an imperative island; the FAB/mode toggles
   become components.
5. Retire the vanilla builders as each island lands; keep the public API (`mountIntentTool`,
   `installSessionBus`, `installToolsBridge`) stable throughout.

## Constraints / risks

- **Shadow DOM + Solid**: `render()` into a shadow root works; styles must stay inside the root
  (adopted stylesheets or a `<style>` in the shadow), same as today.
- **Bundle size**: `solid-js`/`@solidjs/web` are **peers** — a consuming app already ships Solid, so
  the overlay adds no second copy. The overlay is dev-gated and never in a production bundle regardless.
- **Testing**: `vite-plugin-solid`'s transform rewrites `import.meta.url` in a way that breaks the
  pure-Node `.ts` tests, so the lib build enables `solid()` but Vitest currently does not (see
  `vite.config.ts`). Before migrating a component with a test, add a Solid-aware Vitest project (jsdom
  environment + `solid()` scoped to `.tsx`) so component tests and the existing logic tests coexist.
- **`vite.ts` stays vanilla** — it is Node plugin code; do not drag JSX into it.

## Non-goals

- Rewriting `intent-pipeline/` (deliberately framework-free — it runs in workers and node too).
- Changing the wire protocol, the bus, or the plugin's injection contract.
