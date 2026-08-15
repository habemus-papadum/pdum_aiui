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

## Prerequisites

- **Node ≥ 24** and a package manager.
- The **[Claude Code](https://claude.com/claude-code) CLI** (`claude`) on your PATH, logged in.
- **A browser aiui can manage.** Interactive launches offer to install a managed browser —
  **Chromium** by default (version-pinned, auto-loads the intent client's extension) — so say
  yes; branded Chrome ≥ 137 won't auto-load the extension and restricts the debug-port setup.
  Details: [The Agent's Browser](/packages/aiui/chrome).
- **The aiui plugin** (the skills `aiui claude` sessions run on). A source checkout of this
  repo carries it — nothing to do. An **installed** aiui refuses to launch until the plugin
  is installed, once, from the repo's own plugin marketplace (both commands are idempotent):

  ```sh
  claude plugin marketplace add habemus-papadum/pdum_aiui
  claude plugin install aiui@pdum-aiui
  ```

  The plugin is versioned in lockstep with aiui; when it falls behind the CLI you installed,
  the launcher warns loudly and prints the two update commands.

## Vendor keys

The intent tool is voice-first, and the voice pipeline runs on vendor APIs — there is no local
fallback. Without keys the panel still opens, but dictation and the
[oracle](./intent-panel#the-oracle) are dead; you're down to typing and screenshots, which
defeats the point. Get the first two of these before going further:

| Provider | What it powers | Where to get a key |
| --- | --- | --- |
| **ElevenLabs** — critical | Scribe v2 speech transcription: the default transcriber, i.e. dictation itself | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) — a restricted key with only the speech-to-text permission is enough |
| **OpenAI** — highly recommended | The [oracle](./intent-panel#the-oracle) (the panel's realtime voice assistant) rides OpenAI Realtime; also dictation correction, the fallback transcriber, and the default linter | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) — needs a funded API account |
| **Gemini** — optional | The Gemini Live realtime engine and the Gemini linter option | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

Two ways to hand them to aiui:

- **Paste them at first launch.** The first interactive `aiui claude` asks once per provider —
  paste the key, or press Enter to skip. Keys land in the
  [OS vault](./config#vendor-api-keys-openai--gemini--elevenlabs) (macOS login keychain /
  Secret Service), never in a config file; only the per-provider decision (`vault` / `skip`)
  is recorded.
- **Store them ahead of time** — or fix them later — with `aiui keys`:

  ```sh
  aiui keys status            # per-provider decision + effective source (never the values)
  aiui keys set elevenlabs    # store one key (masked prompt; piped stdin for scripts)
  aiui keys set openai
  aiui keys interview         # revisit all three: keep / replace / skip
  ```

Working from a **source checkout** of this repo, the environment wins first — `ELEVEN_LABS_API_KEY`
(note the underscore), `OPENAI_API_KEY`, and `GEMINI_API_KEY` from `.env`/direnv are honored,
and the vault fills the gaps. An **installed** aiui ignores the environment for keys: the vault
is the only source, so your keys never enter the agent's environment.

At launch, aiui checks key **presence** only: a missing provider prints a warning naming
exactly what's degraded (a chosen skip stays silent), and the session boots regardless. No key
is validated against its vendor at launch — a bad key surfaces at first *use*, in the intent
client, with the per-vendor fix hint. The full story:
[Configuration](./config#vendor-api-keys-openai--gemini--elevenlabs).

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
the user cache. The first interactive launch runs the [key interview](#vendor-keys), offers the
managed browser, and brings up the **session browser**: one visible window you and the agent
share, on a managed profile of its own (shared across projects by default), Chrome DevTools
MCP attached. [The Agent's Browser](/packages/aiui/chrome) covers attach-vs-launch, profiles,
and the `aiui chrome`/`aiui profile` commands; working remotely (session on another machine,
browser on yours) is [Remote Development](/packages/aiui/remote).

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
