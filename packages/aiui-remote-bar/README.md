# @habemus-papadum/aiui-remote-bar

The command bar as its **own channel** — the [aiui-pencil plan](../../docs/proposals/aiui-pencil-plan.md)'s
decision **D5**. The mode engine of a host page, projected over its own websocket, mounted as a
channel sidecar at its own URL, with a Solid client that renders the projected bar and dispatches
taps back. A remote client that is *just the bar* — no pencil, no video — is a first-class thing, and
any app with a mode engine gets a remote control surface by binding one socket.

Internal, `--no-publish`. It ships as source to its in-workspace consumers (the pencil iPad app, a
bar-only remote page); there is no bundle step.

## The shape

```
 host page (owns the mode engine)          a remote (bar-only page, or the pencil iPad app)
 ┌────────────────────────────┐            ┌────────────────────────────────────────────┐
 │ solidModeEngine / client   │            │ createRemoteBarClient → <RemoteBar/>        │
 │   bindRemoteBar(source,…)  │            │   renders rows, dispatches taps             │
 │      │ BarHost              │            │      │ BarClient                            │
 └──────┼─────────────────────┘            └──────┼───────────────────────────────────────┘
        │ ws /bar/host                             │ ws /bar/client
        └──────────────► the relay (backend.ts / barSidecar) ◄──────────┘
                         rooms · sessions · last-bar replay
```

The engine stays on the **host** — one machine, one truth. The remote holds no engine; it renders the
projection and sends a `command` back, exactly as the desktop panel is a projection of the same
engine. A second engine on the remote would be a second source of truth for state that is singular.

## The wire (`src/protocol.ts`)

Two message types cross a joined socket, and nothing else — no ink, no video, no WebRTC signaling:

| Direction | Message | Carries |
| --- | --- | --- |
| host → remote | `bar` | `rows: WireCap[]` (the `barModel()` projection), `claims` (per-name status phase), `phase?` |
| remote → host | `command` | `command: string`, `payload?` — the same verb a key or the agent dispatches |

Plus the relay-level session plumbing mirrored from `aiui-paint`: `register` / `join` / `leave` /
`sessions` / `joined` / `joinRejected` / `hostGone` / `clientJoined` / `clientLeft`. `encode`/`decode`
frame JSON text and **drop a malformed frame** (return `undefined`) rather than throw — one bad client
must not sink a relay serving others.

