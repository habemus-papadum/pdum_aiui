# aiui intent workbench — the no-agent lab

The workbench runs the **entire intent pipeline with no agent on the other end**. Its dev server
owns a **debug channel server** (`aiui-claude-channel serve`) that does everything the real one
does — voice models, the correction micro-pipeline, diffs, lowering, trace recording — but has no
MCP client attached, so a turn can never reach a Claude session. Instead, the final lowered
prompt is pushed back over the websocket (and printed to the terminal), and the page shows you
everything: half the window is a real app under the shipping intent overlay, the other half is
trace instrumentation.

That inversion is the point. In a live session, sending a turn *triggers an agent*; here you can
speak, ink, shoot, correct, and send as many turns as you like and only ever get **data** —
which makes the workbench the place to study raw pipeline output, iterate on the lowering, and
(eventually) collect interaction recordings for datasets.

*How to **use** the intent overlay lives in the guide
([docs/guide/intent-overlay.md](../../../docs/guide/intent-overlay.md)). This lab is for
**watching what it produces**.*

Private, never published. Its own workspace member (`@habemus-papadum/aiui-workbench`) inside the
overlay package's folder.

## Run

```sh
pnpm workbench            # from the repo root
WORKBENCH_RECORD=1 pnpm workbench   # + frame-log recording (JSONL under .aiui-cache/recordings/)
```

Once the UI is up, the workbench opens itself in the **session browser** — the same shared
Chrome window `aiui claude` attaches the agent to, with the same sidecar behavior as `aiui vite`
(the shared pieces live in `@habemus-papadum/aiui-util`): a running session browser (repo-root
profile) gets a new tab, otherwise one is launched. In headless environments (CI, SSH, no
display) nothing opens; it prints the URL to open on your own machine instead.
`WORKBENCH_BROWSER=0` never opens a browser; `WORKBENCH_BROWSER=1` opens one even where the
environment looks headless.

Put `OPENAI_API_KEY=sk-…` in the repo-root `.env.dev`
(gitignored; wins over a shell export) and the owned channel runs real transcription/correction;
without a key, switch the overlay to the `mock` tier (arm, **K**, **1**) and the whole loop runs
offline. Traces and recordings land in this package's own `.aiui-cache/` (gitignored), never in
the project's.

### Ports — fixed, on purpose

Everything `pnpm workbench` starts binds a **known** loopback port (`src/ports.ts` has the full
rationale), so you never have to fish addresses out of startup logs:

| Port | Server | Override |
| --- | --- | --- |
| **49222** | the workbench UI itself | `WORKBENCH_PORT` |
| **49223** | the debug channel server (`aiui-claude-channel serve --port …`) | `WORKBENCH_CHANNEL_PORT` |
| **49224** | the demo app's dev server (iframe scenery) | `WORKBENCH_DEMO_PORT` |

All three are strict: a taken port fails **loudly** at startup with an "is another workbench
running?" hint instead of drifting to a random port. The overrides (same `WORKBENCH_*` convention
as `WORKBENCH_RECORD`) are how you run a second workbench side by side. The page itself still
discovers the children through `GET /wb/api/servers`, which reports the ports actually bound —
the channel's arrives on its `AIUI_CHANNEL_SERVE` ready line (`src/serve-ready.ts`), never assumed
from the config.

## The layout

**Left — the app.** Pluggable scenery (`src/apps.ts`), two registrations today:

