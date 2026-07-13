# @habemus-papadum/aiui-intent-client

The greenfield intent client (plan of record:
[docs/proposals/intent-client](../../docs/proposals/intent-client/README.md)): a detached
plain-page panel built Solid-native on the aiui-viz **mode engine**, host-agnostic behind a
small transport seam. The MV3 extension will be a *shell* added last — one more transport plus
a static build — not the app's home. Never published (`--no-publish`); it graduates when the
parity gate passes.

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

## Status / road to parity

Built and tested: the machine, claims, keys, caps, FakeBus harness. Next, in order
(README plan, Phases 2–5):

1. **The page**: a Solid panel UI (bar, phase pill, keymap help, preview, trace) served as a
   plain page — by the channel ideally — with the wire lanes (`intent-pipeline` Engine,
   `createWire`, talk, video sampler) bound as `IntentLanes`/claims appliers. Daily dev in the
   harness; the devtools MCP drives it.
2. **`CdpBus`**: the transport over the session browser's CDP plumbing
   (`installCaptureMarker` pattern) — real tabs, still extension-free.
3. **The MV3 shell**: `ExtensionBus` + the copied 141-line SW broker + a **static** Vite build
   (no CRXJS, ever). New extension identity — see coexistence rules in the plan.
4. **Parity gate**: walk the [inventory](../../docs/proposals/intent-client/04-parity-inventory.md)
   row by row; then the old extension retires to safety-net status.

Coexistence policy (decided): this client refuses to arm on a tab the old extension's ring
marker claims; durable keys on shared pages use the `aiui2.` prefix when the page shell lands.
