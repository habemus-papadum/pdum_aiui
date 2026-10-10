# @habemus-papadum/aiui-live

The live oracle — a full-duplex voice front (OpenAI GPT-Live over WebRTC in the browser,
WebSocket in node) with pluggable delegation backends: local tools, hosted Responses, a relay
to a server, or Claude Code through the Agent SDK.

## Install

```sh
npm install @habemus-papadum/aiui-live
```

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