- **spectra (inline)** — the self-annotated absorption viewer (`src/scenery.ts`), mounted in-page;
  the workbench mounts the shipping intent overlay over itself (arm `` ` ``, Space talk, drag
  ink, D region-shot, S viewport-shot, E correct, K tiers, ⏎ send).
- **morphogen demo (iframe)** — the real `packages/aiui-demo` app, whose dev server the workbench
  starts programmatically with `VITE_AIUI_PORT` pointed at the debug channel. The demo brings its
  *own* overlay, source locator, and agent-tool surface, so this exercises full fidelity —
  including component location — against a real Solid app.

**Right — the dock**, one view over the owned channel: the lowering
**`TraceView`** — the same component the DevTools extension embeds, so
improvements land in both at once. It live-follows the newest turn and renders it
as a reading surface: a status header (sent / cancelled / abandoned / live), the
lowered prompt as a hero (context preamble dimmed, screenshots as thumbnails),
and every recorded stage as a compact, direction-coloured, filterable card. This
subsumes the old three-tab dock: the per-frame wire data lives in the trace's
input stages (open a card's *raw* disclosure), and the final prompt is the
selected trace's hero. Backed by shared `debug-ui` + `/debug/api/traces`.

Trace-list rows title themselves with the turn's **one-line summary** once it
lands (a small model glosses the sent prompt; see the channel's `summarize.ts`),
falling back to the format. They carry an **actor badge** when a trace wasn't produced by a human (the overlay
self-reports `meta.actor`; default `human`, opted into `agent` per tab via
`sessionStorage.setItem("aiui-actor", "agent")` — never inferred from `navigator.webdriver`,
which is browser-wide in the shared session browser), so agent-driven UI testing is tellable
from your own turns.

## Scripts

| Command | What |
| --- | --- |
| `pnpm dev` | the workbench (also spawns the debug channel + the demo app's dev server) |
| `pnpm test` | vitest — feed/pane helpers + the `bench/` unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm bench` | the standalone transcription benchmark (no GUI; REST latency/RTF/WER + a realtime-streaming leg; see the [audio-stack notes](./docs/openai-audio-stack.md)) |

## What the lab keeps vs. imports

The pipeline is a workspace dependency, resolved to **source** (editable installs — edit the
overlay or the channel, the workbench picks it up with no build step). The lab owns only its
scaffolding:

| Lab file | What it owns |
| --- | --- |
| `src/main.ts` | the shell: header, app slot, dock tabs, server discovery |
| `src/apps.ts` | the pluggable scenery registry (inline vs iframe hosting) |
| `src/scenery.ts` | the spectra app-under-test, self-annotated with `data-cell` / `data-source-loc` |
| `src/traces-pane.ts` | the dock's trace list + selection chrome (rendering is the shared debug-ui `TraceView`) |
| `src/serve-ready.ts` | the `AIUI_CHANNEL_SERVE` ready-line contract with the spawned server |
| `src/ports.ts` | the fixed 49222/49223/49224 port layout + `WORKBENCH_*PORT` overrides |
| `src/open-browser.ts` / `open-browser-cli.ts` | the browser sidecar: the `WORKBENCH_BROWSER` mapping + session-browser open (shared plumbing from `aiui-util`), and its tsx-spawned runner |
| `vite.config.ts` | spawns the debug channel (`serve --tag workbench --port …`) + the demo app's Vite server; `/wb/api/servers`; the browser sidecar |
| `bench/transcribe-bench.ts` | say-synthesized latency/RTF/WER benchmark (REST + realtime legs) |
| `fixtures/` | captured interaction event-streams; replayed by the overlay's `intent-pipeline/fixtures.test.ts` |

| Imported | What it provides |
| --- | --- |
| overlay main entry | `mountIntentTool` — the shipping widget, mounted un-modified |
| `…/debug-ui` | `TraceView`, `createTracePoll`, `renderJsonTree` — shared with the DevTools extension |
| the channel (spawned, not imported) | transcription, correction, lowering, traces, the frame log |

The old lab-only machinery — the hand-wired engine/keymap page, the settings drawer, the
browser-side `openai` dev-proxies (`/api/transcribe`, `/api/chat`) — is gone: the shipping
overlay's K strip + advanced-config panel cover the knobs, and the real channel-side backends
cover the models. The mock tier remains the offline mode, selected like any other tier.

## Docs

- **[The turn flow — an evaluator's guide](./docs/turn-flow.md)**: scenario walkthroughs (written
  against the pre-graduation lab; keys and pipeline behavior unchanged).
- **[The OpenAI audio stack](./docs/openai-audio-stack.md)**: model choice, cost framing, silence
  gating, priming, audio-back; first benchmark results.
- **[Open questions & graduation criteria](./docs/open-questions.md)**: what graduated, what's
  still open (T1–T7).
- **[Field notes](./docs/field-notes.md)**: engineering residue — correction micro-pipeline,
  selection vs lasso, typing-guard truths, browser gotchas.