`WireCap` is a structural restatement of `aiui-viz/modal`'s `CapView` (the renderable subset: command,
payload, `{key,label,icon?,tone?}` hint, lit, enabled) so the node relay never imports the modal kit
or Solid. That restatement is only safe if the two can't drift, so `protocol.test.ts` holds a
**compile-time drift guard** — `const wire: WireCap = someRealCapView` — that fails to typecheck if
`CapView` drops or retypes a field the wire relies on. (The guard is genuinely enforced: this
package's tsconfig includes its test files in the typecheck, a deliberate strengthening over
aiui-pencil's convention, which excludes `*.test.ts` — see *Judgment calls*.)

## Host side — project a mode engine (`src/solid.ts`)

`bindRemoteBar` binds to the **narrowest structural interface** (`BarSource`), not a concrete class:
`bar()` / `claimStatuses()` / `state()` / `dispatch()` — exactly what `aiui-intent-client`'s
`IntentClient` already exposes, so it satisfies the binding with no adapter and no import.

```ts
import { bindRemoteBar } from "@habemus-papadum/aiui-remote-bar";
import { encode, decode } from "@habemus-papadum/aiui-remote-bar";

const ws = new WebSocket(`ws://127.0.0.1:${window.__AIUI__.port}/bar/host`);
const bound = bindRemoteBar(client /* IntentClient-shaped */, {
  send: (message) => ws.send(encode(message)),
  filter: (cap) => cap.command !== "disarm", // D5: the remote may see only a subset
});
ws.addEventListener("open", () => ws.send(encode({ type: "register", label: document.title })));
ws.addEventListener("message", (e) => {
  const m = decode(String(e.data));
  if (m) bound.host.receive(m); // a remote tap → client.dispatch(...)
});
// bound.dispose() on teardown
```

It republishes the bar on **every commit** (a `createEffect` over the projections) and once on
creation, so the relay's join-time replay always has a bar to hand out.

## Remote side — render the bar (`src/ui/`)

```tsx
import { createRemoteBarClient, RemoteBar } from "@habemus-papadum/aiui-remote-bar";

const client = createRemoteBarClient(); // defaults to `/bar/client` on this origin
render(() => <RemoteBar client={client} />, root);
```

`createRemoteBarClient` is the socket-free `BarClient` core wrapped in Solid signals behind a
**transport seam** (`transport?: BarTransportFactory`), so it drives in jsdom with a fake wire. It
auto-joins the sole host, exposes `sessions()`/`rows()`/`claims()`/`phase()`/`status()`, and renders
`joinRejected` / `hostGone` visibly. Styling is a **CSS-class contract** (`REMOTE_BAR_STYLES` is a
replaceable default), like aiui-viz's widgets.

## Mount the relay sidecar (`src/sidecar.ts`)

The relay is a **host-neutral backend** (`createBarBackend`, in `./server`) with two seams — an HTTP
handler and a websocket-upgrade handler. `barSidecar` packages it as a channel `Sidecar` at `/bar`:

```ts
import { barSidecar } from "@habemus-papadum/aiui-remote-bar/sidecar";
// mounted by the launcher; see below. Routes under /bar:
//   GET /bar/info  · /bar/health · /bar/sessions   (JSON, CORS)
//   WS  /bar/host  · /bar/client
```

It rides the channel's one port (no process, no extra listener). Whether a remote can **reach** it is
the channel's bind decision (`channel.bind` / `--aiui-bind`), never this sidecar's — the same posture
as paint. There is **no HTML route**: the channel serves no pages, and the bar's client is a
frontend-process component (paint's `/paint/` page is a documented exception for an iPad with no
frontend process; a bar remote is an ordinary app).

## Verified

`pnpm -C packages/aiui-remote-bar test` — 38 tests across two Vitest projects:

- **node** — `protocol.test.ts` (framing, the routing guard, and the CapView↔WireCap drift guard),
  `core.test.ts` (both endpoint cores over fake sends), `backend.test.ts` (the relay over a real `ws`
  server on an ephemeral port — join/leave, bar down, command up, busy, hostGone, last-bar replay,
  prefix, channel-registry resolution, malformed-target refusal);
- **dom** — `solid.test.tsx` (the host binding driving a real `solidModeEngine`: initial publish,
  republish-on-commit, the filter, inbound command → dispatch, dispose) and `RemoteBar.test.tsx` (the
  component over a fake wire: list → auto-join → render → tap-up-the-wire, hostGone, joinRejected).

The two projects exist because the package spans two realms with incompatible module resolution: the
`ws` relay needs node resolution (browser conditions resolve `ws` to a throwing stub), while Solid
under jsdom needs browser conditions + inlining (the finding `aiui-viz/vite.config.ts` records). Two
tsconfigs split the typecheck the same way (`tsconfig.json` browser/isomorphic + `tsconfig.node.json`).

## Changes outside this package

`aiui-viz` changes: **zero**. `BarSource` binds to the structural surface the intent client already
exposes; `CapView`/`ClaimStatus`/`KeyHint` were already exported from `aiui-viz/modal`. Nothing new
needed hoisting, so nothing was.

Everything else touched is the launcher wiring to make the sidecar always-on (mirroring paint) and its
tests, plus the lockfile:

| File | Change | Why |
| --- | --- | --- |
| `packages/aiui/package.json` | add `@habemus-papadum/aiui-remote-bar: workspace:^` | the launcher must resolve `…/sidecar` to an absolute path to hand the channel (paint is a dep for the same reason) |
| `packages/aiui/src/util/sidecars.ts` | register the always-on `bar` sidecar in `KNOWN_SIDECARS` | the descriptor seam paint uses; **always-on** per D5 + the task's guidance (a page with no mode engine just never dials `/bar/host`). `--aiui-no-sidecar bar` / `sidecars.bar: false` turn it off |
| `packages/aiui/src/util/sidecars.test.ts` | expect `[paint, bar]` and cover disabling each | the resolver's output set changed |
| `packages/aiui/src/util/channel-launch.test.ts` | update the expected sidecar sets (bar is now also always-on) | same reason; the two-launch-paths agreement test asserts the concrete set |
| `pnpm-lock.yaml` | regenerated by `pnpm install` | new package + the new `aiui` dependency |

No `aiui paint url`-style CLI subcommand was added for the bar: the remote derives its own
`/bar/client` URL from its page location, so there is nothing to print. Flag if a discovery command is
wanted later.

## Judgment calls

- **Last-bar replay** (a divergence from paint, in `backend.ts`): the bar is *event-driven* where
  paint's video is continuous, so the relay caches each host's last `bar` and replays it to a remote
  on join — otherwise a remote joining an idle host would see a blank bar until the next dispatch
  (never, if the app is quiet).
- **`/info` in the backend, not the sidecar**: paint special-cases `/paint/info` in its sidecar; I put
  `info`/`health`/`sessions` (all JSON + CORS) in the backend so the relay is fully testable in
  `backend.test.ts` without an Express app. The sidecar is a thin delegator.
- **Drift guard is really typechecked**: this package's tsconfig does **not** exclude `*.test.ts`, so
  `pnpm typecheck` enforces the `const wire: WireCap = capView` guard. aiui-pencil excludes test files
  from its typecheck, which would leave the same guard latent; I judged an enforced guard worth the
  one-line tsconfig difference.
- **`reveals` is dropped from the wire**: `CapView.reveals` names mode-scoped sub-widgets (springing
  sliders) — a pencil/overlay concern, not a bar-only remote's. `WireCap` omits it, matching the
  pencil's original restatement.
