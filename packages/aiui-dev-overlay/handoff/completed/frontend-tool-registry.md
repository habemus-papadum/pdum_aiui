# Handoff: the frontend tool registry → channel custom tools

STATUS (2026-07-05): implemented — /tools ws + PageToolDirectory + page_tools_list/page_tools_call
MCP tools in aiui-claude-channel; tools bridge in aiui-dev-overlay (tools-bridge.ts); agentToolkit
forwards. Follow-up: per-tool dynamic MCP registration.

For the overlay team, from the morphogen/demo session (2026-07-05). The demo
grew a working in-page tool registry that an agent already drives through
`evaluate_script`; this handoff describes it, the pipeline it should become,
and concrete recommendations on the parts we've thought hardest about
(HMR/reload behavior, schema authoring ergonomics). Routing, transport,
multi-tab arbitration, trust, and the "standard location" are yours to decide.

## What exists today (the reference implementation)

`packages/aiui-demo/src/lib/agent-tools.ts` — `agentToolkit(ns)` installs
`window.__<ns>` (one namespace per notebook page: `__morpho`, `__aztec`) with:

- `tools: AgentTool[]` — `{ name, description, params?, inputSchema?, run }`.
  `params` is loose human-readable documentation; `inputSchema` is a real
  JSON Schema (draft 2020-12 object schema) when present — the field intended
  for you to forward.
- `call(name, args)` — dispatch by name, helpful error listing known tools.
- `report()` — one bounded JSON snapshot assembled from pluggable reporters.

Two properties matter and should survive into your design:

1. **Registration is idempotent by name.** A re-evaluated module *replaces*
   its tools instead of duplicating them. This single rule made the registry
   HMR-safe with zero extra machinery — the demo's dataflow module hot-swaps
   its whole graph and simply re-registers.
2. **Tools are registered next to the feature that implements them** (the
   regime-jump tool beside the catalog cell, `analyze` beside the analysis
   cell). The tool surface accumulates as the app grows; it is not a manifest
   maintained elsewhere. Users experience it as ImGui-style co-location.

Real usage: the entire live verification of the demo was driven through this
surface, and the `locate` tool (see the sibling handoff) rides it too.

## The target pipeline (as specified by Nehal)

1. Frontend queries whether the overlay is present; if so, registers its tool
   set: schemas + implementing functions.
2. Overlay presents the schemas to the channel server, which adds them to its
   custom tools list → the Claude session sees real MCP tools.
3. Tool calls flow back: agent → channel → overlay → the page's implementing
   function; result returns the same way.

Everything below is input to your design of those three arrows.

## Recommendation 1 — make registration declarative; make forwarding hashed

The failure mode to design against: dev pages reload constantly (full reloads
and HMR swaps), but the *tool set* almost never changes. The channel/agent
must not see churn.

- **Identity** = (page namespace, tool name). Frontend always re-registers its
  complete set on load and on graph swap — registration is a declaration of
  the current set, not an event.
- **Overlay forwards by content hash.** Canonicalize the schema-relevant
  fields (name, description, inputSchema — NOT the function), hash the set,
  and notify the channel only when the hash changes. A reload with an
  unchanged tool set is then invisible upstream; the MCP tool list never
  flickers. (The channel side may still want a "client generation" counter for
  debugging.)
- **Resolve implementations at call time.** The overlay should hold no
  function references across reloads — route an incoming call to the *current*
  registry entry by name at the moment of the call. Then HMR replacing every
  closure changes nothing observable. A call that arrives mid-reload simply
  fails with "page reloading, retry" — better than invoking a stale closure.
- **Multi-tab routing** is your problem, but note the asset you already have:
  the DevTools extension stamps every dev page with its tab identity
  (`data-aiui-tab`, chromeTabId + CDP targetId — see the extension's
  tab-identity doc). A registration that carries that stamp gives the channel
  everything needed to say "tool X on tab 123456" and gives the agent the same
  correlation hints the intent-tool prompts already use.
- Lifecycle: a page that goes away should age out (heartbeat or
  disconnect-detection on whatever transport you pick) rather than requiring
  explicit unregistration — pages don't get to run code when they die.

## Recommendation 2 — schema authoring: accept JSON Schema; adapt validators

The "how do JS people write tool schemas in 2026" answer, short version:

- **Plain JSON Schema object literals** — zero dependencies, exactly what MCP
  wants, fine for simple tools. This is what the demo's `inputSchema` field
  holds today.
- **TypeBox** — builds JSON Schema directly with static TS types
  (`Type.Object({ F: Type.Number({ minimum: 0 }) })` *is* a JSON Schema).
  Zero conversion, tiny. Good default recommendation for aiui apps.
- **Zod v4 / Valibot / ArkType** — the popular validator ecosystem; Zod v4 has
  built-in `z.toJSONSchema()`. All of these now implement the **Standard
  Schema** spec (standardschema.dev) — a tiny common interface
  (`~standard.validate`) adopted across libraries.

Suggested overlay API posture: accept `inputSchema` as **either a plain JSON
Schema or any Standard Schema** object; if the latter, derive the JSON Schema
(via the library's exporter) for the channel and keep the validator to check
incoming agent args at the boundary before invoking the page function.
Validation is not optional sugar: agent-supplied args are untrusted input into
code that mutates a live experiment.

## Recommendation 3 — the ImGui alignment: derive schemas from what the app already knows

The deeper ergonomic win, prototyped in spirit in the demo and worth making
first-class in the overlay's client API:

- **Parameters: one definition, three derivations.** A scientific app's
  parameters already carry meta for their *sliders* (min, max, step, label).
  Define that meta once —
  `param("F", { min: 0.005, max: 0.09, step: 0.0005, description: "feed rate" })`
  — and derive (a) the slider UI, (b) the `set-F`/`get-params` tool schema,
  (c) the report() entry. The demo currently repeats ranges in `Controls.tsx`
  and in tool descriptions; that duplication is exactly what this kills. It
  also answers HMR: the meta lives with the durable param, so re-derived
  tools are bit-identical across reloads (hash unchanged, nothing forwarded).
- **Named cells auto-derive read tools.** The cell registry (sibling handoff)
  knows every dataflow node's name, state, and definition site. A
  `get-<cell>` tool per registered cell — returning its state + a bounded
  summary of `latest()` — costs nothing to generate and gives the agent read
  access to the whole dataflow for free. Write-tools stay hand-registered
  (mutations deserve intent).
- Keep **imperative escape hatch**: `registerTool({...})` next to a feature,
  as today. The derivations are conveniences layered on the same registry.

## Open decisions (yours)

- Transport between page and overlay (direct window API from the injected
  runtime vs postMessage/CustomEvent handshake), and the availability query
  (`window.__AIUI__.tools?` plus a ready event for late mounts).
- The "standard place": whether the per-page handle stays `window.__<ns>` or
  the overlay owns a single `window.__AIUI__.tools` registry keyed by
  namespace. (Multi-notebook pages want per-page namespaces either way — see
  demo PRINCIPLES §8.)
- Multi-tab arbitration and how tool names are qualified upstream
  (`aztec/set-size` vs a tab disambiguator).
- Trust: does everything auto-forward to the channel, or does forwarding
  require an allowlist/opt-in flag per tool?
- Whether `report()` (the one-call observability snapshot) also gets forwarded
  as a standard tool — we lean yes; it has proven to be the single most useful
  call in agent-driven debugging of the demo.
