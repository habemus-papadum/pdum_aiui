# Hosts and the dev loop: where the intent client runs, and how it gets debugged

Part of the [intent-client plan](./README.md). This document weighs the four host
architectures the project owner named, and designs the one intervention that changes the
debugging economics: the **detached panel harness**.

## 1 · The two-disease diagnosis

The extension's debugging pain is two independent diseases that compound:

1. **The conductor disease** — mode/state bugs in the panel brain (write-semantics traps,
   forgotten sync calls). Treated by the
   [write-semantics proposal](../solid-write-semantics-and-the-imperative-boundary.md) and the
   [mode engine](./01-mode-engine.md).
2. **The host disease** — the MV3/CRXJS platform fails silently and blocks verification.
   STATUS.md §F3 records five dev-loop failure modes (stale entry snapshots, invisible new
   modules, half-cached extensions, forever-polling loader stubs, orphaned content scripts);
   §F6 records that the *tests themselves* lied.

They compound multiplicatively: every conductor bug costs a host-disease-sized verification
loop to even observe. STATUS.md's phrasing is exact: *"the platform fails silently, and every
silent failure was first misdiagnosed as an application bug."*

### What is still slow, after all the mechanization

The shipped mechanization (the `dist-dev/` split with completeness stamp, `aiui extension
dev`/`reload` ordering with the CDP re-point, the boot banner, SW content-script re-injection)
removed the *silent* failures. The residual cost, per edit class:

| Edit class | What happens | What's lost |
| --- | --- | --- |
| panel `.tsx` | Vite HMR through the CRXJS SW proxy — *when it works*; Solid HMR on a 1,480-line `main.tsx` frequently forces a document reload | panel signals on full reload |
| `content.ts` | hot-swaps in place; boot-hello re-pulls state (`content.ts:332-340`) | ink strokes (die with the surface remount) |
| `sw.ts` | **full extension reload** | SW invocation ledger, pending-leader map; content scripts orphaned in every tab until re-injection |
| manifest | full extension reload + Chrome re-reads the directory | all of the above **plus `storage.session`** — the per-window bound port, so auto-bind must re-run |
| shared workspace pkg | reaches the panel via HMR (source-first) — but a new file or export-map change is invisible until a dev-server restart (F3b) | full panel state |

But the load-bearing residual is not any single edit class. It is that **the panel cannot be
verified by an agent at all**:

- An extension page opened in a CDP-created tab **never commits** — `readyState` stays
  `"loading"`, no `<head>`, silent console; measured against both dev and production artifacts,
  so it is a property of the platform, not the dev loop (DEBUGGING.md:108-122). The only
  agent-visible check is evaluating `chrome.windows.create(...)` *inside the service worker*
  and attaching to the popup — which inspects *a* panel document, not the real side panel, and
  cannot exercise it.
- The **side panel opens only on a user gesture** — so every live-verify checkpoint hands the
  user numbered steps and waits (CONTINUITY.md:114-117). This is the mechanism behind the bug
  ledger's grimmest recurring phrase: every F1 bite was *"found live by the user."*
- The **chrome-devtools MCP cannot help**: its attach URL freezes at `aiui claude` launch (a
  browser relaunch strands it on a dead port — measured), and the MV3 service worker is never a
  `page` target, so the MCP cannot reach it (DEBUGGING.md:124-135).

So the edit→verify cycle is structurally gated on a human gesture for anything touching panel
behavior. That is architectural, not a missing script — and it is the single fact that most
justifies the harness.

## 2 · Two load-bearing facts about what already exists

