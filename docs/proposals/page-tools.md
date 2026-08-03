# Page tools: one truth, two projections

*Proposal, 2026-08-03. Ratified in discussion; this document records the decisions
and the implementation plan.*

## The problem, as found live

Opening the gallery with the intent panel attached produced this page-tools
list on the channel:

```
aztec/report, aztec/set, aztec/locate, aztec/aztec/regrow, aztec/gears/reset,
aztec/gratings/resetBench, seismos/aztec/play, gears/gratings/probeFirstOrder, …
```

Two independent defects compound here:

1. **Cross-kit contamination.** `registerStandardTools` derives one tool per
   `action()` by iterating the **global** control surface and registering every
   action on whatever kit it was handed. With one app per document that is
   invisible. In the gallery — N kits, N scopes, one document — every kit
   carries every app's actions: M×N garbage. The `report` tool has the same
   flaw: every kit's report describes every app's controls, cells, and edges.
2. **Cross-tab duplication.** The channel aggregates namespaces from every live
   page verbatim: two tabs carrying `testapp` yield two `testapp/report`
   entries in one flat list, and `page_tools_call("testapp/report")` is
   ambiguous about which page answers.

Stepping back revealed the real design question. There are two kinds of app
(one developed alongside the intent panel; one with the oracle **embedded** in
the app itself — not built yet, coming), two hosting modes (standalone dev
server; composed into a gallery-style shell), and two kinds of tool consumer
(the coding agent via the channel; the oracle/linter via the realtime session).
The design should make all combinations work with **one mechanism**.

## The unifying claim

There is **one truth** — what tools exist on a page, owned by which scope,
and whether their app is currently active — and **two consumer projections**:

- **The agent** (Claude Code, via the channel's `page_tools_list`/`call`):
  sees the full inventory, namespaced, with activity flags. Completeness aids
  reasoning; flags are free.
- **The oracle and the linter** (realtime session, token-priced tools): see
  only the **active** namespaces of the tab in view, re-projected when
  activity flips. Their context is "the thing in view"; a 50-tool projection
  hurts them.

The embedded-oracle app is not a new architecture: it is the oracle consumer
living in the page instead of the panel, reading the same active-only
projection. Standalone vs gallery differ only in *who flips the activity bit*.

## The four decisions

### 1. Kits are declared projections of scopes — no global sweep

A kit serves, by default, **its own scope subtree plus unscoped
declarations**: an entry belongs to `agentToolkit("aztec")` iff its scope is
undefined, `"aztec"`, or `aztec/…`. Composition **declares** anything else:

```ts
registerStandardTools(kit, { scopes: [leftScope, rightScope] });
```

That is the twins shape — a kit named `app` hosting slices scoped
`left`/`right`, whose `kick` actions surface as `left/kick` / `right/kick`
(kit-relative naming already strips only the kit's own prefix). Explicit
declaration beats the rejected alternative (an "orphan scopes adopt into any
kit" heuristic): no kit registry, no mount-order races, no re-sync when a kit
appears late — and it matches the doctrine that *declaring is exposing*.

The same belongs-to-the-kit rule filters the derived `report` (controls,
actions, cells by name prefix, dependency edges) and `set`, so a kit's whole
standard surface describes **its** app, not the document.

### 2. Activity is a first-class flag; visibility policy belongs to the consumer

The page registry (`window.__AIUI__.tools`) carries an `active` bit per
namespace (default **true** — a standalone app never thinks about it). The
`SitePage` contract gains an optional `toolsNs`; a shell that drives
`activate`/`deactivate` (the gallery already does, for pause-not-destroy)
flips the bit for the named namespace in the same breath. An app with its own
client-side routing calls `kit.setActive(…)` itself — same API, its choice of
routing style.

Policies: the agent sees everything with flags; the oracle/linter projections
filter to active. "All tools all the time" vs "tools follow routing" stops
being an architecture question — it is a per-consumer filter over one registry.

### 3. Channel hygiene: per-tab keying, no silent duplicates

The channel keys page tools by **(page, namespace)** internally. The flat
`<ns>/<name>` projection routes a collision to the **active tab's** instance;
the shadowed instance stays enumerable in the ledger, marked shadowed, instead
of appearing as a verbatim duplicate.

### 4. The ledger is a peer of turn preview / oracle preview / prompt history

One event stream (registrations, activity flips, shadowing), three views:

- `window.__AIUI__.tools.ledger()` — the page-side console check.
- A **tools ledger pane** in the intent panel, beside the turn preview and
  prompt history: ns · tool · owning scope · active · shadowed.
- The channel's own view (a `/debug/api/page-tools` route, rendered in the
  console) — what the **agent** actually sees, the ground truth when page-side
  and channel-side disagree.

The organizational implication, deferred deliberately: turn preview, oracle
preview, prompt history, and the ledger want to become a host-agnostic
component family so the embedded-oracle app can mount them. The ledger drives
the extraction; the rest moves when the embedded host exists and pulls.

## Implementation plan

1. **Truth and projection (aiui-viz).** `registerStandardTools(kit, {scopes})`
   with the subtree default, applied to action-derived tools AND
   report/set; registry `active` bit + `setActive`; `SitePage.toolsNs`;
   gallery shell + demo pages + create-aiui template wired; twins declares its
   slices. Multi-kit and composition tests.
2. **Consumer projections + channel hygiene (intent client, channel).**
   `active` + tab provenance ride the descriptor reports; oracle/linter
   projections filter to active and re-project on flips; channel keys per
   (page, ns), routes collisions to the active tab, marks shadowed.
3. **The ledger (page, panel, console).** `ledger()` on the registry; the
   panel pane; the channel debug route + console view.

Each step ships alone; each removes a class of confusion the gallery session
exposed.
