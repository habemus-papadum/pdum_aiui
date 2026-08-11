---
layout: home

hero:
  name: pdum_aiui
  text: Scientific UI at the speed of intent
  tagline: Speak, point, screenshot — a prompt-lowering layer compiles high-level multimodal intent into agent-ready prompts and injects them into your live Claude Code session.
  actions:
    - theme: brand
      text: Why this exists
      link: /guide/motivation
    - theme: alt
      text: Introduction
      link: /guide/
    - theme: alt
      text: Browse Packages
      link: /packages/

features:
  - title: Prompt lowering
    details: Intent compilation — multimodal prompts (voice, screenshots, DOM context, even pronouns) lowered through inspectable stages into the form a coding agent executes best.
    link: /guide/prompt-lowering
  - title: Intent tools
    details: Frontends for the lowering pipeline — the intent client, a side panel (and plain page) that drives the page you're developing, capturing what you say, see, and point at.
    link: /guide/intent-panel
  - title: Frontend for agents
    details: Principles, utilities, and Claude skills for agent-written scientific UI — SolidJS 2.0, async dataflow, and code that's debuggable by the agent's future self.
    link: /guide/frontend-for-agents
---

## What is this?

A workflow for building technical visualization software with AI in a **tight iteration loop** —
keeping an interactive Claude Code CLI session (and its transcript) at the center, while raising
the level of abstraction at which you prompt it. Think of
[Wispr Flow](https://wisprflow.ai) — audio lowered to clean text — generalized on both ends: more
modalities in, and a richer target out (current coding agents do best on **interleaved text and
images**, not just text), with the lowering pipeline itself open for
[research](/guide/prompt-lowering#a-research-program-not-just-a-feature).

::: danger Safer to read than to run
This code launches Claude Code with permissions skipped and pipes externally-supplied prompts into
the live session by design. Understand [what you'd be trusting](/guide/warning) before running it —
for most people, the right use of this repo is as **reference and parts** for building their own
system.
:::

## What the intent panel does

The [intent panel](/guide/intent-panel) is where the loop happens. Its features, each a section
of the panel reference:

- **[Push-to-talk dictation](/guide/intent-panel#dictation--the-transcription-engines)** — three
  streaming engines (ElevenLabs Scribe v2, GPT-4o Transcribe, Realtime Whisper), a per-word
  confidence heat map, and word-timestamp anchors that place screenshots exactly in the prose.
- **[Shots, screen share, and selections](/guide/intent-panel#shots-share-and-selections)** —
  deliberate captures, a share whose sampled frames *are* screenshots (smart interaction-gated
  cadence or clockwork), and source-attributed selections.
- **[The prompt linter](/guide/intent-panel#the-prompt-linter)** — an on-demand realtime
  observer that checks the briefing you're composing (transcription vs. intent, unresolvable
  references, described-but-never-shown) and can read files to verify before flagging.
- **[The oracle](/guide/intent-panel#the-oracle)** — a realtime voice assistant holding the
  focused app's tools; talk to the app, and to the panel itself.
- **[The pencil](/guide/intent-panel#the-pencil)** — markup over the live page, locally or from
  an iPad on the LAN.
- **[The remote bar](/guide/intent-panel#the-remote-bar)** — arming and dispatch from another
  device.
- **[Page tools](/guide/intent-panel#page-tools)** — the app's own scope-owned toolkit,
  surfaced to the agent with an activity bit and a call ledger.
- **[VS Code jump](/guide/intent-panel#vs-code-jump)** — a click on the page lands in the
  authoring source.
- **[The trace debugger](/guide/intent-panel#the-trace-debugger)** — every lowering run's
  intermediate representations, model calls, and per-response cost, embedded in the panel and
  at `/__aiui/debug`.
