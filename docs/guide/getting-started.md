# Getting Started

Get the loop running: a Claude Code session wired with the aiui channel, a page in the shared
session browser, and the **intent panel** driving it — so what you say and point at lands in the
session as a prompt. There are [three ways in](#the-three-run-modes); keys come first in all of
them.

::: danger First
Read [⚠️ Read before running](./warning). `aiui claude` loads a custom channel into your session
and, if you opt in (`aiui config yolo`), launches Claude Code with permissions skipped. If
you're still here, you've decided to trust this code.
:::

## Prerequisites and keys

- **Node ≥ 24** and a package manager.
- The **[Claude Code](https://claude.com/claude-code) CLI** (`claude`) on your PATH, logged in.
- **A browser aiui can manage.** Interactive launches offer to install a managed browser —
  **Chromium** by default (version-pinned, auto-loads the intent client's extension) — so say
  yes; branded Chrome ≥ 137 won't auto-load the extension and restricts the debug-port setup.
  Details: [The Agent's Browser](/packages/aiui/chrome).
- **Vendor keys.** Transcription/correction run against OpenAI (ElevenLabs Scribe is the default
  STT engine when its key is present; Gemini only powers the linter). The first interactive
  `aiui claude` asks once per provider — paste the key (stored in the
  [OS vault](./config#vendor-api-keys-openai--gemini--elevenlabs)) or press Enter to skip;
  `aiui keys` manages them later. A source checkout honors `OPENAI_API_KEY` etc. from the
  environment first. Without keys everything still runs — the voice paths say plainly that
  they're unavailable.

## The three run modes

### 1. Over a page you didn't write (no app, no scaffold)

The shortest path to "what is this thing": no Vite project at all. From any directory,

```sh
npx @habemus-papadum/aiui claude
```

brings up the session + channel + session browser. Open any site in that browser, press
<kbd>Cmd/Ctrl</kbd>+<kbd>.</kbd>, and compose a turn over the page — dictation, screenshots,
selections, the pencil all work on pages with no aiui integration (source **attribution** is
what needs the instrumented-app layer). The agent gets the tab identity and drives the same
browser you're looking at.

### 2. Scaffold a new app

```sh
npm create @habemus-papadum/aiui@latest my-app
cd my-app
npm run claude    # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev       # terminal 2 — your app (Vite + the intent client)
npx aiui open http://localhost:5173   # open the app in the session browser
```

The starter is a standalone SolidJS 2.0 app in its own git repo (agent churn is versioned
*there*, never upstream), with the [frontend-for-agents](./frontend-for-agents) shape already in
place — durable roots, a cell graph, an agent tool surface — and a placeholder built to be
rebuilt. Re-running the command **continues** an existing app; it never overwrites. Keep the
`@latest` tag (the dlx cache can silently reuse a stale scaffolder; a stale scaffolder pins
stale deps). The [frontend user guide](/packages/aiui-viz/frontend-user-guide) is how to write
into it.

### 3. Add aiui to an app you already have

In a Vite-based project:

```sh
npm install -D @habemus-papadum/aiui @habemus-papadum/aiui-source-processor
```

```ts
// vite.config.ts
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [aiui()] });
```

That's the whole app-side integration — no app code. The plugin stamps JSX with source
locations and injects cell/control identities (what lets a screenshot rectangle or a selection
resolve back to the component and file that rendered it — see
[Attribution](/packages/aiui-viz/attribution)); channel connectivity never comes from the app —
the intent client carries it. Optionally, `npm install @habemus-papadum/aiui-viz` for the
[frontend-for-agents](./frontend-for-agents) methodology.

## The loop, piece by piece

**Terminal one — `aiui claude`.** A normal interactive Claude Code session with the channel
attached: the MCP server starts a loopback web backend on a random port and registers itself in
the user cache. The first interactive launch asks the one-time questions (enter nudge,
`channel.bind`, keys — answers persist to [config](./config)) and brings up the **session
browser**: one visible window you and the agent share, project-local profile, Chrome DevTools
MCP attached. [The Agent's Browser](/packages/aiui/chrome) covers modes, profiles, and the
`aiui browser`/`aiui chrome` commands; working remotely (session on another machine, browser on
yours) is [Remote Development](/packages/aiui/remote).

**Terminal two — `vite dev`** (or the app's `pnpm dev`). Open the app in the session browser
(not your default browser) with `aiui open http://localhost:5173`.

**Compose.** The panel rides the session browser ([or the `/intent/` page](./intent-panel)); it
arms as soon as the channel connects. Hold **Space** and talk, take screenshots, draw, select —
then **Enter** to send. The turn streams over the channel's websocket, gets **lowered** into a
prompt, and lands in terminal one with the tab identity, source root, and each image placed at
its spot in the prose.

**Inspect.** Every submission records a **lowering trace** — inputs, intermediate
representations, final prompt. The panel embeds the trace debugger; `aiui dashboard` opens the
console, which links the same viewer at `/__aiui/debug`. Traces and screenshots live in the
project's user-level cache (`~/.cache/aiui/projects/<slug>-<hash>/`), so the project tree stays
pristine.

![The lowering debugger showing a trace's input and output stages](/lowering-debugger.png)

## Scripted sends (no browser)

```sh
aiui mcp quick --message "run the tests"        # picks a server, POSTs the text
aiui mcp quick --ws --message "run the tests"   # same, over the websocket protocol
```

## Where to go next

- [The Intent Panel](./intent-panel) — the feature reference: modes, dictation, the linter, the
  oracle, the pencil.
- [Prompt Lowering](./prompt-lowering) — why this exists and where it's going.
- [Developing pdum_aiui](./development) — working on this repo itself.
