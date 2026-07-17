# The retirement pass — report for review (2026-07-16)

One working-tree pass, uncommitted, ~356 changed paths. Six packages left the tree, two of the
remaining ones got slimmer, one moved to `demos/`. All gates green at the end: repo typecheck,
`pnpm -r test` (every package + demos), `pnpm test:packaging` (16 publishable tarballs),
`pnpm version:check`, `pnpm lint`.

## What was asked, what was done

| Ask | Done |
| --- | --- |
| Delete `aiui-dev-overlay`, `aiui-devtools-extension`, `aiui-extension` | ✅ deleted, plus every consumer repointed/removed (details below) |
| Analyze `aiui-ink` / `aiui-paint` vs `aiui-pencil` | ✅ conclusion **confirmed by the code itself**: `aiui-pencil/src/index.ts` declares "Supersedes `aiui-ink` and `aiui-paint`", and the intent client's BEHAVIOR.md recorded pencil as "integrated exactly like ink, meant to replace it". Both packages deleted; ink/paint integration stripped from the intent client and the runtime |
| Move `aiui-oscillator` into demos | ✅ `demos/oscillator` (same package name, so `demos/twins` keeps resolving it; already private/no-publish, now demo-shaped) |
| Simplification pass over vanilla-JS leftovers | ✅ `aiui-webext` (CRXJS kit, orphaned by the extension's deletion) deleted; the capture-marker machinery (orphaned by display-capture's removal) deleted; superseded docs pages deleted; CLI surface slimmed |

## Key decisions made without stopping (all reversible via git)

1. **`aiui-webext` deleted too.** The CRXJS dev-loop kit existed only for the frozen extension;
   after the batch, every remaining reference was a comment about vendored code. It was published
   (`--public`), so like the other deleted published packages its npm name simply stops receiving
   releases.
