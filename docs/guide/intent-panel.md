# The Intent Panel

The **intent client** is aiui's frontend for the prompt-lowering pipeline — the surface where
dictation, screenshots, screen share, selections, and pencil ink over a live page become one
briefing in the running Claude Code session. One client, one mode-engine core, two hosts: the
**MV3 side panel** (`dist-ext`, the one extension `aiui claude` auto-loads into the session
browser, with warm `tabCapture` video) and the **channel-served plain page** at `/intent/`
(drives real tabs over CDP, no extension). The decided behavior contract is
[`BEHAVIOR.md`](https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-intent-client/BEHAVIOR.md)
in the package; the host-agnostic capture/transport runtime is
[`aiui-intent-runtime`](/packages/aiui-intent-runtime/).

This page is the feature reference. Each section is one feature as the user meets it; details
that only matter when changing the code stay in `BEHAVIOR.md` and the package docs.

## Arming a tab

<kbd>Cmd/Ctrl</kbd>+<kbd>.</kbd> both opens the panel and **invokes** the tab — the invocation
is what grants `tabCapture` standing, not merely a shortcut. Arming rides the connection; two
clients are never both armed. If the chord didn't bind (another extension claimed it), set it at
`chrome://extensions/shortcuts`. _TODO: the leader (which tab the client is aimed at), pausing a
turn, SPA-navigation continuity._

## The turn

Hold <kbd>Space</kbd> to talk — push-to-talk windows are the turn's segments and its boundaries
(no client-side endpointing). Everything you capture lands in the transcript preview in the order
it happened, and the compiler (`composeIntent`) assembles the briefing **verbatim** from exactly
that — the preview is a read-only render of the compiler's accumulator, so what you see is what
will be sent, by construction. The event stream is append-only: there is no transcript editor,
and a mistranscription is fixed by **saying the correction** — it becomes new content the agent
reads in context. The **segment editor** allows selective fixing of a turn (re-speaking one
segment rather than the whole thing). _TODO: sending, the sink, and what a paused turn keeps._

## Dictation — the transcription engines

<kbd>K</kbd> opens the config strip; digits pick the engine. Three engines, presented by
interaction shape (streaming vs request-response is the property you feel):

| Engine | Notes |
| --- | --- |
| 🎬 **Scribe v2** *(default when available)* | ElevenLabs `scribe_v2_realtime`. Word timestamps **and** logprobs on every final, `keyterms` biasing, fillers stripped. Needs `ELEVEN_LABS_API_KEY`. |
| 🎯 **GPT-4o Transcribe** | `gpt-4o-mini-transcribe` over the realtime WS — streams deltas and returns token logprobs (the confidence heat map lights up). |
| ⚡ **Realtime Whisper** *(the fallback)* | `gpt-realtime-whisper`. No keywords, no logprobs — no heat map on this engine. |

The default is availability-aware: no ElevenLabs key falls back to Realtime Whisper with a
visible note, recorded as a coercion on the trace. The preview renders low-confidence words with
a warm tint (normalized against the turn's own logprob range — hover for the raw value); word
timestamps give screenshots **exact** text anchors, replacing the latency estimate. `keywords`
in the pipeline config is the domain-vocabulary bias slot (config-only today).

## Shots, share, and selections

<kbd>D</kbd>/<kbd>S</kbd> take deliberate screenshots (element-located and whole-viewport);
selections on the page (app text or code) travel as structured events with source attribution.
<kbd>V</kbd> starts a screen share whose sampled frames **are shots**: each lands in the preview
at the moment it was taken, compiles into the prompt there, and is citable/retractable like any
deliberate capture. Two capture modes beside the **● video** badge:

- **🦉 smart** (default) — a tick captures only if you interacted with the app since the last
  frame (click, key, scroll, drag, an iPad stroke); a still screen sends nothing, and a 1 s
  quiesce settle frame catches the ending state of a burst.
- **🔫 continuous** — clockwork on the cadence slider (`videoFrameIntervalMs`, 500 ms–10 s,
  default 5 s). For things that move without you touching them.

V works with the linter off — frames are shots, and shots compile whether or not a model is
watching.

## The prompt linter

A realtime model that watches you compose and speaks **when you ask**: it accumulates silently —
your voice, the share's frames, every labeled shot and selection, and the **exact transcription
the compiler will use** — and the **lint now** button triggers one comprehensive read over
everything since its last turn. It never writes the prompt; observations arrive as speech and
dismissible 💡 chips. <kbd>L</kbd> cycles **off → openai → gemini** (config: `linter`, plus
`linterModel` / `linterInstructions`); a missing vendor key disables it loudly and dictation
keeps working. It may call one tool, `read_file` (project-rooted, 32 KB cap) to verify a
suspicion before flagging; every call and byte is in the trace. Every prompt this project sends
is documented — the persona is `LINTER_INSTRUCTIONS` in
`packages/aiui-claude-channel/src/live-session.ts`, and the rendered forms are in the
[prompt rendering reference](/packages/aiui-claude-channel/prompt-rendering). Cost model: each
lint re-reads the accumulated session, so on-demand linting, smart-mode sampling, the terse
persona, and the `read_file` cap are all the same lever — the trace's 💰 cards show per-response
spend.

## The oracle

The panel embeds an **oracle** — a realtime voice assistant that can answer questions and press
the panel itself: it holds the focused aiui app's tools (and keeps the last app's tools when you
look away), can read the project, and its last reply stays on the mind strip after the audio
ends. The app-embeddable oracle — the component any aiui app can mount, its key flows, widgets,
and prompt — is documented with its package: [`aiui-oracle`](/packages/aiui-oracle/oracle).
_TODO: the panel oracle's own controls and its relationship to an armed turn._

