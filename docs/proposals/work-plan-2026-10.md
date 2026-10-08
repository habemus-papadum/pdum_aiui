# Work plan, October 2026: four tranches, in order

The voice model's capability list, two page tools (the page as text, the source as text),
the voice dock on every page, and the Solid 2.0 release-candidate upgrade.

Status: **PLANNED 2026-10-08**, after milestone 5 of [tool-docs](./tool-docs.md) closed
with both voice checks passing. The owner asked for one plan covering five observations
from that run (a session-config oddity, page text with TeX, source access that survives a
production build, every demo driveable by voice without the intent panel, and Solid 2.0),
to be worked **sequentially, Solid last**. Every "what exists" claim below was read from the
code on 2026-10-08 and cites the file. Decisions follow the house rule — simplest, least
churn — and each tranche is shippable alone.

| # | Tranche | Size | Lands as |
| --- | --- | --- | --- |
| 0 | [The voice model's capability list](#0-the-voice-models-capability-list) | hours | one commit on main |
| 1 | [Two page tools: `read-page` and `source`](#1-two-page-tools-read-page-and-source) | 2–3 days | three commits on main |
| 2 | [The voice dock, on every page](#2-the-voice-dock-on-every-page) | 4–5 days | a new package, five commits |
| 3 | [Solid 2.0 RC](#3-solid-20-release-candidate) | 1–2 days | a branch, merged direct when green |

## 0. The voice model's capability list

**What the owner saw.** The live demo's "session config (as sent)" fold shows, under
`Delegation policy:`, a hand-written `Backend tools:` list ("App control: … ; Analysis: read
the app's source code …") rather than the per-tool list milestone 5 derives from the tool
array. Both pasted configs are correct as built: the first (`delegation.type: "client"`) is
what the browser-key, server and Claude backends send — the voice model's instructions only;
the second (`delegation.type: "responses"`, model `gpt-5.6-terra`) is **hosted** mode, where
the session appends the full `Tools:` section to the vendor-run backend's instructions
(`packages/aiui-live/src/session.ts:511-520`). If that second config was showing while the
*claude* button was lit, the fold was stale — a small bug to check first.

**Why the list is hand-written.** `composeWire` derives `backendTools` only when the slots
leave it unset (`session.ts:501-509`), and the app page's `LIVE_SLOTS` sets it
(`demos/live/src/live/prompt.ts:16-17`). The authored text says something the tool array
cannot: "Analysis: read the app's source code" is a Claude-backend ability, not a page tool.

**Decision.** The slot becomes a *preface*, never a replacement: `composeWire` renders the
authored lines first, then the derived one-sentence-per-tool list beneath, always from the
same tool array in the same call (the sync rule). The demo's slot keeps the Analysis line and
drops the App-control line, which is now derived. One test in `session.test.ts` (slot set →
both present, in that order; slot unset → derived alone), one golden update in
`demos/live`, a sentence in `packages/aiui-live/README`. Check the stale-fold question in
`Bench.tsx` while there (the `<pre>` reads `session().sessionConfig()`; a backend switch
that does not rebuild the session keeps the old config on screen).

## 1. Two page tools: `read-page` and `source`

Both are **standard tools** — registered by `registerStandardTools`, so every aiui app has
them, documented with `usage` and `kind: "read"` like `report`/`set`/`locate`.

### 1a. `read-page`: the page as text, math as TeX

**What exists.** There is no page-text extractor anywhere (the closest things are `locate`'s
40-character `textContent` per element, `standard-tools.ts:291`, and the intent editor's
paste converter `htmlToMarkdown`, `aiui-intent-client/src/edit/html-md.ts`, which knows no
math). TeX recovery exists once, unexported: `texOf()` in
`packages/aiui-intent-runtime/src/selection.ts:105-117` reads the nearest `[data-tex]`
stamp, else a KaTeX `annotation[encoding="application/x-tex"]`. Every demo that renders math
does it through aiui-viz's `TeX` component (`src/site/tex.tsx:26-36`), which wraps
`katex.renderToString` in `span.math-inline` / `div.math-display` carrying `data-tex` —
seismos, morphogen, gratings, holograms, aztec, circle. Nothing in the repo uses MathJax.
Surprise recorded: the plain-page (CDP) intent tier's selection handler returns no `tex`
at all (`cdp/page-script.ts:359-367`); only the extension's content script recovers it.

**Design.**
- A framework-free module, `packages/aiui-viz/src/page-text.ts`, on its own subpath
  `@habemus-papadum/aiui-viz/page-text` (the `tool-brief` pattern): `pageText(root,
  options)` walks the DOM with a TreeWalker and emits Markdown-shaped text — `#` headings by
  level, paragraphs, `-` list items, pipe tables, fenced `pre`/`code`, links as their text,
  images as `[image: alt]`. Math: an element with `data-tex` emits `$…$` (inline) or `$$…$$`
  (`.math-display`); a bare `.katex` falls back to its annotation. Skipped: `script`, `style`,
  `noscript`, `[aria-hidden="true"]` (which is how KaTeX's duplicate HTML half disappears),
  anything `checkVisibility()` says is hidden, and the page's own agent chrome
  (`.aiui-toollog`, the dock — a `data-aiui-chrome` attribute both carry).
- The tool: `read-page { selector?, maxChars?, offset? }` → `{ text, chars, truncated,
  headings: [{ level, text }] }`. Default budget 16 KB, cap 64 KB, `offset` to page
  through; `selector` narrows to a region (the agent gets selectors from `locate`). Usage
  text: "Read the page the user is looking at — prose, numbers, and every equation as TeX.
  Start with the headings, then narrow with selector."
- `texOf` moves: the viz module exports `texOfElement`, intent-runtime's `texOf` becomes a
  re-export (intent-runtime already depends on viz? — verify; if not, the two stay as one
  copied function with a comment naming the other, like `cacheDir`). The CDP page script
  stays dependency-free, so its selection handler gets the same ten lines inlined — that
  closes the recorded gap for the plain-page tier in the same commit.
- Tests: jsdom fixtures for headings/lists/tables, KaTeX markup with the stamp, display vs
  inline, hidden and aria-hidden pruning, the budget and `offset`, the chrome exclusion.

### 1b. `source`: the app's source, in dev and in a production build

**What exists.** `data-source-loc` stamps are compile-time (`aiui-source-processor`, the
locator pass with `enforce: "pre"`, `source-locator.ts:554-561`); JSX stamping defaults to
serve only (`stampJsx: command === "serve"`, `:558`), factory identity (`cell`, `control`,
`action`, `selectionDim` locs) always runs and survives builds. `window.__AIUI__.sourceRoot`
is seeded only under serve (`index.ts:92-113`) with the Vite root as an absolute machine
path. `locate` returns tag, 40 chars, the closest loc, the closest cell — never file text
(`standard-tools.ts:280-296`). Nothing fetches raw source; the gallery's production build
emits no sourcemaps (`publish.sh:68`, plain `vite build`). Surprise recorded, unverified
live: in **gallery dev** the demos' sources sit outside the gallery's Vite root, and files
outside the root get factory identity but no JSX stamps (`source-locator.ts:571-577`) — the
published site's dev loop may be attribution-blind. Verify first; the fix is to stamp with
root-relative `../seismos/src/…` paths, which Vite's `/@fs/` serves.

**Design.**
- The tool: `source { file, from?, to? }` → `{ file, from, to, total, text }` with numbered
  lines, default 200 lines, cap 32 KB. `file` is exactly what `locate`, `report { format:
  "full" }` and the stamps already say (`src/ui/App.tsx:42` → `src/ui/App.tsx`), so the
  agent never has to join paths.
- Where the text comes from, decided per page by one field:
  - **dev**: `import(/* @vite-ignore */ "/@fs" + sourceRoot + "/" + file + "?raw")` — Vite's
    raw loader serves any workspace file as a string module; the page already knows
    `sourceRoot`.
  - **prod**: `window.__AIUI__.sources = { base: "/__aiui/src/", files: [...] }`, present
    only when the build shipped its sources (below); the tool fetches `base + file`.
  - neither → `{ error: "this build carries no source" }`.
- Shipping sources: one plugin option, `aiui({ sources: "ship" })`. The locator's
  `transform` hook already sees every module id; the plugin collects the ids under the
  project (or workspace) root outside `node_modules`, and at `generateBundle` emits each as
  `__aiui/src/<root-relative path>` plus `__aiui/sources.json`, and seeds `__AIUI__.sources`
  into the HTML. With it, `stampJsx: true` keeps the JSX stamps in the build and the
  `sourceRoot` option (already accepted by the seed) takes a URL — for the gallery,
  `https://github.com/habemus-papadum/pdum_aiui/blob/main/` — so `locate` answers in prod
  link somewhere a person can click. The gallery's vite config turns all three on; the
  template does not (an app's source is the owner's call; the option is one line away and
  the template's `CLAUDE.md` says so).
- Policy to confirm with the owner: shipping sources publishes them. For the gallery that is
  a public repo's code on a public site; for a scaffolded app it stays off by default.
- Tests: the tool against a fake fetch in jsdom (dev path via a stubbed `import`, prod path
  via `__AIUI__.sources`), the plugin's emitted file set and manifest in
  `aiui-source-processor`'s existing plugin tests, and `pnpm test:packaging` for the new
  subpath. Live: `source` on seismos in dev through `page_tools_call`, then on a `vite
  preview` of the gallery.

**Order within the tranche.** `read-page` first (no plugin work, immediately useful to the
oracle), then the gallery-dev stamping verification, then `source` with shipping.

### Non-goals for tranche 1
- MathJax or bare MathML extraction (no renderer in the repo produces it).
- Page text in lowered prompts or channel pushes (the channel-wakeups rule stands; an agent
  that wants the page calls the tool).
- Sourcemaps as the source carrier: `sourcesContent` would work but needs a chunk→file
  index; a plain file tree is what an agent can address.

## 2. The voice dock, on every page

**The ask.** seismos and wine can be driven by voice only through the intent panel or the
extension. The owner wants both engines — the Realtime **oracle** and the GPT-Live
**live** session with its delegation backends — embedded in the page itself, with viewers
for the tools and the conversation, working in dev with whatever key is around and on the
published site with a pasted key kept in localStorage. Done right, it goes on every demo.

**What exists (all of it reusable).**
- Oracle: `new OracleSession({ config, keySource, transport })` + `webRtcTransport()`
  (`aiui-oracle/src/session.ts:72-79`, `webrtc.ts:56-68`); key sources chain paste → dev →
  mint (`keys.ts:154`): `pasteKeySource()` reads localStorage `aiui.oracle.key` and mints the
  single-use ephemeral **in the browser** (`keys.ts:30-40`), `devKeySource()` reads
  `__AIUI__.devKeys.openai`. Widgets: `OracleControl`, `OracleKey`, `OracleMind`,
  `OracleViewer`, `OracleUsage`, `OracleParkBanner`, the two param editors. The page-tools
  bridge: `toolsFromAiuiRegistry` + `briefFromAiuiRegistry` (`aiui-tools.ts:265-314`).
- Live: `new LiveSession({ transport, config, delegator, tools })` + `webRtcTransport({
  broker })` with `standardBrokers` paste → dev → server (`brokers.ts:175`); the paste broker
  posts the SDP straight to the vendor (`:74`), the same localStorage slot. Widgets:
  `LiveControl`, `LiveKey`, `LiveCaptions`, `LiveComposer`, `LiveTasks`, `LiveLedger`.
  Backends that work on a static site with a pasted key: scripted, echo, browser Responses,
  hosted; server Responses and Claude need the dev server's `live()` plugin
  (`demos/live/vite.config.ts:22-27`). `demos/live/src/ui/App.tsx:24-37` is the registry
  bridge already written.
- The panel's oracle wiring to copy (`lanes/oracle.ts`): an `app` slot plus a context slot,
  `semantic_vad` at low eagerness with far-field noise reduction and a greeting that primes
  the echo canceller, the **active-namespace filter**, and `setTools(tools, { brief })` on
  registry `onChange`.
- Dependency directions: viz ← oracle, viz ← live, oracle ← intent-client; live and oracle
  do not know each other. A component using both cannot live in viz.

**Surprises that shape the design (from the read).**
1. `toolsFromAiuiRegistry` does **not** filter parked namespaces (`aiui-tools.ts:291-296`)
   although the registry doc says the oracle projection does (`aiui-global.ts:104`). In the
   gallery every demo's kit is registered and off-route pages are parked; an unfiltered dock
   would hand the model the whole site. Fix in the function itself (filter `active !==
   false` by default, an `includeParked` opt-in), which makes the doc true.
2. Only `demos/live`, `demos/motherduck-lab` and the oracle lab set `devKeys`; the gallery
   and the template do not.
3. `OracleKey` and `LiveKey` are near-duplicates over one storage slot, and the slot's name
   is declared twice (`oracle/keys.ts:30`, `live/brokers.ts:21`).
4. The oracle lab passes a plain-string instruction and so gets no `Tools:` section; the
   dock must pass slots.

**Decisions.**
- **A new package, `@habemus-papadum/aiui-dock`** (`pnpm new-package aiui-dock --public`),
  depending on viz, oracle and live. The one component: `<VoiceDock />`. It is the only
  home without a cycle, and the panel does not want live.
- **Shape.** A fixed pill row in the bottom-right corner (`data-aiui-chrome`, excluded from
  `read-page`): `🔮 oracle` · `🎙 live` · `tools` · `key`. Each opens one pane above it;
  open state in localStorage. Oracle pane: `OracleControl`, `OracleMind`, `OracleViewer`,
  and a *prompt* fold showing the latest `config` ledger record's instructions (the woven
  text with the `Tools:` section, the panel's prompt view reduced to a `<pre>`). Live pane: a
  backend picker (browser Responses · hosted · the server backends only when
  `/live/sessions` answers a probe, i.e. in dev), `LiveControl`, `LiveCaptions`, `LiveTasks`,
  a config fold. Tools pane: the existing `ToolLog`, mounted by the dock (`toggleToolLog`),
  so the template and the gallery mount the dock alone. Key pane: one key field (the live
  one; the oracle's goes), a "dev key present" line when `__AIUI__.devKeys.openai` exists, a
  forget button, and the posture in one sentence.
- **Tools.** Both sessions take `toolsFromAiuiRegistry` + `briefFromAiuiRegistry`, re-projected
  on registry `onChange` (parking included), with the dock's own caller tag (`oracle` and
  `live:<delegator>` are already distinct; the dock passes `caller: "oracle"` for the
  oracle, and the live delegators tag themselves).
- **Prompts.** Oracle: slots — `app` is the kit brief, else the sitePage title and
  description; `context` is the url and title — plus the panel's audio tuning and greeting,
  so the `Tools:` section composes. Live: `LIVE_BASE_PERSONA` with `app` from the brief and the derived
  capability list from tranche 0.
- **Keys and posture.** Dev: `devKeys: ["openai"]` in the gallery's and the template's vite
  config (the plugin warns once per missing provider; acceptable). Site: paste → localStorage
  for that origin → sent only to `api.openai.com` by the browser (both engines are
  vendor-direct); never to the channel, never to the dev server. Written on the dock's key
  pane, in the package README and in `docs/guide/warning.md`.
- **Where it mounts.** The app template's `main.tsx` (every scaffolded app), the gallery
  shell (every demo on the site), and the standalone `main.tsx` of each demo with a sitePage
  marker (the dev loop) — replacing the bare `<ToolLog />` placed there in milestone 5.
- **Costs.** GPT-Live idles at $0.05/min and the live session already closes after 120 s
  idle; the oracle parks after 2 min. Both panes show their usage chips. No background
  session: nothing connects until a pill is pressed.

**Work, five commits.**
1. `aiui-dock I`: the package, the pill row, the key pane, the oracle pane wired to the
   registry; `toolsFromAiuiRegistry` filters parked kits (test). Verify by voice on seismos
   standalone with the dev key.
2. `aiui-dock II`: the live pane with the picker and the probe; verify browser Responses and
   hosted on seismos; the Claude backend on `demos/live` in dev.
3. `aiui-dock III`: the static path — `vite build` + `vite preview` of the gallery, a pasted
   key, both engines on wine; the posture text; the `OracleKey` duplicate retired.
4. `aiui-dock IV`: mounted everywhere (template, gallery, the demos' mains); `devKeys` in
   the two vite configs; the template's `CLAUDE.md`.
5. `aiui-dock V`: docs — the package README, `warning.md`, the `aiui-architecture` and
   `session-browser` skills (the dock is how a page is driven without the panel; the panel
   remains how Claude Code drives it).

**Non-goals.** The intent panel's other lanes (recording, pencil, screenshots) stay in the
panel. No Claude backend on the static site (there is no relay to reach). No shared
"voice" abstraction over the two engines — they stay two sessions with two widget sets.

## 3. Solid 2.0 release candidate

**Where we are.** The catalog pins `2.0.0-beta.32` (2026-08-07) for `solid-js`,
`@solidjs/web`, the `@solidjs/signals` override and the `babel-preset-solid` override, with
`vite-plugin-solid@3.0.0-next.24` (`pnpm-workspace.yaml:57-82`, `:124`). npm's `next` tag is
`2.0.0-rc.14` for solid-js, web and signals (2026-10-08, fifteen releases since the beta);
`vite-plugin-solid@3.0.0-next.27` is now a thin wrapper over `@solidjs/vite-plugin`.

**What changed in the RC line that touches this repo (release notes read 2026-10-08).**
- **rc.3**: the compilers moved into the solid repo as `@solidjs/babel-plugin` and the
  native `@solidjs/compiler` (platform binaries published as `@solidjs/compiler-*`);
  **`babel-preset-solid` was deleted**. The two `babel-preset-solid` overrides (workspace
  and template) are dead on arrival; `vite-plugin-solid@3.0.0-next.27` and the native
  binaries may need `allowBuilds` entries.
- **rc.4**: `DEV.diagnostics` with a console footer pointing at a shipped repair skill
  (`node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md`) — worth a pointer from the
  `aiui-architecture` skill; the patch-mode keyed `<For>` driver over store arrays (a
  behaviour change for keyed lists; the gallery's nav, the slides HUD and the views bar are
  the lists to watch).
- **rc.13**: a public hydration API (irrelevant: no SSR here).
- **rc.14**: binding slots run once, untracked, with `STRICT_READ_UNTRACKED` naming the fill;
  `createEffect` compute results inferred as const (type changes in two-arg effects — the
  repo has many).
- The locator pass is **unaffected**: it runs its own `@babel/core` pass at `enforce: "pre"`
  (`source-locator.ts:497-561`), independent of the Solid compiler.
- **A blocker found while planning**: aiui-viz's peer range
  `>=2.0.0-beta.32 <2.0.0-experimental.0` (`package.json:134,140`; also `demos/oscillator`,
  `demos/optics`) **excludes every `rc` and the final 2.0.0** — prerelease tags compare
  lexically and `experimental` < `rc`. The range must become `>=2.0.0-rc.14 <3`.

**Procedure (a branch; direct merge when green).**
1. The bump, one commit: catalog `solid` → rc.14 ×2 and `vite-plugin-solid` → next.27;
   `@solidjs/signals` override → rc.14; **delete** the `babel-preset-solid` override;
   `allowBuilds` for the new plugin version (and the compiler binaries if pnpm asks); the
   peer ranges; the template's `package.json` literals and its `pnpm-workspace.yaml`
   overrides (drop `babel-preset-solid` there too). `pnpm install`, `pnpm -r typecheck`,
   every suite, `pnpm test:packaging`, the template scaffold test.
2. Triage in dependency order: viz (effects, `STRICT_READ_UNTRACKED` in binding slots,
   `<For>` over stores) → oracle → live → slides, pencil, remote-bar, trace-ui, console →
   intent-client (the jsdom + ws split) → the demos and apps → the template.
3. Re-probe the three beta.32 semantics the repo relies on (`frontend-hard-won.md`, the
   architecture skill's Solid 2 notes): effect-hold during pending questions,
   `STRICT_READ_UNTRACKED`, the plugin's jsdom vitest default — and record what moved.
4. Browser pass in the session browser: the gallery (every page mounts; route switching
   keeps durables; a hot edit of seismos survives; the gear-talk deck's HUD and keymap), the
   intent panel, the oracle lab, the live demo, the dock from tranche 2.
5. Docs: `frontend-hard-won.md`'s ecosystem section, the skill's trap list, the catalog
   comments (the lockstep story is now signals + the plugin, not the preset), a memory note.
6. Release `0.21.0`.

**Risks, named.** The native compiler in CI (binary install under `allowBuilds`); the
`@solidjs/web` `latest` tag pointing at `rc.0` (pin exact, never `latest`); the template's
npm/yarn consumers (literal pins, no overrides); the keyed-list driver changing DOM reuse
under the slides' scroll-snap; typing churn from const-inferred effects across ~150
two-arg `createEffect` sites.

## Sequencing and what the owner decides

Tranche 0 today; tranche 1 next (`read-page`, the gallery-dev stamping check, `source`);
tranche 2 after, since the dock is where `read-page` and `source` get used by voice; Solid
last, on its own branch, once everything above has its own tests to catch what the upgrade
moves. Three choices are policy rather than engineering and are flagged, not assumed:
whether the gallery ships its sources (1b); whether a pasted key on the public site is
acceptable posture (2); whether the dock mounts on the standalone demo mains or only the
template and the gallery (2, commit IV). The plan proceeds on "yes, yes, everywhere" unless
told otherwise.
