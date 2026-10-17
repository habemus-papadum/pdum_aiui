# @habemus-papadum/aiui-live

> **Internal scaffolding** for this repo's labs and demos. Not published; the demos and the
> gallery consume it in-workspace (`workspace:^`). A replacement is planned — see
> [the October 2026 plan](../../../docs/proposals/viz-plan-2026-10.md).

The live oracle — a full-duplex voice front (OpenAI GPT-Live over WebRTC in the browser,
WebSocket in node) with pluggable delegation backends: local tools, hosted Responses, a relay
to a server, or Claude Code through the Agent SDK.

## Install

In-workspace only: `"@habemus-papadum/aiui-live": "workspace:^"` in a demo's `package.json`.

## Read next

- [The two-model voice loop, in plain words](./docs/live-primer.md) — the ideas and the
  vocabulary, no API knowledge assumed.
- [The oracle and GPT-Live](./docs/oracle-live.md) — what changes against the Realtime
  oracle, what was measured, and what was built from it.
- [Testing patterns for realtime vendor APIs](./docs/live-api-testing.md) — the scripted
  user, the injectable socket, the real-wire smoke.
- The two measurement reports: [hosted-mode overlap](./docs/live-hosted-overlap-findings.md)
  and [Claude Code mid-turn messages](./docs/claude-sdk-midturn-findings.md).
- [Delegation trees](./docs/live-delegation.md) — the unbuilt design for routers, races,
  fallbacks, and preemption.
- [Getting started](./docs/getting-started.md); `demos/live` is the worked example, with a
  headless harness that needs no microphone.
