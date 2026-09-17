# GPT-Live probe — exploration

Standalone spike (not wired into anything) behind
[`docs/proposals/oracle-live.md`](../../docs/proposals/oracle-live.md): open real
`gpt-live-1` sessions over the primary WebSocket, play synthesized speech as the
user, and measure what the delegation loop actually costs in time.

Self-contained — its own `node_modules`, nothing from the workspace. Needs the
parent `OPENAI_API_KEY` in the environment (the same one the channel uses).

```sh
npm install
npm run probe -- models context client long responses   # any subset, in order
```

| Scenario | What it measures |
| --- | --- |
| `models` | which Responses backend models `session.start` accepts (all four tried were accepted) |
| `context` | `session.thinking.append` with `delegation_id: null` before any delegation; the 500-token limit; an unknown delegation id; whether the model answers from quiet context without delegating (it does) |
| `client` | client delegation with a fast reply: utterance end → `session.delegation.created` → `commentary.append` → spoken |
| `long` | a 25 s client task with quiet + spoken progress and a second question mid-task (overlapping delegations) |
| `responses` | Responses delegation (`gpt-5.6-terra`, `effort: low`) with a function tool: the full `response.event` → `response.item.create` → `response.create` loop |
| `sideband` | attach a second socket by session id; 404 for a WebSocket-primary session (the sideband is documented for WebRTC/SIP) |

Each session writes `out/<scenario>.jsonl` (every event except audio, stamped
with wall-clock ms since socket open) and `out/<scenario>.wav` (the assistant's
audio, 24 kHz mono). Synthesized utterances are cached in `out/tts/`.

Measured 2026-09-15 (see the proposal's §4 for the table): session start
0.5–0.9 s; delegation 0.5–0.8 s after the user stops; a commentary append is
spoken ~0.5–0.7 s after it is sent; the hosted function-tool loop runs 2.9 s
end-to-end; a 25 s task with a question inside it held together.

## The Claude Agent SDK spikes (2026-09-15)

Two throwaway scripts that settled how Claude Code behaves as a delegation
backend before `packages/aiui-live/src/claude` was written:

```sh
node claude-auth-spike.mjs      # does query() work here with no ANTHROPIC_API_KEY?
node claude-stream-spike.mjs    # streaming input: mid-turn messages, interrupt(), an MCP say tool
```

Findings (the reasons the delegator is shaped the way it is):

- `query()` authenticates through the CLI's own login (`apiKeySource: none`);
  no API key is needed. Init ≈ 2 s; a trivial haiku turn ≈ 4.5 s end to end.
- In streaming-input mode a user message pushed WHILE a turn is running is not
  interleaved — it was never answered — so delegations must be serialized:
  push the next only after the previous turn's `result`.
- `interrupt()` aborts the running turn (`result/error_during_execution`) and
  the query stays alive for the next message. That is the cancel path.
- MCP tools are deferred behind ToolSearch by default; the first `say` cost a
  ~4 s detour. `alwaysLoad: true` on the server/tools avoids it.
- Without `settingSources: []` + `strictMcpConfig` the agent inherits every
  MCP server in the user's settings (six here) — isolate the backend.
- Installing the SDK's per-platform binary package (a ~210 MB single-file
  tarball) crashes pnpm with `invalid array length` / heap OOM — under Node
  24.4.0 only: a Node regression (nodejs/node#59057, fixed in 24.5). pnpm
  11.9.0 under Node 24.5.0 and 24.11.1 installs it in under a second. The
  repo requires Node ≥ 24.5 for this reason (`.nvmrc`, `engines`), and the
  SDK spawns its own bundled, version-matched CLI by default.
