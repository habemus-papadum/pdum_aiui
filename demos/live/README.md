# demo: live — GPT-Live, four pages deep

The hands-on companion to `docs/proposals/oracle-live.md`. A tour first, then three live pages,
read in order, each one layer more integrated than the last; the live pages share one bench
(`src/live/Bench.tsx`).

| page | what it is | what you measure |
| --- | --- | --- |
| `/tour.html` | the mental model: every session parameter (a builder), every wire event, the three appends (a lab), the event flow run by the REAL engine against a fake OpenAI in the tab (a simulator with the measured timings as knobs), the backends, where the keys live (a probe), exactly how Claude Code is wired (an options builder that shows the `query()` call and the spawned argv, plus the SDK's full option catalog), sessions and forks | nothing is billed: no OpenAI or Claude call is made; twiddle the timings, read the ledger, build a config |
| `/wire.html` | the voice connection with a scripted backend and a delay slider | delegation latency after you stop talking, append → first spoken word, the 15 s WebRTC charge, echo with a laptop mic, the "still working" policy past 9 s |
| `/backends.html` | three toy tools and every backend: scripted, echo, Responses (browser key / server), Claude Code (server), hosted Responses | how each backend narrates a 30-second lookup, two open tickets at once, what a reasoning model costs in seconds of voice |
| `/` | the aiui app: an oscillator whose control surface is the backend's tool set | "set the frequency to four" through typed tools; "why does it look jagged?" answered by Claude Code reading `src/model/graph.ts` |

## Run

```sh
pnpm -C demos/live dev        # Vite + the live backend (broker + relay) on the same origin
```

Needs `OPENAI_API_KEY` in the environment (direnv at the repo root). The dev server holds the key:
the page gets a session by posting its SDP offer to `/live/sessions`. The `aiui` plugin also injects
the key as a dev key, so the in-browser backends work without pasting. Claude Code as a backend needs
a logged-in `claude` on this machine (no API key; the SDK rides the CLI's login).

A built (static) copy of these pages still works with a pasted key and the browser backends — the
server-side ones need `runLiveServer` from `@habemus-papadum/aiui-live/node` somewhere.

## Without a microphone

```sh
pnpm -C demos/live headless scripted
pnpm -C demos/live headless responses "set the frequency to four hertz"
pnpm -C demos/live headless claude "why does the trace look jagged when the samples are low?"
```

A real session over WebSocket, synthesized speech as the user, the backend in-process, the
assistant's audio written to `out/<backend>.wav`. Every event with its time since connect goes to
the terminal; the task timings are printed at the end.

## What to listen for

- The voice model paraphrases what the backend says. "Frequency set to 5 hertz." becomes "Done."
  Exact wording goes through `steer` (an instructions append), not `say`.
- Silence is billed. The session closes itself after two idle minutes and re-seeds the next one
  from its own transcript — the oracle's free park does not exist here.
- Claude Code speaks only through `say`; its text and tool calls show under the task as log lines.