2. **The native-messaging host SURVIVES.** It looked extension-batch-shaped but is a live
   discovery tier for the *intent client's* extension (cold-start channel enumeration). `aiui
   extension` was reworked down to `install-native-host | status`; `allowed_origins` now pins the
   intent client's id only; `dev`/`reload` print a pointer to `pnpm -C packages/aiui-intent-client
   ext`. The hidden `native-host` command and the launchers' profile-manifest planting are intact.
3. **`aiui chrome` lost its `extension` action** (it printed the DevTools panel's path); `status`
   now reports only the intent client. `chrome.buildExtension` and `chrome.autoCapture` config
   keys are parsed-and-ignored (old configs stay valid; the schema says OBSOLETE).
4. **`aiui paint` command removed; `aiui pencil url` stays** (commands/paint.ts →
   commands/pencil-url.ts). The channel hosts **three** standard sidecars now (intent, bar,
   pencil); the packaging test mounts the bar sidecar instead of paint's.
5. **Ink removal = removing one of the four page-pointer tools.** The mode spec now has three
   (`pencil` · `area` · `jump`). The `i` key is gone; **`c` now clears the pencil** while pencil
   mode is on (it used to clear ink; pencil's clear previously lived only in the bar).
   `inkVanish`/`inkFade` config controls are gone (`pencilVanish`/`pencilFade` remain).
   BEHAVIOR.md/PARITY.md updated to record the pencil as the sole markup tool.
6. **The page bundle was renamed honestly**: `cdp/page-ink.ts` → `cdp/page-bundle.ts`, global
   `__aiuiIntentInk` → `__aiuiIntentPage`, route `/intent/page-ink.js` → `/intent/page-bundle.js`
   (it carries locator · jump · pencil). Any long-running channel serves the new route only after
   a restart.
7. **`aiui-intent-runtime` slimmed with the capture story**: `ink.ts` (adapter over aiui-ink),
   `ShotTool`, and the `display-capture.ts` one-grant broker are gone — the intent client's hosts
   capture natively (CDP screenshots / warm `tabCapture`), and no shipped page calls
   `getDisplayMedia` any more. The `./shot` subpath became **`./locator`** (locateComponents is
   what survived). `instrumentation.ts` lost the `RemotePaintSink`/`displayCapture` seams and the
   `__AIUI_CAPTURE__` global declaration.
8. **Capture-marker machinery deleted** (aiui-util `capture-marker.ts`, `aiui vite`'s
   marker injection): its only reader was the deleted broker. The browser launch **flag**
   `--auto-accept-this-tab-capture` is kept (harmless; a scratch page an agent writes can rely on
   it) — the mic auto-accept flag is untouched and still load-bearing for dictation.
   `rehostSocketUrl` (which shared the deleted file) moved to aiui-util `socket-url.ts` with its
   tests.
9. **Six superseded guide pages deleted** (web-intent-tool, intent-overlay, devtools,
   multi-view-sessions, paint-stream, screen-capture) with the sidebar list, every inbound link,
   and the stale getting-started/installation/chrome/channel/config narratives rewritten to the
   intent-client world. The demo/template CLAUDE ground-rules ("aiuiDevOverlay() mounts the
   intent tool") are fixed everywhere — the proposal's deferred docs sweep is done.
10. **The channel's `/session` bus stays**: it looked overlay-era but `aiui-vscode` (kept) is a
    live client. Its docs page died; `channel.md` now names the VS Code extension as the consumer.

## Functionality disabled (the requested list)

- **Page-side ink** (`i` mode, the InkSurface layer, ink events into the engine). Replacement:
  the pencil (`k`), same lifecycle, richer strokes, iPad support. Loss: nothing pencil doesn't
  cover, in my judgment — the one behavioral difference users may notice is stroke look (pencil
  is red, textured) and that `c` now belongs to the pencil.
- **The iPad *paint* stream** (`/paint/`, screen-mirror + ink-over-video). Replacement: the
  remote *pencil* (`/pencil/`). Loss: paint's live screen *view* on the iPad — the pencil client
  is a drawing surface, not a mirror. If the mirror mattered, that's a re-enable conversation.
- **The DevTools panel** (channel/transport monitors + trace debugger in DevTools). Replacement:
  the intent panel embeds the trace debugger; `aiui debug` serves it standalone. Loss: the
  transport frame-metrics pane (the `window.__AIUI__.frames` ring is still recorded by the
  runtime; nothing renders it today).
- **The frozen extension safety net** — by design of this pass.
- **`getDisplayMedia`-based page capture** (the one-grant broker, auto-accept marker). The hosts
  capture natively; nothing user-visible changes today.
- **The old overlay UI** — already orphaned before this pass; now gone.

## Findings

- The repo's decided-contract docs made this tractable: BEHAVIOR.md literally recorded that the
  pencil was built to replace ink, and pencil imports nothing from aiui-ink (the fade curve was
  already copied in).
- After this pass the only deliberately non-Solid frontend code left is: `aiui-trace-ui`
  (framework-free by design — three mount targets), the two page bootstraps
  (`cdp/page-script.ts` is a stringified function, `ext/content.ts` is an isolated-world content
  script — both structurally cannot be Solid), the pencil's canvas engine (a drawing surface),
  and `aiui-paint`'s old iPad page is gone. Everything panel-shaped is Solid.
- Pre-existing breakage fixed in passing: `demos/twins`'s loc-pinning test (path moved with
  oscillator).

## Outstanding (not done, listed for a future pass)

1. **`foreignArmed` coexistence machinery** in the intent client (the "never both armed" policy
   against the *frozen extension*, which no longer exists): `foreignClient` page events, the
   `available.arm` gate, `LEGACY_RING_HOST_ID` probes. Self-contained and harmless; removing it
   touches spec/tests again, so I left it.
2. **Ink event types in `aiui-lowering-pipeline`** (`ink`/`ink-clear` in the event union,
   compose rendering, fixtures): left untouched for protocol/trace stability — no client emits
   them now. Clean up when next touching the pipeline.
3. **The `window.__AIUI__.frames` transport metrics** have no viewer since the DevTools panel
   died — either surface them in the intent panel or stop recording them.
4. A **pencil guide page** (`docs/guide/`): paint-stream.md died and pencil has no long-form
   docs page; the remote-pencil story (`aiui pencil url`, `channel.bind`) is only in
   channel.md/config.md tables now.
5. `transport.ts` still says "getDisplayMedia elsewhere" in one comment about capture sources —
   cosmetic.
6. npm housekeeping: the new names still need `pnpm npm:reserve aiui-intent-runtime aiui-trace-ui`
   + `pnpm npm:trust …` before the next release; the deleted published packages
   (`aiui-dev-overlay`, `aiui-extension`, `aiui-devtools-extension`, `aiui-webext`, `aiui-ink`,
   `aiui-paint`) just stop receiving releases — deprecate them on npm if you want installs warned.
7. **Restart running channels**: a live `aiui claude` predating this pass still serves `/paint/`
   and the old `/intent/page-ink.js` route from its loaded code; the repointed panel needs a
   restarted channel.

## One mistake to disclose

While clearing leftover files of the deleted packages I ran an `rm -rf` that wrongly included
`packages/aiui-vscode` (plus four already-nonexistent names). It was restored from git
immediately and verified intact (clean `git status`, its 3 test files pass in the final suite).
Nothing else was touched.
