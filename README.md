# pdum_aiui

A UI framework for **agent-written scientific and technical interfaces**: SolidJS 2.0 with
Observable-style async cells, a compile-time pass that gives every component and cell a stable
identity and source location, a derived agent tool surface, and a design system for notebook
pages. Around it, the AI utilities an agent-driven UI needs — structured prompt records, a
realtime voice oracle that drives the page's own controls, GPT-Live sessions with pluggable
delegation backends, and a voice dock that embeds both in any page. And the demos: a set of
scientific notebooks composed into one gallery, published at
**<https://habemus-papadum.net/aiui/>**.

A pnpm + TypeScript monorepo. Packages live under `packages/*` in the `@habemus-papadum` scope,
versioned in **lockstep** (one shared version across the whole repo); every package declares a
publication level when it is created (see [CLAUDE.md](./CLAUDE.md)). The repo root is also a
Claude Code plugin carrying one skill, `aiui-architecture`.

## Requirements

- Node 24.5+ (24.4.0 exactly cannot install the workspace: a Node bug OOMs on one 210 MB tarball).
- pnpm 11+. You do not need corepack: `package.json` → `packageManager` pins an exact pnpm, and
  pnpm 10+ downloads and runs that version for every command in this repo.

## Getting started

```sh
pnpm install
pnpm demo                      # the notebook gallery, every demo on one dev server
pnpm -C demos/morphogen dev    # one demo on its own
pnpm build                     # build every package (Vite library mode + tsc .d.ts)
pnpm test                      # Vitest, repo-wide
pnpm typecheck                 # tsc --noEmit across packages and demos
pnpm lint                      # Biome (lint + format check); `pnpm format` autofixes
```

