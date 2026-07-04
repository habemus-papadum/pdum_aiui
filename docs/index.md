---
layout: home

hero:
  name: pdum_aiui
  text: Scientific UI, built with AI agents
  tagline: A pnpm + TypeScript monorepo of packages and knowledge for building scientific UIs in collaboration with AI agents.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Browse Packages
      link: /packages/
    - theme: alt
      text: Introduction
      link: /guide/

features:
  - title: Conceptual guides
    details: High-level, monorepo-wide documentation lives at the top level under docs/guide and docs/ notes — the big-picture material that spans packages.
    link: /guide/
  - title: Per-package docs
    details: Every package's README becomes an overview page, with any packages/<slug>/docs/*.md guides folded in automatically.
    link: /packages/
  - title: Auto-generated API
    details: TypeDoc extracts a Markdown API reference from each package's TypeScript source, regenerated on every build so it never drifts.
    link: /guide/documentation
---
