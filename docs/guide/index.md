# Introduction

**pdum_aiui** is a workflow — and the tooling and knowledge to support it — for rapidly building
scientific and technical visualization UIs with AI agents, in a tight iteration loop. It keeps an
ordinary, *interactive* Claude Code CLI session at the center, and builds a higher-bandwidth way of
prompting on top of it: speak, point, screenshot — and let a lowering layer compile that intent
into the prompt the agent actually receives.

::: danger Before you run anything
This codebase currently launches Claude Code with permissions skipped and injects prompts into the
live session through a custom channel. It is **safer to read than to run** —
see [Read before running](./warning).
:::

## The three layers

**1. Prompt lowering (intent compilation).** A user expresses intent at a high level of
abstraction, multimodally — audio instead of a keyboard, screenshots, DOM context, even pronouns
("make *this* wider"). A pipeline of utility LLMs and intelligent logic *lowers* that prompt, the
way a compiler lowers through intermediate representations, into the form that's optimal for
Claude Code — which today means **interleaved text and images**, not just text — then injects it
into the running session via a custom channel. This is also framed as a
**research area**: the pipeline should expose its intermediate representations for inspection,
like compiler IRs. → [Prompt Lowering](./prompt-lowering)

**2. Concrete intent tools.** The lowering pipeline needs frontends. The first — the
[**web intent tool**](./web-intent-tool), now a working proof of concept — is a widget mounted
over the page you're developing: today a text panel that exercises the whole pipeline; next,
speak the change you want, capture screenshots and DOM data, and send it all through lowering to
your session. It will cooperate with a Chrome DevTools MCP server and annotate the app's
affordances in a superset of [WebMCP](https://developer.chrome.com/docs/ai/webmcp).
→ [The Web Intent Tool](./web-intent-tool)

**3. Frontend code for agents.** Principles, utilities, examples, and workflows — a TypeScript
library plus Claude skills — for the kind of code agents should *write* in this loop: SolidJS 2.0
(beta), Observable-style async dataflow in mainstream syntax, comprehensible to humans even where
it's more tedious than a human would write, and **debuggable by the agent's future self** (source
locators, self-installed debug hooks, HMR-mindful, WebMCP-annotated). This instrumentation is also
what makes lowering *sharp* — it's how a screenshot rectangle resolves to the components and
source behind it. A separate module from the intent tool.
→ [Frontend for Agents](./frontend-for-agents)

## A workflow, not a product

This project is unapologetically optimized for its author's way of working: watching the Claude
Code transcript live, interrupting, dictating instead of typing. You may share the goals and still
prefer a different shape — the [Motivation](./motivation) page tells the honest story so you can
decide. Many parts (channel registry, prompt injection, session discovery, the TUI test harness)
are useful raw material for building your *own* version of this workflow.

## The repo, practically

A [pnpm](https://pnpm.io) + TypeScript monorepo. Packages live under `packages/*` in the
`@habemus-papadum` scope, versioned in **lockstep** (one shared version). The docs you're reading
are generated from the same `packages/*` glob — every package contributes its README, hand-written
guides, and a TypeDoc API reference automatically.

## Where to go next

- [Motivation — a personal workflow](./motivation) — why this exists, in first person.
- [Getting Started](./getting-started) — run the whole loop: session, app, intent tool.
- [Prompt Lowering](./prompt-lowering) — the core idea, mechanism, and research program.
- [The Web Intent Tool](./web-intent-tool) — the first layer-2 tool, designed and working.
- [The DevTools Panel](./devtools) — monitor the channel, the transport, and lowering traces.
- [The Agent's Browser](./chrome) — the shared session browser, Chrome for Testing, profiles.
- [Language Servers](./lsp) — per-project, self-tested LSP setup and `aiui setup-lsp`.
- [The Code Reader](./code-reader) — the LSP-backed reader, hosted inside the session as a channel sidecar.
- [Multi-View Sessions](./multi-view-sessions) — several tabs of one session share arming, the prompt preview, and code selections.
- [Remote Development](./remote) — session on a remote box, browser on yours.
- [Configuration](./config) — config.json: locations, keys, precedence.
- [Frontend for Agents](./frontend-for-agents) — how the code itself should be written.
- [⚠️ Read before running](./warning) — the security posture, plainly.
- [Packages](/packages/) — the package index and per-package API references.
- [Developing pdum_aiui](./development) — working on this repo (docs system: [here](./documentation)).
