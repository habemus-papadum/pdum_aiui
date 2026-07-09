# an aiui starter app

This directory was scaffolded by `create-aiui`. It is the user's sandbox: a SolidJS 2.0 (beta)
app wired for the aiui loop, whose visible content — the banner, the rose — is **placeholder
scenery meant to be replaced** the moment the user describes the app they actually want. Be bold
about rebuilding the page (the banner included); be careful about the wiring underneath.

Ground rules:

- **Don't remove the integration.** The `aiuiDevOverlay()` plugin in `vite.config.ts` mounts the
  intent tool and connects it to this session's channel; its `locator` option stamps JSX with
  `data-source-loc` and injects `cell()` identities. The loop stops working without it.
- **Keep the architecture's split.** `src/model/store.ts` holds the *durable roots* (signals
  created via `durable()` — they survive hot edits; the user's interaction state is the most
  precious thing in the HMR contract). `src/model/graph.ts` is *disposable logic*: the cell
  graph, rebuilt over the roots on every hot edit, plus the agent tools registered next to the
  capabilities they expose. UI components in `src/ui/` are freely hot-swappable. New state goes
  in store.ts; new dataflow goes in graph.ts as `cell()`s rendered through `CellView`.
- **Keyboard interactions go through the modal kit** (`@habemus-papadum/aiui-viz/modal`, wired in
  `src/model/modal.ts`): modes as a `ModeTable` row (with its Esc ladder), keys as bindings in a
  `KeyLayer`, mode-dependent surfaces asserted by the reconciler. Never scatter ad-hoc
  `addEventListener("keydown", …)` calls — extend the table and the layers.
- **Expose what you build.** When you add an operation the user can do, register a matching
  agent tool in `graph.ts` (`agentToolkit`) so your future self can drive and inspect it.
- The dev server runs via `npm run dev` (which is `aiui vite dev` — it injects the channel port
  as `VITE_AIUI_PORT`). Plain `vite` also serves the app, but the intent tool won't find the
  channel.
- This is a standalone git repo scaffolded for the user; commit freely — history here belongs to
  their sandbox and goes nowhere else.

Methodology docs (concepts, design choices, hard-won details):
<https://habemus-papadum.github.io/pdum_aiui/guide/frontend-for-agents>