**Keys.** The demos' voice dock runs on OpenAI. Put `OPENAI_API_KEY` in a root `.env` — the
checked-in `.envrc` exports it through [direnv](https://direnv.net) — and the dev server injects
it into the page for the dock (`aiui({ devKeys: ["openai"] })` in each demo's Vite config). Note
that `devKeys` deliberately places a vendor key into dev-served pages; it is a dev-serve-only
opt-in and never part of a build. A built page takes a pasted key instead.
`demos/motherduck-lab` additionally wants `MOTHERDUCK_BROWSER_TOKEN`.

## Packages

| Package | What it is |
| --- | --- |
| [`aiui-viz`](./packages/aiui-viz/README.md) | The framework: async cells for SolidJS 2.0, controls/actions, durable HMR structure, scopes, worker streaming, the agent toolkit, site pages and cards, Plot/Mosaic/DuckDB porcelain. Its [`docs/`](./packages/aiui-viz/docs) hold the methodology, starting at [frontend-for-agents.md](./packages/aiui-viz/docs/frontend-for-agents.md). |
| [`aiui-source-processor`](./packages/aiui-source-processor/README.md) | The Vite/Babel pass: identity injection for cells/controls/actions, JSX source locators, the dev server's source listing, `devKeys`. |
| [`aiui-design`](./packages/aiui-design/README.md) | The design system: tokens, fonts, a skin for every stable aiui-viz class, the notebook chrome. `DESIGN.md` is the language. |
| [`aiui-slides`](./packages/aiui-slides/README.md) | A deck of viewport slides as an ordinary aiui app: current slide as a control, HUD overview, URL binding, the Lens component. |
| [`create-aiui`](./packages/create-aiui/README.md) | `pnpm create @habemus-papadum/aiui` — scaffolds a starter app with the dual page + card shape. |
| [`aibr`](./packages/aibr/README.md) | Persistent shared browsers and an exec-based launcher for Claude Code and Codex, with per-project selection and pluggable remote discovery. |
| [`aiui-prompts`](./packages/aiui-prompts/README.md) | Structured prompt records: deterministic compilation, provenance, delivery operations, for Node and browsers. |
| [`aiui-prompts-inspector`](./packages/aiui-prompts-inspector/README.md) | Native Solid inspection and compact previews of stored prompt records. |
| [`aiui-prompts-vite`](./packages/aiui-prompts-vite/README.md) | Vite routing and optional source provenance for prompt JSX. |
| [`aiui-oracle`](./packages/aiui-oracle/README.md) | The oracle: a realtime voice control surface (OpenAI Realtime over WebRTC) with the app's cells and actions as tools. |
| [`aiui-live`](./packages/aiui-live/README.md) | GPT-Live sessions with pluggable delegation backends (local tools, hosted Responses, the Claude Agent SDK). Its `docs/` carry the measured findings. |
| [`aiui-dock`](./packages/aiui-dock/README.md) | The voice dock: the oracle and a live session embedded in any aiui page, with the tool log, a key field and a source browser. |
| [`aiui-stt`](./packages/aiui-stt/README.md) | Realtime speech-to-text (ElevenLabs Scribe, OpenAI) behind one component. |
| [`aiui-cf-creds`](./packages/aiui-cf-creds/README.md) | Broker-backed ephemeral credentials for aiui apps. |
| [`aiui-pencil`](./packages/aiui-pencil/README.md) | A pressure/tilt-driven pencil on a raster surface, with a client surface and a `./sidecar` for a host to mount. |
| [`aiui-remote-bar`](./packages/aiui-remote-bar/README.md) | A page's mode-engine command bar projected over a websocket to a remote client; also publishes a `./sidecar`. |
| [`aiui-room-relay`](./packages/aiui-room-relay/README.md) | A host-neutral websocket room relay pairing a browser host with remote clients. |
| [`aiui-util`](./packages/aiui-util/README.md) | The sidecar contract a host mounts, and client-surface serving for sidecar packages. |
| `aiui-build-config` | *Internal, never published.* The one home of the externalize-deps matcher and the Solid-under-Vitest configuration every package shares. |
| `aiui-prompts/spikes/*` | *Internal, never published.* Two prompt-authoring spikes kept beside their future foundation package (`authoring`, `inspector`). |

The two demo-only libraries, `demos/optics` (the scalar-wave engine) and `demos/oscillator` (a
reusable slice), are workspace members too and never published.

## Demos

Every demo runs on its own (`pnpm -C demos/<slug> dev`) and, when it carries the `aiui.sitePage`
marker, appears in the gallery automatically. `demos/gallery` is the shell and the published
site; its [`PUBLISHING.md`](./demos/gallery/PUBLISHING.md) and `publish.sh` are the deploy path.

| Demo | What it shows |
| --- | --- |
| [`morphogen`](./demos/morphogen) | Gray–Scott reaction–diffusion: a WebGL sim island, worker analysis, a history ring. |
| [`aztec`](./demos/aztec) | Random domino tilings and the arctic circle: a streaming shuffle worker. |
| [`seismos`](./demos/seismos) | Earthquakes and the Gutenberg–Richter law: DuckDB-WASM + Mosaic crossfilter, SQL tools. |
| [`circle`](./demos/circle) | How round can you draw a circle? The pencil-package demo. |
| [`gears`](./demos/gears) | Involute gears in kinematic mesh, pure SVG geometry. |
| [`gear-talk`](./demos/gear-talk) | The involute gear as slides — the reference deck for `aiui-slides`. |
| [`gratings`](./demos/gratings), [`holograms`](./demos/holograms) | Diffraction and holography over the shared wave engine in [`optics`](./demos/optics). |
| [`dna-script`](./demos/dna-script) | A shape notation for DNA, where complements interlock. |
| [`wine`](./demos/wine) | Wine reviews on an embedding atlas. |
| [`styleguide`](./demos/styleguide) | Every role, token and component of the design system on one page. |
| [`twins`](./demos/twins) | One [`oscillator`](./demos/oscillator) slice instantiated twice: the composability worked example. |
| [`walkthrough`](./demos/walkthrough) | The frontend playbook built step by step on 1-D diffusion, every layer left standing. |
| [`live`](./demos/live) | The GPT-Live lab: raw wire timing, delegation backends, a voice-driven app. Not in the gallery. |
| [`motherduck-lab`](./demos/motherduck-lab) | The in-tab MotherDuck engine; needs a token, so not in the gallery. |

## Working in the repo

Add a package with a publication level (exactly one flag) or an in-repo demo:

```sh
pnpm new-package my-lib --public      # published publicly as @habemus-papadum/my-lib
pnpm new-package my-lib --private     # published to npm, restricted (needs a paid npm org)
pnpm new-package my-lib --no-publish  # internal-only, never published
pnpm new-demo spectra                 # demos/spectra, on workspace:^ deps, in the gallery
```

Internal dependencies use `workspace:^` and run from source (no build step between edits);
`pnpm test:packaging` guards the published shape, `pnpm test:template` the starter template, and
`pnpm skills:check` the plugin's links. The conventions behind all of this are in
[CLAUDE.md](./CLAUDE.md).

## Releasing

Releases run **entirely in CI** — no local release script, no tag trigger. From the GitHub
Actions UI run the **release** workflow (or `gh workflow run release.yml -f bump=minor`): it
computes the next version from the latest tag, stamps every manifest, publishes to npm, cuts a
GitHub Release and deploys the gallery; `canary=true` publishes a prerelease under the `canary`
dist-tag and stops. Between releases the tree carries an `X.Y.Z+dev` version, which npm rejects,
so a stray publish cannot overwrite a released one. The guardrails are in
[AGENTS.md](./AGENTS.md).

## Layout

```
packages/*               the published libraries (one lockstep version)
demos/*                  the notebooks, the gallery shell, and two demo-only libraries
docs/proposals/          finished proposals, kept as a record (status in each header)
skills/aiui-architecture the one skill of the repo-root Claude plugin (.claude-plugin/)
scripts/                 versioning (CI-managed), new-package / new-demo, the packaging and
                         template gates, npm name reservation, the skill-link check
.github/workflows/       ci.yml (gate) + release.yml (publish + gallery deploy)
```
