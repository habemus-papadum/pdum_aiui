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
