# Getting Started with @habemus-papadum/aiui-live

> This page lives at `packages/aiui-live/docs/getting-started.md`, beside the package's other
> guides. The package overview is the `README.md`; the API is `src/index.ts`.

The live oracle — a full-duplex voice front (OpenAI GPT-Live over WebRTC/WebSocket) with
pluggable delegation backends: local tools, hosted Responses, or Claude Code.

## Install

```sh
npm install @habemus-papadum/aiui-live
```

## Where to start

Read [the primer](./live-primer.md) for the two-model loop in plain words, then
[oracle-live.md §10](./oracle-live.md#10-what-was-built) for the shape that was built:
`LiveSession` (the task table, the append/ack ledger, the two transcript tracks, idle close
and re-seed), the transports (WebRTC in the browser, WebSocket in node under
`@habemus-papadum/aiui-live/node`), the key brokers, and the delegators (`handle(req)` with
`say`/`note`/`steer`/`log`): a scripted stand-in, a Responses loop, a relay to a server, and
Claude Code through the Agent SDK (`@habemus-papadum/aiui-live/claude`).

`demos/live` is the worked example — the tour page shows every wire event, and
[`scripts/headless.mts`](../../../demos/live/scripts/headless.mts) drives a real session with
a synthesized voice as the user, no microphone needed
([how that works](./live-api-testing.md)). The voice dock (`@habemus-papadum/aiui-dock`)
mounts a live session beside any aiui page.
