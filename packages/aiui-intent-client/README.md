# @habemus-papadum/aiui-intent-client

The greenfield intent client (plan of record:
[docs/proposals/intent-client](../../docs/proposals/intent-client/README.md)): a detached
plain-page panel built Solid-native on the aiui-viz **mode engine**, host-agnostic behind a
small transport seam. The MV3 extension is a *shell* — one more transport plus a static build,
added last on purpose — not the app's home. Never published (`--no-publish`); it graduates when
the parity gate passes.

Three hosts, one client. The same machine, claims, keys, bar and lanes run under all of them;
what changes is who reaches the page:

| Host | Reaches the page via | Capture | Where it runs |
| --- | --- | --- | --- |
| `FakeBus` | an in-memory effect log | fabricated | every harness test, and the dev page host-less |
| `CdpBus` | the session browser's CDP endpoint (no extension at all) | `Page.captureScreenshot` — **grantless**, stills only | the channel-served plain page (`/intent/`) |
| `ExtensionBus` | `chrome.tabs.sendMessage` → the content script | `tabCapture` — a real, invocation-gated grant; a warm stream, so continuous video | the MV3 side panel |

That the extension is the *last* thing built, and needs no change to the client, is the design
paying out.

## The shape

| Layer | File | What it is |
| --- | --- | --- |
| The machine | `src/spec.ts` | Regions, commands, esc/blur, excludes — the old panel's 1,500-line conductor as ~150 lines of data. Every row traces to the [parity inventory](../../docs/proposals/intent-client/04-parity-inventory.md). |
| Operations | `src/claims.ts` | The five hand-called `sync*` functions of the old panel, re-expressed as derived claims a reconciler drives. Per-claim status is the UI's warming/live/failed truth. |
| Keyboard | `src/keys.ts` | The salvaged in-turn grammar on the modal-kit resolver; every binding resolves to an engine command. Unknown in-turn keys swallow + blip. |
| Command bar | `src/caps.ts` | Caps as projections (lit/enabled/shown/reveals derived); a tap dispatches the same command as the key. |
| The seam | `src/transport.ts` | `PageTransport` / `SurfaceTargeting` / `CaptureSource` — the only things a host must provide. The page-side contract is the old relay's (`ink` / `keylayer` / `flash` / `selection` / `viewport`). |
| Fake host | `src/fake-bus.ts` | In-memory host with a readable effect log — what every harness test (and the dev page, host-less) drives. |
| The client | `src/client.ts` | One constructor: engine + claims + verb effects + key entry + bar. No `chrome.*`, no CDP, no DOM. |
| The lanes | `src/lanes.ts` | The wire: the `intent-pipeline` Engine, `composeIntent`, the turn thread, talk, the video pump. What the client's verbs *do*. |
| CDP host | `src/cdp/` | The bus over the session browser's protocol + the page bootstrap it injects (stringified, so it may import nothing) + the ink surface it evaluates in. |
| MV3 host | `src/ext/` | The bus over `chrome.*`, the service-worker broker (the only context that can mint a `tabCapture` id), the content script (a real module — it *imports* the ink and the structured selection watcher), and the side panel that composes them. |

State discipline (the write-semantics ground rules, enforced by construction):

- **One writer.** Keys, cap taps, agent `control.set` (the engine's agent bridge), system
  events — every state change is `dispatch(command)`, `flush()`-committed: when a dispatch
  returns, state, memos, and effect-driven projections are all current.
- **No mirrors.** `videoOn`/`videoMode` are agent-visible *ports of the engine* — the desync
  class that produced the old `videoOnLive` bug cannot be expressed.
- **No hand-called syncs.** Outbound obligations are claims; a forgotten sync is structurally
  impossible.

## Testing

`spec.test.ts` is the §13.6 table as rows; `client.test.ts` is the bug ledger as passing
harness tests (each `// ledger:` comment names the incident the row would have caught), driven
entirely through `dispatch()` + the FakeBus. Run `pnpm test`.

## Running it

**As a plain page** — no extension, real tabs. `aiui claude` serves it at
`http://127.0.0.1:<channel-port>/intent/` and drives the session browser over CDP.

**As the side panel** — the MV3 shell:

```sh
pnpm -C packages/aiui-intent-client ext   # build the bundle, load it into the session browser
```

That is `build:ext` (Vite for the panel, esbuild for the content scripts and the worker — no
CRXJS, ever) followed by `load:ext`, which is "Load unpacked" without the human: CDP's
`Extensions.loadUnpacked` against the running session browser. Then **⌘B** on the tab you want
to drive — the chord and the toolbar button are extension *invocations*, and an invocation is
what mints the `tabCapture` grant, so they are what opens the panel and the turn together.

Installing it is a deliberate act rather than something `aiui claude` does for you: the frozen
extension is still auto-loaded, and two extensions cannot both hold ⌘B (Chrome drops the second
binding without saying so). Which client the launcher loads is the parity gate's switchover.

## Status / road to parity

Phases 0–4 are done: the machine, claims, keys, caps and FakeBus harness; the wire lanes and the
channel-served page; the `CdpBus` (real tabs, no extension); and the MV3 shell (`ExtensionBus`,
the salvaged SW broker and warm-shot capture path, a static build, a new extension identity,
`aiui2.*` storage). All three hosts are verified live.

Left: the **parity gate** — walk the
[inventory](../../docs/proposals/intent-client/04-parity-inventory.md) row by row against
[PARITY.md](./PARITY.md), settle the open `DECIDE`s, then flip the launcher to this client and
retire the old extension to safety-net status.

Coexistence policy (decided, and now enforced): the two clients are separate extensions with
separate ids and separate storage (`aiui2.*`), and **never both armed** — the content script
watches the frozen client's ring for its `armed` class, reports it as a `foreign` fact, and the
machine's `arm` gate refuses on a tab it holds. The gate is real: `dispatch` consults
`spec.available`, so a key or an agent write cannot walk past what the bar dims.
