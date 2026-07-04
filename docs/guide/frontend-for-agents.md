# Frontend code for agents

The third layer of the project is slightly orthogonal to [prompt lowering](./prompt-lowering), but
it pairs naturally with it: a set of **principles, utilities, examples, and workflows** — ultimately
a TypeScript library plus Claude skills — for writing frontend code that AI agents write well,
debug well, and iterate on fast. The target domain is scientific/technical visualization.

It's more than a pairing, though: an app built this way is *instrumented*, and that
instrumentation is what makes prompt lowering effective. A screenshot stops being just pixels
when, for any rectangle, the tooling can look up which components rendered it and where their
source lives. Architecturally this layer is its **own JavaScript module, separate from the
[browser intent tool](./prompt-lowering#concrete-intent-tools-layer-2)** — the intent tool
captures intent from any page; these utilities make *your* app maximally legible to it.

## The shape of the code

**Async is the norm, so structure the app as a dependency graph.** Scientific UIs are full of
computations that aren't instantaneous — remote data pulls, web-worker jobs, long transforms. The
code wants an Observable-notebook-style dataflow: cells with dependencies, recomputing as inputs
resolve. At the same time it should *not* be a specialized syntax — it should read as mainstream
code.

**The chosen base is SolidJS 2.0 (beta).** Its fine-grained reactivity and first-class async
primitives are the closest mainstream substrate for that dataflow style. The
[solid-cells notes](/reactive-flows/solid-cells-motivation) work through this in detail (with a
[v1](/reactive-flows/solid-cells-solidjs_v1) and a
[SolidJS 2.0](/reactive-flows/solid-cells-solidjs_v2) iteration).

**AI writes it; humans must be able to read it.** Since agents produce most of the code, it can be
more explicit — even more tedious — than a human author would enjoy. That's a fine trade. The hard
constraint is that it stays *comprehensible* to a human reader, because the human is still in the
loop, watching and steering.

## Debuggable for your future self

The agent that writes the code is — for all practical purposes — a later instance of the agent
that will debug it. It should leave itself handles:

- **Source locators.** Use a locator-style plugin to annotate components with their source
  location, so when the user points at something in the running app ("make *this* wider"), the
  agent can go from pixel to file:line without a search.
- **Self-installed debugging hooks.** Knowing it will be connected to a Chrome DevTools MCP
  server, the agent can attach small functions to global state — hooks it can later call to query
  or perturb the live app instead of reasoning blind. See
  [Agentic frontend debugging](/agentic_ui_workflow/agentic_frontend_debugging) and
  [making web workers observable](/agentic_ui_workflow/agent_observable_web_workers).
- **HMR-mindful patterns.** The loop edits the very app being inspected, so state should survive
  hot reloads and the tooling should never fight them. See
  [HMR for agentic coding](/agentic_ui_workflow/hmr_for_agentic_coding).
- **Declared affordances.** Annotate inputs and forms in a superset of
  [WebMCP](https://developer.chrome.com/docs/ai/webmcp), so agents interact with the app through
  declared, typed hooks rather than brittle selector automation.

::: info Open exploration
"What exactly does it mean to write frontend code for your future self?" is a question this
project intends to *explore*, not one it has answered. The bullets above are the current bets; the
[notes](/agentic_ui_workflow/prior_sketches_and_explorations) hold earlier sketches. Expect this
page to change.
:::

## Deliverables

What this layer should eventually ship:

- **Principles** — written up as docs like this one, refined by use.
- **Utilities** — the TypeScript library (dataflow cells, locator/hook helpers, overlay plumbing).
- **Examples** — small scientific UIs built the intended way.
- **Workflows & skills** — Claude skills and plugin tooling that teach an agent these conventions,
  plus environment checks (doctor/setup commands) so a repo can verify its prerequisites.

## Related notes

The gestures that seeded this layer (initial thoughts, not written in stone):
[Desiderata](/desiderata) ·
[Prior sketches](/agentic_ui_workflow/prior_sketches_and_explorations) ·
[solid-cells motivation](/reactive-flows/solid-cells-motivation) ·
[HMR for agentic coding](/agentic_ui_workflow/hmr_for_agentic_coding) ·
[Agentic frontend debugging](/agentic_ui_workflow/agentic_frontend_debugging)
