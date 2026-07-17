# Retiring the dev overlay (and the extensions with it)

Status: **COMPLETE — the batch is deleted** (2026-07-16, all in one day: pause recorded,
decisions made, steps 1–3 landed, and step 4 executed the same evening on the owner's
instruction). `aiui-dev-overlay`, `aiui-extension`, `aiui-devtools-extension` — and `aiui-webext`,
the CRXJS kit whose only consumer was the frozen extension — are gone from the tree; read them in
git history. The same pass removed `aiui-ink`/`aiui-paint` (superseded by `aiui-pencil`, per that
package's own charter) and the intent client's ink integration, and moved `aiui-oscillator` to
`demos/`. Both open decisions are settled and executed: the runtime was copied into
**`aiui-intent-runtime`** (capture + transport) and the trace UI into its own
**`aiui-trace-ui`** (decision #2: own package), both `--public`; the intent client is repointed
at them; `aiui-dev-overlay` is frozen as a read-only reference (README/CLAUDE banners); and
`aiui debug` is fixed (the trace-ui package's `./vite` plugin now owns serving `/__aiui/debug`).
Nothing remains open in this proposal.

This is the next chapter after [the plugin restructure](./plugin-restructure.md): that plan
pulled the app-side integration out of the overlay; this one retires the overlay itself, along
with the two browser extensions that still lean on it.

## The goal

Three packages go away as one batch, when we choose to pull the trigger:

- **`aiui-dev-overlay`** — the original web intent tool. Its headline surface (`mountIntentTool`,
  the widget, the `intent.ts` host) is already **orphaned**: nothing in the workspace imports the
  overlay-UI barrel anymore. What keeps the package alive is a *runtime* the intent client still
  leans on (below).
- **`aiui-extension`** — the frozen old Chrome extension (safety net, never auto-loaded since the
  2026-07-13 freeze). The heaviest consumer of dev-overlay's subpaths; it vanishes wholesale.
- **`aiui-devtools-extension`** — the aiui Chrome DevTools panel (manual install). Consumes only
  `debug-ui`, via a direct-file build (`build-debug-ui.mjs` reads
  `../aiui-dev-overlay/src/debug-ui/index.ts`).

Nothing else in the workspace should reference any of the three when the batch lands. The one live
package that stands in the way today is **`aiui-intent-client`**.

## Where we are (landed / staged, 2026-07-16)

Two things already shipped that make this tractable:

1. **`aiui-source-processor` extracted** (public). The single code-transformation site — the Babel
   locator pass + the `aiui()` Vite plugin — moved out of `aiui-viz/vite` into its own package.
   (The [plugin restructure](./plugin-restructure.md) had parked it in viz; it now has a real home.)
2. **The `/vite` + stale-dep sweep.** Every non-frozen consumer of the deprecated
   `@habemus-papadum/aiui-dev-overlay/vite` shim was repointed to `aiui-source-processor`
   (oscillator, pencil lab, twins/walkthrough/template vitest configs), and the demos/test-app that
   only *declared* a dead `aiui-dev-overlay` dep had it dropped. After this, the only remaining
   `dev-overlay/vite` importers are the frozen extension and the `aiui debug` CLI (see the
   regression note below).

Both are staged on `main`. All gates green (`typecheck` / `test` / `packaging` / `biome check .`).

## What actually blocks deletion: the intent client's runtime

Strip away the noise and dev-overlay's surviving value is a **host-agnostic runtime** — code that
was deliberately carved out of the overlay (the "B2.4 / C1" extraction) so that two hosts, the old
overlay *and* the extension/intent-client, could share one implementation instead of hand-rolling
twins. The intent client is now its **sole live host**. It imports seven subpaths, which sort into
three jobs:

| Job | Subpath | Intent-client import site | What it is |
| --- | --- | --- | --- |
| **Capture** | `multimodal-shot` | `cdp/page-ink.ts`, `ext/content.ts` | region screenshots + `locateComponents` (screenshot-rect → DOM → source loc, via the `data-source-loc` stamps the source-processor emits) |
| | `multimodal-talk` | `ext/panel.tsx`, `lanes.ts` | the audio stack: mic → PCM (AudioWorklet), REST segments, realtime PCM, TTS with barge-in, offline transcriber |
| | `multimodal-video` | `lanes.ts` | the tab/screen-share frame sampler (`VideoSampler`) over a warm capture stream |
| | `selection` | `ext/content.ts` | the "select text/equation, then ask about it" watcher (`installSelectionWatcher`) |
| **Transport** | `wire` | `lanes.ts` | the per-thread socket (`createWire`): batches the event log, ships shots/audio/PCM, merges lowered echoes back in |
| | `intent-thread` | `lanes.ts` | the host-agnostic thread adapter (`openIntentThread`): id + send/finish/chunk/attachment/audio/video verbs |
| **Inspect** | `debug-ui` | `ui/trace-pane.tsx` | the framework-free trace-debugger panes (`TracesPane`), mounted as a Solid island in the panel |

The other three subpaths (`.` the overlay UI, `protocol`, `multimodal-ui`) are orphaned or
extension-only — they die with the batch, no work.

### What these layers actually do, and where they run

**It is all browser code — but that's the trap, because "the browser" here is not one place.** None
of the *real* capture can run in Node or jsdom: `getDisplayMedia`, `getUserMedia`, `AudioWorklet`,
`chrome.tabCapture`, canvas `toBlob` simply don't exist there. Yet the runtime is deliberately
built so that the **hard logic never touches a browser API directly**. Every module is split into a
DOM-free, framework-free *core* (a state machine, an algorithm, a batching loop) and a thin
browser *edge* that is **injected as a dependency** (`PcmSource`, `VideoSamplerDeps.captureFrame`,
`WireDeps`, the `DebugSource` seam). The core runs in plain Node under Vitest with a fake edge; the
real edge is supplied only in a live tab. That one pattern — *host-agnostic core + injected edge* —
is simultaneously what makes the code reusable across hosts and the bulk of its complexity. It is
also the discipline the copy must preserve; lose it and the whole thing becomes untestable.

And the edge itself lands in **several distinct browser realms**, which is the other half of the
complexity:

- the **page's own main world** (the locator and selection watcher read the *instrumented app's*
  DOM — the `data-source-loc` / `data-cell` stamps the source-processor emits);
- a separate **AudioWorklet thread** (realtime PCM is downsampled off the main thread, shipped as
  stringified worklet source);
- the **extension's split worlds** (MAIN world vs content script vs side panel) *and* the
  **CDP tier** (the same cores, driven against a real tab with no extension) — the two hosts the
  "host-agnostic" factoring exists to serve.

**Capture — page-side sensing. The complexity is browser reality, not algorithms.**

- **The one-grant broker** (`display-capture.ts`, ~280 lines) is the sharpest example. `getDisplayMedia`
  is *not* a persistable permission — Chrome never remembers it, and two calls in one document return
  two independent live streams (two pickers, two recording indicators, two focus excursions). So a
  single broker owns the *one* grant and the shot tool, the video sampler, and the paint host all
  read its stream. Layered on top are two measured browser facts it has to paper over: (1) **every**
  capture call blurs the window — even auto-accepted with no dialog drawn — which is indistinguishable
  from the user alt-tabbing away, and the blur handler stops the mic (a mic left open once transcribed
  a whole conversation onto the API bill), so `blurIsSelfInflicted` disambiguates; (2) whether a call
  needs a click is a property of *the browser*, unprobeable, and a wrong guess is a dialog you can't
  take back — so it's steered out-of-band by a `__AIUI_CAPTURE__` marker set over CDP.
- **Two audio paths** (`audio.ts`): REST (`MediaRecorder` → a whole webm/opus blob per talk segment)
  and realtime (`AudioWorklet` → Int16 PCM at 24 kHz *while you talk*) — two capture stacks because
  timesliced webm fragments aren't independently decodable and the realtime API wants raw PCM. Muting
  disables the track rather than tearing capture down, so a segment's timeline survives the mute.
- **The frame sampler** (`video.ts`): a screen share is just a clock-driven stream of screenshots —
  same artifact the S key produces. A smart gate (capture only if the app was touched since the last
  frame) vs continuous cadence; the first frame always fires; downscale-never-upscale sizing math.
- **The selection watcher** (`selection.ts`): the Selection API alone is enough (no extension), but
  the document selection reads *empty* the instant focus moves into the intent textarea — so it keeps
  a debounced snapshot of the last non-collapsed selection, recovers TeX out of KaTeX DOM soup, and
  attributes via the same source stamps the locator uses.
- **The locator** (`shot.ts`): screenshot-rect → components → source, via an enclosure algorithm
  (highest annotated elements fully inside the rect, a `within` fallback, one level of cell frontier,
  a naming ladder) reading the source-processor's stamps and resolving to absolute paths when
  `window.__AIUI__.sourceRoot` is known. This part *is* pure and jsdom-testable.

**Transport — getting captured intent to the channel over one socket.**

- **`wire.ts`** owns one WebSocket per thread. Outbound, the engine's event log rides *batched*
  (debounced) `chunk{kind:"events"}` frames; shot images and audio segments ride
  `chunk{kind:"attachment"}`; streamed PCM rides `audio` chunks. Inbound is the subtle part: the
  server's lowered echoes (transcript deltas/finals, pushed speech clips) **merge back into the local
  engine stream as if they had happened locally**, behind a `merging` reentrancy flag so a merge never
  re-streams itself into an infinite loop. It is host-neutral by construction — it talks to the engine
  and the host only through `WireDeps`, and reads no `window`/`document`.
- **`intent-thread.ts`** wraps a raw `IntentSocket` into one thread: a fresh id and the per-thread
  verbs (send / finish / chunk / attachment / audio / video), with server pushes filtered to that
  thread. The genuinely host-specific bits — meta collection (page instrumentation vs. tab identity),
  connect-failure surfacing — ride an `onSocket` hook, so one implementation serves both hosts instead
  of a hand-rolled twin.

**Inspect — watching the pipeline.**

- **`debug-ui`** is **raw DOM, not Solid** — deliberately framework-free so the *same* panes mount in
  three unrelated homes: the intent panel (as a Solid *island*), the DevTools extension, and the
  `/__aiui/debug` page. It carries `TraceView` (a channel trace rendered as a reading surface, with
  pure stage classification/coalescing under it), `TracesPane` (the session-filtered list over a
  live-followed view), a dependency-free collapsible JSON widget, and a `DebugSource` seam that reads
  either a live engine or an HTTP poll of the channel's `/debug/api/traces/:id/live`. This is the
  layer whose future home is still open (decision #2).

## The plan

**Freeze, extract, repoint, delete — in that order, with copy-paste (not git-mv).**

1. **Freeze `aiui-dev-overlay` as read-only reference.** It stays intact and compiling — useful to
   read the old design against — but nobody edits it. One line in its README/CLAUDE saying so.
2. **Copy the host-neutral runtime into a new package** (Capture + Transport; `debug-ui` is its own
   open question — see below). Copy the **tests** with it. Rename at the boundary: shed the overlay
   vocabulary (`OverlayError*` → `IntentError*`, `overlay-tools` → something honest). This is the
   moment to de-overlay-ify, not preserve.
3. **Repoint `aiui-intent-client`** at the new package, import site by import site (the seven above).
4. **Delete the batch later** — `aiui-dev-overlay` + `aiui-extension` + `aiui-devtools-extension`
   together, once we're sure nothing else wants them as reference.

### Why copy-paste here, when source-processor was a clean git-mv

Because the runtime **shares a substrate with the code that stays frozen.** The modules the intent
client pulls transitively depend on dev-overlay internals that are *also* used by the orphaned
overlay UI:

| Substrate module | # of dev-overlay modules importing it |
| --- | --- |
| `instrumentation` | 12 |
| `protocol` | 7 |
| `errors` | 3 |
| `overlay-tools` | 3 |
| `intent-types` | 2 |

A clean move-with-shim (the `aiui-source-processor` pattern) would mean splitting that shared
substrate across a new package boundary *while keeping the overlay UI — a surface nobody imports —
compiling for CI*. That is surgery on a corpse. Copy-paste sidesteps it: dev-overlay stays 100%
intact, and the intent client takes exactly the subset it needs. The cost is a **temporary
duplicate** of ~6.7k source lines (`multimodal/` ≈ 5,250; substrate + `selection`/`intent-thread`
≈ 1,450) plus ~26 test files — bounded, because the frozen copy is short-lived and unedited.

> There is a coherent *alternative* if the duplication bothers us more than losing the pristine
> reference: **delete the orphaned overlay UI now**, then genuinely *move* the runtime + substrate
> and shim only what the frozen extension still needs. That reaches one-copy sooner but guts the
> reference. We chose to keep the reference (owner priority: "useful to have around now").

## Open decisions — both DECIDED and executed (2026-07-16)

1. **Separate package vs. fold into the intent client — DECIDED: separate package.** Landed as
   **`aiui-intent-runtime`** (`--public` — forced anyway: the intent client publishes public and
   its artifact depends on it). Note for the record: the usual argument *against* a separate
   package is that a package earns its keep only with a second live host, and today the intent
   client is the only one (the extension, the other historical host, is in this deletion batch).
   The owner's call stands regardless; noting it so the tradeoff is on paper.

2. **Where the trace UI (`debug-ui` / `TracesPane`) lives — DECIDED: its own package,
   `aiui-trace-ui`** (`--public`). It is genuinely standalone and framework-free, and it kept a
   second live host after the batch dies: the panel island *and* the `aiui` CLI's standalone
   viewer. Folding it into the runtime would have made the CLI depend on the whole capture stack
   just to serve a trace page. The package also owns **serving** its standalone page: a new
   `./vite` entry (`traceViewer({ port })`) serves `/__aiui/debug` — which is what fixed
   `aiui debug`.

### How the copy was slimmed (differs from the map above — deliberately)

The `overlay-tools`/`tools-bridge` pair was **not** copied. Its entire contribution to the
closure was one four-value string union (`ThreadSocketState`, reached through type-only
imports), now defined in the runtime's `wire.ts` directly. Everything else came whole:
20 source files → 17 (flattened, no `multimodal/` nesting; `talk-entry`/`video-entry` became
the `./talk` entry barrel and a direct `./video` export), 11 test files + `fake-socket`,
`OverlayError*` → `IntentError*`, stale composer references (`modality.ts`) rewritten to "the
host". The core-plus-injected-edge discipline is documented in the runtime's README as the
thing to preserve.

## Loose ends to fold into the deletion pass (not before it)

- ~~**`aiui debug` is currently broken.**~~ **FIXED** with decision #2: `aiui-trace-ui/vite`'s
  `traceViewer({ port })` serves `/__aiui/debug`, and `commands/debug.ts` rides it (verified live
  against a running channel). The `aiui` package no longer depends on `aiui-dev-overlay`.
- **Stale `CLAUDE.md` ground-rules.** The demo/template CLAUDE files (twins, walkthrough, july09,
  the create-aiui template) still say *"the `aiuiDevOverlay()` plugin in `vite.config.ts` mounts the
  intent tool and connects it to this session's channel."* Post-restructure that is doubly wrong —
  the symbol is `aiui()` and it mounts nothing (it only runs the locator). Fix these as part of the
  deletion pass, when the intent-tool-mounting narrative is settled, not piecemeal.
- **Docs prose sweep.** The [plugin restructure residuals](./plugin-restructure.md#residuals)
  already flag the guide pages that describe the old plugin; the overlay's deletion is the natural
  time to finish that sweep.

## Status line for whoever picks this up

Steps 1–3 are landed (all gates green: repo typecheck, `pnpm -r test`, `pnpm test:packaging` with
the two new packages in the tarball matrix, version lockstep, biome). What's left is **step 4** —
delete `aiui-dev-overlay` + `aiui-extension` + `aiui-devtools-extension` as one batch when we're
sure nothing wants them as reference — folding in the stale-`CLAUDE.md` ground-rules and the docs
prose sweep above. One operational note: the new names still need their one-time npm provisioning
before the next release (`pnpm npm:reserve aiui-intent-runtime aiui-trace-ui`, then
`pnpm npm:trust …` — run locally; see CLAUDE.md "Trusted publishing").
