# Getting Started

Get the full loop running: a Claude Code session wired with the aiui channel, your web app served
by Vite, and the **intent client** — the session browser's side panel (or the channel-served
`/intent/` page) — driving the page, so what you say and point at lands in the session as a
prompt.

::: danger First
Read [⚠️ Read before running](./warning). `aiui claude` loads a custom channel into your session
and, if you say yes to its first-run question — which is easy to do without reading it — launches
Claude Code with permissions skipped. If you're still here, you've decided to trust this code.
:::

## The quickest start: scaffold an app

No checkout, no integration work — scaffold the starter and try the whole loop:

```sh
npm create @habemus-papadum/aiui@latest my-app
cd my-app
npm run claude    # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev       # terminal 2 — your app (Vite + the intent tool)
npx aiui open http://localhost:5173   # open the app in the session browser
```

This copies the **SolidJS starter** (real source: Vite, one `aiui()` plugin, and a
placeholder rose you point at and talk about) into a directory of your own and makes it a
**standalone git repo** — so when the agent starts rewriting the app, the churn is versioned
*there*, like a much-mutated notebook, and never lands anywhere upstream. It installs its
dependencies once (including `aiui` itself, so later `npx aiui …` calls in that directory resolve
locally instead of re-downloading), and it's safe to re-run: an existing app is **continued**,
never re-scaffolded — your changes and the agent's survive.