**The wire never needed the extension.** The panel talks to the channel **directly over
loopback WebSocket/HTTP** (`panel/channel.ts:1-12`; thread ws at `main.tsx:263`, session bus in
`bus.ts` — which contains zero `chrome.*`). The extension relay carries only page-side traffic.
Native messaging is cold-start discovery only. The entire session/bus/wire/fold/trace stack
runs unchanged in a plain page — and if the **channel serves the panel page itself**, discovery
disappears entirely (the page's own origin *is* the channel), making the detached panel
*simpler* than the extension on this axis, not merely equal.

**The CDP plumbing is already written.** A CDP-based page transport is not greenfield; the repo
ships, working and measured:

| Capability | Where |
| --- | --- |
| Session-browser discovery (`DevToolsActivePort` + `/json/version`) | `aiui-util/src/browser.ts:56-88` |
| Launch with debug port + capture auto-accept flags | `browser.ts:126-217` (`--auto-accept-this-tab-capture`, `--auto-accept-camera-and-microphone-capture`) |
| `Extensions.loadUnpacked` re-point; `chrome.runtime.reload()` over CDP; eval in any extension context | `aiui-util/src/extension.ts:82-351` |
| **Auto-attach + script injection into every document, surviving navigation** | `aiui-util/src/capture-marker.ts:91-182` (`installCaptureMarker`) — flat-mode `Target.setAutoAttach` + `Page.addScriptToEvaluateOnNewDocument` |
| chrome-devtools MCP attach | `aiui/src/util/chrome.ts:581-612` |
| Dev-artifact stamp/probe oracle | `aiui-webext/src/dev-stamp.ts:63-75` |

`installCaptureMarker` is the decisive one: it already demonstrates the exact
attach-everything / inject-per-document / survive-reload pattern a CDP ink/key/selection relay
needs. The gap is a *relay protocol over these mechanisms, not the CDP plumbing itself.*

## 3 · The four architectures

One API asymmetry drives most of the matrix: the extension captures with **`tabCapture`**
(invocation-gated per tab, warm stream, 36–48 ms shot latency measured, **no visible capture
indicator**), while every non-extension host captures with **`getDisplayMedia`** (sharing bar,
gesture or auto-accept flag, one grant per document, ~320 ms acquire, a 30 fps standing decode
for the grant's life) — and **CDP's `Page.startScreencast` cannot back real video at all**
(JPEG frames at compositor cadence, no `MediaStream` — the explicit reason a server-side CDP
capture path was already rejected, `shot.ts:9-14`; stills via `Page.captureScreenshot` are
fine).

**A — MV3 side-panel extension (current).** The only host with `tabCapture`, real content
scripts, `chrome.tabs`/`chrome.commands`, and side-panel docking. Its fatal residual is not a
capability — it is the **drivability row**: an agent cannot open, see, or exercise the real
panel (§1). **Verdict: keep as the production host.** Nothing else delivers the capture UX.

**B — embedded in-page panel** (overlay-style; no extension). Full HMR and full agent
drivability — and two structural ❌s that are precisely why the extension exists: **no
multi-tab** (the overlay is scoped to its one mounted page) and **no surviving navigation** (a
reload destroys the overlay and all its state; the turn-continuity work exists because of
this). **Verdict: not a rescue path. It is what "overlay adopts the shared core + panel spec"
produces for free later — worth having, not worth building now.**

**C — external window driving pages via CDP only.** Multi-tab ✅ (Target domain), survives
navigation ✅, inherently agent-drivable ✅ — and: no real video (screencast limit), no
target-page mic story, every page capability re-delivered via `Runtime.evaluate`, and the
**unauthenticated CDP port becomes an always-on dependency of a shipped tool** (the posture
docs treat it as root-of-the-browser; widening what leans on it is a real cost). **Verdict:
not a product host. Its strengths are exactly a dev harness's strengths — which is what §4
builds.**

**D — detachable panel: a plain page + swappable page transport.** The panel document served by
plain Vite or by the channel itself (full HMR, normal debuggable page), the wire unchanged
(§2), page-side capabilities behind a transport: `ExtensionBus` in production (today's relay,
verbatim), `CdpBus` in development (the §2 plumbing), `FakeBus` in tests. Mic works *better*
than in B (a channel-served page has a stable origin, so the permission grant persists — same
property that motivated M9's panel-document mic). **In the audit's matrix, D is the only column
with no ❌** — it keeps B's HMR and drivability and A's multi-tab/survive-navigation, paying
with one transport abstraction whose interface already half-exists.
**Verdict: build D as the dev/test host. It is not a replacement product.**

## 4 · The detached harness, concretely

`aiui panel harness` (name TBD): serve `panel/index.html` as a plain page; bind to the real
channel; point the page transport at the session browser's CDP endpoint (or a fake). What each
disease-costly step becomes:

| Step today (extension) | In the harness |
| --- | --- |
| Edit panel .tsx → CRXJS artifact lifecycle → possibly reload extension → re-bind, re-arm, re-grant | **Vite HMR, sub-second, state preserved** |
| Verify a panel render → gesture-gated, agent-blind (§1) | **The panel is a normal page**: the devtools MCP screenshots it, clicks its caps, evaluates its state — an agent can finally verify its own panel work |
| Reproduce a machine bug → hand the user numbered steps | **dispatch commands directly** (the mode engine's single entry point) — or drive the real keys via CDP |
| Content-script edit → extension reload → orphaned scripts everywhere | CDP re-inject at will (`installCaptureMarker` pattern); the prod path stays for release verification |

**What the harness honestly does not cover** (say it in its banner): real `tabCapture` video —
CDP screencast cannot back the sampler, so video lanes run against fake frames or the real
extension; side-panel docking chrome; `chrome.commands` ⌘B (bound in-page instead); MV3
storage semantics (shimmed). Production verification still ends on the real extension. The
harness's job is making the ~95 % of iterations that never touch those cheap — and making the
panel *agent-drivable at all*.

### The seam, and a sequencing warning

The audit enumerates nine platform seams; three are already portable (wire: zero chrome;
persistence: two storage keys; asset URL: one call), and the tab-scoped RPC seam is
*ready-made* — `relay.ts` is pure codecs (`relay.ts:29-57`) with exactly three chrome-touching
functions (`:70-126`), and `content.ts`'s `serveRelay("page", {selection, viewport, ink,
keylayer, flash})` handler set **is the page-side contract** any transport must implement. The
work is: a `PageTransport` (`request`/`on`/`broadcast`) + `SurfaceTargeting`
(`activeSurface`/`onSurfaceChange`) facade, CDP and fake implementations (~2 functions each
behind an unchanged type surface), and routing `main.tsx`'s 20 inline chrome call sites through
it. Capture minting already takes its privileged half as a parameter
(`holdTabStream(tabId, mintStreamId)`, `capture.ts:69-77`).

The warning, verbatim from the audit because it is right: the obstacle *"is NOT the seam
count — it is that `main.tsx` interleaves all nine seams with the state machine, wire
composition, and JSX in one 1480-line file with no single transition function… a
PageTransport/SurfaceTargeting extraction is tractable — but it wants the machine split out
first, or the transport interface will re-tangle."* Hence the plan's ordering
([README](./README.md)): harness-with-fakes and the mode engine land together; the CDP
transport lands after the machine is out.

## 5 · The CRXJS question

CRXJS is load-bearing twice (`packages/aiui-webext/src/vite.ts:105-127`): the dev loader-stub
pipeline (which `devArtifact` exists to tame — stamping completeness because *"CRXJS's file
writer offers no public 'done' hook"*) and the production bundling (`crx({ manifest })`).

Once the harness carries daily development, CRXJS's dev value drops to near zero — and its dev
machinery is where all five F3 failure modes live. The remaining value is build packaging,
which plain Vite covers with a static multi-entry config (sw, content, panel) plus manifest
asset bookkeeping — boring, and boring is the point: a static artifact cannot half-exist.

**Recommendation: do not rip CRXJS out now.** Land the harness first; if it takes daily-driver
status (measure: a week of panel work without `aiui extension dev`), replace `webextConfig`'s
build path with a static config and delete the dev-artifact machinery — removing F3 at the
root rather than continuing to mechanize around it. The `aiui extension dev/reload` CDP
re-point stays either way (release verification needs it).

## 6 · Security posture

The harness adds no new surface: it talks to the channel (existing posture: loopback default,
`channel.bind` documented) and to the session browser's CDP port (existing posture:
unauthenticated loopback, project-local profile — docs/guide/chrome.md, warning.md). Two rules
carry over verbatim: the harness must refuse a non-loopback CDP target with the same tone the
docs already use (the CDP port is root of the browser), and — per option C's rejection — no
*shipped* workflow may come to depend on the CDP port; it remains a development affordance.