## The pencil

The **pencil** is the markup tool (the sole one since the ink removal): strokes over the live
page become located annotations in the briefing. It runs locally in the panel and remotely — an
iPad on the LAN draws through the channel-served client at `/pencil/` (`demos/circle` is the
demo). Pencil ops count as app activity for smart-mode video. `aiui-stt` ships realtime
speech-to-text as a pencil-shaped component for plain (non-panel) pages. _TODO: stroke → prompt
rendering, the handoff gesture._

## The remote bar

`aiui-remote-bar` puts arming and dispatch on another device over the channel's `/bar` routes
(data routes only — the channel serves no HTML of its own). _TODO: the bar's controls and its
auth posture._

## Page tools

An instrumented aiui app exposes **page tools** to the agent: scope-owned kits registered by the
app's own store (`scope("<slug>")` names the toolkit), surfaced through the channel with an
activity bit so tools follow the route the user is actually on, and a ledger recording every
call. This is the WebMCP-superset half of the frontend instrumentation.

## VS Code jump

Jump mode stamps a click on the page back to the authoring source location in your editor. See
[the aiui-vscode package docs](/packages/aiui-vscode/vscode).

## The trace debugger

Every lowering run is traced to the project's user-level cache
(`~/.cache/aiui/projects/<slug>-<hash8>/traces/`). The trace debugger (`aiui-trace-ui`) is
embedded in the panel and also reachable at `/__aiui/debug` (a client route of the console, the
channel's dashboard — `aiui dashboard` opens it). Traces carry every stage's intermediate
representation, everything the linter saw and read, and per-response cost accounting.

## Installing

### It's already loaded in the session browser

With the browser attached (the default), `aiui claude` loads the extension into the shared
**session browser** for you, over CDP — there is nothing to install. Press
<kbd>Cmd/Ctrl</kbd>+<kbd>.</kbd> on any tab to arm a turn and open the panel. The download below
is only for running the panel in your **everyday** Chrome.

### Install a release build in your own Chrome

Chrome has no zero-friction off-store install — a raw `.crx` won't install unless it comes from
the Web Store — so a release build is loaded **unpacked**:

1. Download `aiui-chrome-<version>.zip` from the
   [latest GitHub release](https://github.com/habemus-papadum/pdum_aiui/releases/latest).
2. Unzip it — you get an `aiui-chrome-<version>/` folder with `manifest.json` at its root.
3. Open `chrome://extensions`, turn on **Developer mode** (top-right), click **Load unpacked**,
   and select that folder.
4. Press <kbd>Cmd/Ctrl</kbd>+<kbd>.</kbd> on a tab to open the panel. If the shortcut didn't
   bind, set it at `chrome://extensions/shortcuts`.

**The microphone needs a one-time grant in your own Chrome.** A side panel cannot show Chrome's
mic permission prompt, so on first open the panel probes the mic and — when it's blocked — opens
a small extension page that asks in its place. Click **Enable microphone**, answer the prompt,
and the grant sticks to the extension for good. (The session browser never needs this: it is
launched with a media auto-accept flag. Screenshots need no grant in either browser — tab capture
rides the invocation itself.)

The extension id is fixed (`cdpbfpcelmifhagikjlfpgfipggcmdeg`), stable across reloads and
machines. Developer-mode extensions don't auto-update; reinstall from a newer release to upgrade.