The starter arrives with the [frontend-for-agents](./frontend-for-agents) shape already in
place — durable roots, a cell graph, an agent tool surface — and a banner that tells you to start
talking. The [frontend user guide](./frontend-user-guide) explains how to write into it. See also
[Installation](./installation#starting-a-fresh-app-the-solidjs-starter).

Everything below explains the same loop piece by piece, for wiring aiui into your *own* app.

## 0. Prerequisites

- The [Claude Code](https://claude.com/claude-code) CLI (`claude`) on your PATH, logged in.
- The `aiui` CLI: `npm install -D @habemus-papadum/aiui` in your project (or, working on this
  repo itself: `pnpm install`, then the source-run `./aiui` wrapper / `pnpm aiui` — no build
  needed; `eval "$(./aiui env)"` puts it on your PATH as plain `aiui`, see
  [Developing](./development#activate-your-shell-optional-venv-style)).
- A Vite-based web app you're developing. **No app handy?** [Scaffold the
  starter](#the-quickest-start-scaffold-an-app) above. (Repo developers also have `pnpm demo`,
  which serves the `demos/gallery` reference notebooks straight from the checkout — handy, but
  agent edits land in your working tree and will try to ride along with your next commit; a
  scaffolded app is the sandboxed alternative.)

## 1. Terminal one — the session

From your project directory:

```sh
aiui claude
```

This is a normal, interactive Claude Code session — with a channel attached. Under the hood it
spawns the channel MCP server, which starts a loopback web backend on a random port and registers
itself (port, pid, tag) in the user cache so other tools can find it.

The very first interactive launch asks two one-time questions — auto-dismiss the channel
acknowledgement? bind the channel to your LAN? — with no default, so the answers are yours;
they're saved to your user [config](./config). (Claude's own permission prompts stay in charge
unless you opt out with `aiui config set-dsp` — see the [warning](./warning).) Claude Code then
asks you to confirm loading the development channel at each startup; aiui presses Enter for you if
you said yes to the enter nudge.

The launch also brings up the **[session browser](./chrome)**: one visible Chrome window that
you and the agent share. aiui starts it (or finds it already running for this project) and
attaches the **Chrome DevTools MCP** to it, so the agent drives *the same tabs you're looking
at* — navigate, click, screenshot, read the console. It uses a persistent, project-local profile
under `.aiui-cache/chrome/`, never your personal browser profile. On your first interactive
launch, aiui offers to download a managed browser — **Chromium** by default (version-pinned,
separate from your real Chrome, auto-loads the intent client's extension, and — unlike Chrome for
Testing — dodges Google's "verify you're human" reCAPTCHA) — and keeps it current from then on,
per your answer. [The Agent's Browser](./chrome) covers the rest: turning it off
(`--aiui-no-chrome`; automatic under CI), the attach-vs-launch modes, alternate profiles, and the
`aiui browser` / `aiui chrome` commands. Durable settings for all of this — and for the launcher
itself, like `claude.args` — live in [config.json](./config); working remotely (session on
another machine, browser on yours) is its own short guide: [Remote Development](./remote).

## 2. Terminal two — your app

```sh
aiui vite dev
```

`aiui vite` is a thin wrapper: it launches Vite, then opens your app in the session browser. It
does **not** wire the app to a channel — that is the intent client's job (step 3), so plain
`vite dev` serves the app just as well; the wrapper only adds the browser step.

When Vite prints your app's URL, aiui opens it **in the session browser** for you — not your
default browser — so you and the agent are on the same page (literally). `--aiui-no-browser`
turns that off; in headless environments (CI, SSH, no display) aiui instead prints the URL to
open on your local machine, assuming you've forwarded the port (`--aiui-browser` forces a
browser open anyway). To open the app again later:

```sh
aiui open http://localhost:5173
```

## 3. The app-side integration (already in the starter)

```ts
// vite.config.ts
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [aiui()] });
```

That's the whole app-side integration — no app code. The plugin stamps your JSX with source
locations and injects cell/control identities (what lets a screenshot rectangle or a text
selection resolve back to the component and file that rendered it — see
[Attribution](./attribution)); it also seeds the dev server's source root. Channel connectivity
never comes from the app: the **intent client** carries it.

## 4. Use it

The intent client rides the session browser as a side panel (`aiui claude` auto-loads its
extension; the aiui toolbar button opens it), and the same client is served as a plain page at
the channel's `/intent/` URL — either one drives the tab you're looking at. It arms itself as
soon as the channel connects; open a turn from the turn cap and compose: hold
**Space** and say what you want, take a screenshot (**s**, or **a** to drag a region), draw on
the page with the pencil, select text and add it — then **Enter** to send.

::: tip Dictation and correction use OpenAI by default
Speech transcription and the dictation-correction step run for real against OpenAI in the channel
process. Keys come from the [OS vault](./config#vendor-api-keys-openai--gemini--elevenlabs)
(`aiui keys`; a source checkout honors `OPENAI_API_KEY` in the environment first) — the first
interactive launch asks once per provider, and the launcher preflights the resolved key and
warns up front if it's missing. Without a key the panel's status says transcription is
*unavailable*; it never silently degrades. Working offline? Switch the stt select to the mock
transcriber.
:::

The turn streams over the channel's websocket to the MCP server, gets **lowered** into a prompt,
and appears in your Claude Code session in terminal one. What lands there is more than what you
said: the dictation, any corrections applied, and each screenshot placed at its spot in the prose
with its on-disk path — all prefixed with **where it came from** — the browser tab (URL, title,
ids) plus the app's **source root** — and a pointer to the `session-browser` skill that teaches
the agent how to find that exact tab through the Chrome DevTools MCP. So "make *this* wider"
arrives with enough context for the agent to select your tab, look at it, and know which code
renders it.

## 5. Inspect the lowering

Every submission records a **lowering trace** — the inputs as they arrived, any intermediate
representations, and the final prompt. The intent panel embeds the trace debugger (the *traces*
disclosure); `aiui debug` opens the channel **console** in the session browser — its dashboard
links to the same viewer at `/__aiui/debug`, which carries an in-page switcher across every
running channel:

![The lowering debugger showing a trace's input and output stages](/lowering-debugger.png)

A multimodal turn traces the whole compilation — the merged event stream, the composed body with
its `{shot_N}` tokens, the correction diffs — while the plain-text escape hatch is just
input → output. Either way this view is where you look when you disagree with how your intent was
rendered.

Traces live in the project's user-level cache — `~/.cache/aiui/projects/<slug>-<hash>/`, keyed
by the absolute path of the directory where `aiui claude` runs, so the project tree itself stays
pristine — and screenshots and other blobs are stored there too. Lowered prompts reference them
by absolute path, so the session can read them from anywhere.

## Scripted sends (no browser)

The same channel takes prompts from the CLI — handy for scripts and tests:

```sh
aiui mcp quick --message "run the tests"        # picks a server, POSTs the text
aiui mcp quick --ws --message "run the tests"   # same, over the websocket protocol
```

## Where to go next

- [Prompt Lowering](./prompt-lowering) — why this exists and where it's going.
- [Attribution](./attribution) — how a gesture on the page resolves to source.
- [Developing pdum_aiui](./development) — working on this repo itself.
