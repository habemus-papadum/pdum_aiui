# mcp-list-changed — M3

Does Claude Code (as an MCP client) honor `notifications/tools/list_changed`?

- `server.mjs` — dependency-free stdio MCP server. Starts with `probe_alpha`; after the first
  `tools/call` of alpha it adds `probe_beta` and (unless `LISTCHANGED=no`) emits
  `notifications/tools/list_changed`. Every wire message is appended to a JSONL log.
- `run-m3.mjs` — spawns the real `claude` CLI four ways and prints wire digests:
  - **A** one process, two turns (stream-json input): flip+notify lands between turns.
  - **B** fresh process against a pre-flipped server (sanity).
  - **C** silent-flip control: no notification — does the client ever re-list on its own?
  - **D** mid-turn: one turn calls alpha then immediately beta; the notification arrives while
    the model is inside the turn.

```sh
node run-m3.mjs          # M3_MODEL=sonnet to override the default (haiku)
```

Notes: the driver strips `ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`BASE_URL` (an inherited key overrides
the claude.ai login and failed every turn) and `CLAUDECODE` (it spawns claude from inside a
claude session). Results and interpretation live in `../RESULTS.md`.
