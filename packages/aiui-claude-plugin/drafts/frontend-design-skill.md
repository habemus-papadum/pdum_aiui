> **DRAFT — parked for review, loaded nowhere.** This is the proposed full content for the
> `frontend-design` skill. Once approved, fold it back into
> `marketplace/plugins/frontend-design/skills/frontend-design/SKILL.md` (currently an inert stub).

---
name: frontend-design
description: Use when writing or reviewing frontend code in an aiui project (scientific/technical visualization UIs built for an agent-in-the-loop workflow). Work-in-progress — the principles below are a skeleton.
---

# Frontend for agents — design principles (WIP)

The skeleton of the principles this skill will carry. Extraction from the repo's
*Frontend for Agents* guide (docs/guide/frontend-for-agents) is in progress; expect this to grow
concrete rules, snippets, and checkable conventions.

1. **SolidJS 2.0 (beta)** is the component layer.
2. **Observable-style async dataflow in mainstream syntax** — reactive cells and derivations over
   ad-hoc effects and imperative wiring.
3. **Write code your future self (an agent) can debug**: stable source locators, self-installed
   debug hooks, HMR-mindful module state.
4. **Annotate affordances** in a WebMCP-superset form, so tooling (and prompt lowering) can map a
   screenshot region → component → source.

Until this fills out: follow the existing conventions of the project you're editing, and keep
changes small and locally consistent.
