# Migrating from `aiui-paint` + `aiui-ink` to `aiui-pencil`

Status: **handoff** (July 2026). Audience: whoever integrates the pencil into the dev overlay /
intent client (phase 5 C4 and phase 7 of the [plan](./aiui-pencil-plan.md)) — i.e. you have code
that talks to `aiui-paint`'s relay and draws with `aiui-ink`'s `InkSurface`, and you are replacing
both. The [design](./aiui-pencil.md) says why everything is the way it is; the plan's **Decisions**
section (D1–D5) records the calls that shape this migration. This document says only *what to do*.

**The honest size of the refactor: small.** The surface is a near drop-in, the host-side code gets
*shorter* (the library now owns everything WebRTC), and the iPad client you maintained as a served
page is replaced by a built app you don't maintain at all. The one conceptual change is that
**arming moved**: paint's `setArmed` intent is gone, and arming is a mode-engine command over the
bar channel (D5). Everything below is mechanical except that.

## The five swaps

| You had | You now have | Size of change |
| --- | --- | --- |
| `InkSurface` (aiui-ink) | `PencilSurface` | renames + one deletion (see table below) |
| `paint-host.ts` (capture → JPEG pump → ws; intents → surface) | one `HostSession` | ~150 lines become ~30 |
| paint's served iPad page (`/paint/`) | the built client at `/pencil/` | delete yours; nothing to write |
| `paintSidecar` in the launcher | `pencilSidecar` + `barSidecar` | already registered (always-on) |
| `setArmed` over the paint wire | an arming command over `/bar` | the one real design change |

## 1. `InkSurface` → `PencilSurface`

| `InkSurface` | `PencilSurface` | Notes |
| --- | --- | --- |
| `new InkSurface({...})` | `new PencilSurface({ params, tool?, fadeSec?, ... })` | `params` is required: the brush is explicit now (`resolveParams(mode)` for the shipped presets) |
| `setActive(on)` | `setActive(on)` | same meaning; **no-op when `localInput: false`** — an inputless surface never owns the pointer (a full-page overlay armed by habit once swallowed every click on the host page) |
| fade (hold→pop) | `fadeSec` option + `fadeCurve: "warp"` (default) | same curve, same feel |
| — | `fadeCurve: "crossfade"` | the preview handoff dissolve (D3) — width never warps, tile reused, fade is free |
| `clear()` | `clear()` | plus `clearAnimated(sec?)`: every stroke rides the pop — also D4's retire move on viewport change |
| — | `undo()` | ordered replay makes it free; **undoing an eraser restores the erased ink** |
| — | `ink()`, `subscribe(l)`, `inkSignals(surface)` | the drawing as data/signals (committed + live strokes) |
| `compositeInto(ctx, …)` | **gone, deliberately** | it was a double-draw bug — tab capture already contains the ink ([capture-plane note](./element-capture-and-the-capture-plane.md)). Delete your call site in `grab()`; the capture is the single source of ink pixels |
| stroke events | `onStrokeStart/onStrokeEnd/onRemoteStrokeEnd/onAutoClear` | superset |

Overlay-specific contract (D2 + a measured bug): a viewport overlay must be **`position: fixed`,
sized `100vw/100vh`** — not `100%`, which excludes classic scrollbar strips while the tab capture
includes them; every remote stroke then lands compressed by exactly the sliver ratio (measured:
sent u = 0.45, landed 0.4436 = 0.45 × 1035/1050). Leave `background` unset (overlay ink floats over
the live page); a scratchpad canvas sets it, because video has no alpha and a transparent canvas
streams as ink-on-black.

## 2. The host: `paint-host.ts` → `HostSession`

You no longer touch a websocket, a JPEG, or an `RTCPeerConnection`. The whole host side is:

```ts
import { HostSession, hostRelayUrl, PencilSurface } from "@habemus-papadum/aiui-pencil";

const overlay = new PencilSurface({ localInput: false, params: currentParams, fadeSec, ... });
Object.assign(overlay.canvas.style, { position: "fixed", zIndex: "...", width: "100vw", height: "100vh" });

const session = new HostSession({
  url: hostRelayUrl(),                       // ws://<origin>/pencil/host — the channel port page
  label: document.title,
  surface: () => overlay,                    // remote strokes land here, via remote*()
  params: (mode) => resolveParams(mode),     // the HOST owns the brush (wire carries mode, never params)
  stream: () => capturedStream,              // your getDisplayMedia track — undefined until granted
  streamHint: () => "arm capture on the desktop",
  onScroll: (du, dv) => { window.scrollBy(du * innerWidth, dv * innerHeight); overlay.clearAnimated(0.35); }, // D4
  onStatus: (s) => statusSignal.set(s),
});
session.connect();
// when the capture grant lands / is revoked / the plane changes:
session.refresh();
// when a capture attempt fails:
session.deny(`${err.name}: ${err.message}`);
```

The worked, running example is the Lab's `lab/src/model/remote-host.ts` (~150 lines *including* the
two-plane switching and the `getDisplayMedia` ceremony). Key behaviors you get for free: reconnect,
per-viewer peer connections with re-offer on `refresh()`, ICE via the relay's peer-addressed
`signal` frames, `videoStatus` (`needsGesture`/`denied` with your detail — no viewer ever stares at
unexplained black), and a capture keepalive hook (`keepWarm`) for canvas planes.

