# Prompt lowering (intent compilation)

The core idea of this project: capture intent at a **high level of abstraction, in multiple
modalities**, and *lower* it — the way a compiler lowers a high-level language through
intermediate representations — into the kind of prompt a coding agent executes best. All three
layers of the project appear on this page: the lowering mechanism (layer 1) and the intent tools
that feed it (layer 2) in depth, and — briefly — the [instrumented-app
layer](#instrumented-apps-layer-3) that gives lowering something precise to grab onto.

## The idea

A "prompt" to a coding agent today is mostly typed text. But the intent behind it is richer and
cheaper to express in other forms:

- **Audio** — speak, don't type.
- **Screenshots** — "it looks wrong *here*."
- **DOM context** — the actual element, component, and state you're looking at.
- **Pronouns** — this is the key one. Human intent is full of deixis: "make **this** wider",
  "give **it** the same colors as **that** one". Deictic references are nearly free for the human
  and nearly useless to an agent — *unless* something resolves them against the evidence (the
  screenshot, the selected element, the recent conversation).

**Prompt lowering** (or *intent compilation*) is the stage between: a pipeline of utility LLMs
and/or deterministic logic that takes the multimodal bundle and produces a finalized, agent-optimal
prompt — pronouns resolved, evidence attached, phrased the way Claude Code works best.

> A familiar special case: [Wispr Flow](https://wisprflow.ai) lowers one modality (audio) into
> clean text, with nontrivial effort spent denoising the process. This project generalizes that
> move — more modalities in, and a richer target format out — and makes the pipeline inspectable.

### The target is text *and* images

A natural misreading of the compiler metaphor is that the bottom of the pipeline is plain text. It
isn't. **The optimal input format for current coding agents is interleaved text and images.** A
good lowering doesn't flatten a screenshot into a paragraph of description — it keeps the
screenshot (or a crop of it), places it next to the sentence that refers to it, and lets "make
*this* wider" point at actual pixels.

Two consequences follow:

- **Images make delivery genuinely non-trivial.** A lot of this work happens against Claude Code
  running on a remote machine over SSH, where getting an image into the session is anything but
  natural. There are plenty of workarounds; part of the channel's job is to make image delivery
  **first-class rather than a workaround**.
- **The target format will evolve.** Text + images is the optimum *today*. Given richer hooks,
  lowering could go further than message content — for example, **dynamically shaping the tool
  surface** the agent sees for a given task: which tools are available, with what context and
  schemas. "Prompt" lowering is really *input-space* lowering, and the pipeline should be built
  expecting new kinds of targets.

## The mechanism (layer 1)

The infrastructure that makes lowering *deliverable* is a **custom Claude Code channel**:

1. `aiui claude` launches an ordinary interactive Claude Code session, wired with an MCP server
   (`@habemus-papadum/aiui-claude-channel`) that registers itself in a small on-disk registry
   (pid, parent session, port, tag).
2. That server runs a local web backend (HTTP + WebSocket). Intent tools connect to it, send
   multimodal payloads, and stream results.
3. Payloads pass through the lowering stage, and the finalized prompt is injected into the
   *running, interactive* session over the channel — the transcript you're already watching.
   What each captured item (screenshot, selection, navigation boundary, the context preamble)
   actually renders to is cataloged, with real outputs, in the
   [Prompt Rendering Reference](./prompt-rendering).

Utilities like `aiui mcp quick` (send a prompt to a chosen session) and the registry/selector
library exist so tools — and test harnesses — can find and address the right session. See the
[aiui-claude-channel package docs](/packages/aiui-claude-channel/) for details.

## Concrete intent tools (layer 2)

The lowering pipeline needs frontends. The first planned tool is a **browser overlay** for the page
you are developing:

- An overlay you add to your dev page (or inject via extension — [open
  question](/questions)) with a mechanism to **speak** the change you want.
- It captures **screenshots** and interesting **DOM data** — the selected element, its component,
  relevant state — and sends the bundle through prompt lowering to your Claude Code session.
- It is designed to work alongside a **Chrome DevTools MCP server**: the agent can install little
  hooks on global state — giving *itself* debugging handles it can later call to query the live
  app (see [Frontend for Agents](./frontend-for-agents)).
- Inputs and forms get annotated in a superset of
  [WebMCP](https://developer.chrome.com/docs/ai/webmcp), so an agent can interact with the running
  site through declared affordances rather than blind DOM automation.
- Everything stays mindful of hot-module reloading, so the loop survives the very edits it
  triggers.

::: tip Status
The pipeline is live end to end: the **intent client** (`@habemus-papadum/aiui-intent-client` —
the session browser's side panel and the channel-served `/intent/` page, over one mode-engine
core) streams voice, screenshots, ink, and selections through lowering into the session, with
server-side lowering **traces** and a debug viewer over them (embedded in the panel, and
standalone via `aiui dashboard`). Custom per-modality debug views and dynamically shaped tool
surfaces are still open — see [Questions](/questions).
:::

## Instrumented apps (layer 3)

Lowering is only as good as the evidence it can grab, and the third layer makes the **application
itself cooperate**: UI frontend utilities (SolidJS), Claude skills, and MCP techniques (e.g. a
DevTools MCP) that instrument the app under development. With that instrumentation, an intent tool
isn't limited to "take a screenshot" — for a given rectangle it can look up *which components
rendered it and where their source lives*; it can query live state through hooks the agent
installed for itself. That is what makes deictic prompts ("make **this** wider") lower into
something precise.

This ships as its **own JavaScript module, separate from the browser intent tool**: the intent
tool captures intent from any page, while these utilities make *your* app maximally legible to it.
The full treatment — the dataflow style, the debuggability conventions, the deliverables — has its
own page: [Frontend for Agents](./frontend-for-agents).

## A research program, not just a feature

Prompt lowering is an **open research topic**. For every use case there is presumably a lowering
methodology that fits it, and — more interestingly — general abstract patterns that transfer across
domains. A goal of this framework is not merely to *do* prompt lowering but to let someone *study*
it:

- **Inspectable intermediate representations.** Just as a compiler lets you dump the IR between
  passes, the pipeline should let you see each version of the prompt as it moves through lowering
  stages.
- **Data collection.** Instrument the pipeline so real usage produces data about what lowerings
  worked.
- **Debugging tools.** When a lowered prompt goes wrong, you should be able to find *which stage*
  lost the intent.

## The prompts (the surfacing principle)

**Every prompt this system sends is documented** — a lowering pipeline whose own model calls
were secret would be an odd artifact. The live prompts today, and where each is published:

- **The prompt-linter persona** — verbatim in [Prompt Linting](./prompt-linting#the-prompt)
  (`LINTER_INSTRUCTIONS`, `live-session.ts`).
- **The injection label grammar** — `[image shot_N]`, `[selection sel_N: "…" — …]`
  (`updated` / `retracted` variants), `[transcript seg_N: "…"]` — described in
  [Prompt Linting](./prompt-linting#what-the-linter-sees-exactly) and
  [Realtime Live Mode](./realtime-live); the labels are built in `live-resolve.ts` and the
  linter sidecar.
- **The turn summarizer** — each sent turn is glossed for the trace list by `gpt-4o-mini`
  under exactly: *"Summarize this request to a coding agent in one line, ≤ 12 words, no
  quotes."* (`SUMMARY_SYSTEM_PROMPT`, `summarize.ts`; screenshots are stripped and the body
  clipped to 1000 chars before it goes.)
- **The lowered-prompt context wrapper** — the committed body is enclosed in
  `<context>…</context>` sections carrying the tab identity, source hints, and (legacy
  clients) the selection preamble; the shape lives in `prompt-context.ts` and is visible on
  every trace's final stage.
- **The premium ack phrases** — the TTS "sent" confirmation text (`ACK_PHRASES`,
  `intent-v1.ts`).

If a change adds a model call, its prompt belongs in the docs next to the feature it powers.

## Open questions

Deliberately unresolved — documentation stubs for later clarification:

- What are the lowering stages, concretely? Which are utility LLMs and which are plain logic?
- What is the schema of the intermediate representations?
- How is a lowering *evaluated* — what makes one lowering of the same intent better than another?
- Where does lowering run (in the channel server, in the intent tool, in a sidecar)?
- See also the running [Questions](/questions) note.