Capture notes that will save you an afternoon: `navigator.mediaDevices` is **undefined outside a
secure context** — a LAN-IP http page cannot capture; host pages live on localhost (or https).
The session browser's `--auto-accept-this-tab-capture` skips the picker, but the call still needs
transient user activation (a real click). And Chrome pauses rAF in hidden tabs — a backgrounded
host tab stops producing canvas-capture frames.

## 3. The wire (you mostly don't see it anymore)

If you had code speaking paint's JSON directly, the mapping:

| paint v1 | pencil v2 | Why |
| --- | --- | --- |
| `strokeBegin { style: {color,width} }` | `strokeBegin { tool, mode }` | the host resolves the brush; strokes carry *which end of the instrument* (`draw`/`erase`) and *which preset* |
| `NormPoint { u,v, pressure?, time? }` | `WirePoint { u,v,t, p?, alt?, az? }` | the whole pen travels — dropping tilt would silently kill the charcoal half |
| JPEG binary frames + `frame` pacing | **gone** — `MediaStreamTrack` over `RTCPeerConnection` | D1: WebRTC-only; the relay carries only `signal` (offer/answer/ICE, peer-addressed) |
| `viewState` (viewport/scroll/zoom metadata) | **gone** | D2: the plane is the captured rectangle; `u,v` of the video IS `u,v` of the ink surface — no metadata to sync |
| *(never existed)* `inkAck` | **still doesn't** | D3: previews retire on a ~500 ms crossfade from pen-up (`fadeWindowMs()`, adaptive from `ClientSession.stats()`), not on frame correlation |
| `setArmed` | **moved to the bar** | arming is host state → a mode-engine command over `/bar` (D5) |
| `scroll` / `zoom` | `scroll` / `zoom` | unchanged shapes; still pencil intents (continuous gestures don't belong in a reducer) |
| — | `undo`, `clear` | new remote edits |

## 4. The bar channel (where `setArmed` went)

The client's command surface is `aiui-remote-bar` — its own sidecar (`/bar`), socket, and package
(D5). Your page already has a `solidModeEngine`; binding it is:

```ts
import { bindRemoteBar, encode, decode } from "@habemus-papadum/aiui-remote-bar";
// on a ws to ws://<origin>/bar/host, after `register`:
const bound = bindRemoteBar(engineAsBarSource, {
  send: (m) => ws.send(encode(m)),
  filter: (cap) => REMOTE_VISIBLE.has(cap.command),   // D5's remote subset, if wanted
});
ws.onmessage = (e) => { const m = decode(e.data); if (m) bound.host.receive(m); };
```

`BarSource` is structural (`bar() / claimStatuses() / state() / dispatch()` — what the intent
client already exposes). A page with no engine can hand-roll one — the Lab's
`lab/src/model/bar-host.ts` projects plain `action()`s. Remote taps dispatch through the same
single-writer path as local keys; the arming cap is just a cap.

## 5. The client (delete yours)

The sidecar serves the built client app at `GET /pencil/` (`aiui pencil url` prints the URL to open
on the iPad, exactly like `aiui paint url` did). It already has: session picker, WebRTC video, a
real `PencilSurface` preview with the D3 crossfade, pencil-mode/palm rejection/two-finger
navigation, draw/erase + write/sketch + undo/clear, and the bar (auto-joins when there is exactly
one bar host). Its sources are `lab/src/client/` — a thin consumer of `ClientSession`; rebuild with
`pnpm -C packages/aiui-pencil build:client`.

Known seam: pencil rooms and bar rooms are joined independently. With one host page per channel —
the deployment reality — the bar auto-join pairs them; with several hosts on one relay the user
picks twice. If that ever matters, the fix is a shared pairing token in both `register` messages.

## 6. Triage, because WebRTC is less transparent than "are JPEGs arriving"

- **No video, client says why** → read the note: `needsGesture` (host hasn't granted), `denied`
  (grant failed — detail is verbatim), secure-context message (host opened via LAN IP).
- **Video frozen** → is the host *tab* hidden? rAF pauses; use a separate window. Canvas plane
  quiet? The keepalive should be repainting — check `keepWarm` is wired.
- **Strokes offset from the picture** → the D2 contract is broken somewhere: the overlay isn't the
  captured rectangle (scrollbar slivers, `100%` vs `100vw`), or the client's plane isn't tracking
  the video's own `resize` events.
- **Session list has ghosts** → dead hosts persist until the 30 s heartbeat reaps them (≤2
  cycles). The list shows id + connect time so a human can pick the newest.
- **Sanity-check the seam with no browser at all** → `packages/aiui-pencil/src/sidecar.test.ts`
  mounts both sidecars on a plain Express server exactly the way the channel does, and drives real
  websockets through them. If that passes and your page still fails, the problem is in the page.

## What is left after this migration

Delete `aiui-ink` and `aiui-paint` (including `compositeInto`'s call site in `shot.ts` and the
`sidecars.paint` launcher entry once nothing dials `/paint/`), grow the intent client's ink claim
with `tool`/preset, and wire the capture plane (`restrictTo`) per the
[capture-plane note](./element-capture-and-the-capture-plane.md) — the pencil side needs nothing
more for any of that.
