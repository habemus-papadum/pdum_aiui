# Getting Started

Get the full loop running: a Claude Code session wired with the aiui channel, your web app served
by Vite, and the [web intent tool](./web-intent-tool) floating over the page — so what you type in
the widget lands in the session as a prompt.

::: danger First
Read [⚠️ Read before running](./warning). `aiui claude` loads a custom channel into your session
and, if you say yes to its first-run question — which is easy to do without reading it — launches
Claude Code with permissions skipped. If you're still here, you've decided to trust this code.
:::

## The quickest start: a disposable demo

No checkout, no integration work — scaffold a sandbox and try the whole loop:

```sh
npx @habemus-papadum/aiui demo my-demo
cd my-demo
npm run claude    # terminal 1 — Claude Code with the aiui channel + session browser
npm run dev       # terminal 2 — the demo app (Vite + the intent tool)
npx aiui open http://localhost:5173   # open the app in the session browser
```

`aiui demo` copies a small sample app (real source: Vite, one `aiuiDevOverlay()` plugin, a fake
"spectra" viewer to point at) into a directory of your own and makes it a **standalone git
repo** — so when the agent starts rewriting the app, the churn is versioned *there*, like a
much-mutated notebook, and never lands anywhere upstream. It installs its dependencies once
(including `aiui` itself, so later `npx aiui …` calls in that directory resolve locally instead
of re-downloading), and it's safe to re-run: an existing demo is **continued**, never
re-scaffolded — your changes and the agent's survive.

Everything below explains the same loop piece by piece, for wiring aiui into your *own* app.

## 0. Prerequisites

- The [Claude Code](https://claude.com/claude-code) CLI (`claude`) on your PATH, logged in.
- The `aiui` CLI: `npm install -D @habemus-papadum/aiui` in your project (or, working on this
  repo itself: `pnpm install && pnpm build`, then the `./aiui` wrapper / `pnpm aiui`).
- A Vite-based web app you're developing. **No app handy?** Use the
  [disposable demo](#the-quickest-start-a-disposable-demo) above. (Repo developers also have
  `pnpm demo`, which serves `packages/aiui-demo` straight from the checkout — handy, but agent
  edits land in your working tree and will try to ride along with your next commit; the
  scaffolded demo is the sandboxed alternative.)

## 1. Terminal one — the session

From your project directory:

```sh
aiui claude
```

This is a normal, interactive Claude Code session — with a channel attached. Under the hood it
spawns the channel MCP server, which starts a loopback web backend on a random port and registers
itself (port, pid, tag) in the user cache so other tools can find it.

The very first interactive launch asks two one-time questions — skip Claude's permission prompts?
auto-dismiss the channel acknowledgement? — with no default, so the answers are yours; they're
saved to your user [config](./config). Claude Code then asks you to confirm loading the
development channel at each startup; aiui presses Enter for you if you said yes to the
[enter nudge](./web-intent-tool#the-acknowledgement-prompt).

The launch also brings up the **[session browser](./chrome)**: one visible Chrome window that
you and the agent share. aiui starts it (or finds it already running for this project) and
attaches the **Chrome DevTools MCP** to it, so the agent drives *the same tabs you're looking
at* — navigate, click, screenshot, read the console. It uses a persistent, project-local profile
under `.aiui-cache/chrome/`, never your personal browser profile. On your first interactive
launch, aiui offers to download **Chrome for Testing**, its recommended browser (version-pinned,
separate from your real Chrome, auto-loads the aiui DevTools panel) — and keeps it current from
then on, per your answer. [The Agent's Browser](./chrome) covers the rest: turning it off
(`--aiui-no-chrome`; automatic under CI), the attach-vs-launch modes, alternate profiles, and the
`aiui browser` / `aiui chrome` commands. Durable settings for all of this — and for the launcher
itself, like `skipPermissions` — live in [config.json](./config); working remotely (session on
another machine, browser on yours) is its own short guide: [Remote Development](./remote).

## 2. Terminal two — your app

```sh
aiui vite dev
```

`aiui vite` finds the running channel server (one running → auto-selected; several → an
interactive picker; or pin one with `--aiui-mcp <tag>`) and launches Vite with
**`VITE_AIUI_PORT`** set to the channel's port. That env var is how the intent-tool plugin
(next step) finds the channel.

Vite prints your app's URL — open it **in the session browser**, not your default one, so you
and the agent are on the same page (literally):

```sh
aiui open http://localhost:5173
```

## 3. Add the intent tool to your Vite config

```ts
// vite.config.ts
import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [aiuiDevOverlay()] });
```

That's the whole integration — no app code. The plugin mounts the tool (defaulting to the
multimodal [intent overlay](./intent-overlay)) into every page the dev server serves and hands it
the channel port; it is dev-server-only, so production builds are untouched. The tool renders a
floating **✳ aiui** button in the corner of your page.
(Custom modalities and non-Vite setups mount from app code instead — see the
[Web Intent Tool](./web-intent-tool) page.)

## 4. Use it

Arm the overlay with the backtick key `` ` `` (or the **✳ aiui** button), then compose a turn:
hold **Space** and say what you want, drag to circle the thing you mean, tap **S** to grab a
screenshot of it — then **Enter** to send. Prefer typing? The plain-text escape hatch is one tab
over. The [Using the intent overlay](./intent-overlay) page is the full how-to (the keymap, the
correction loop, the config); this is the thirty-second version.

::: tip Dictation and correction use OpenAI by default
Speech transcription and the dictation-correction step run for real against OpenAI in the channel
process, which reads `OPENAI_API_KEY` from the environment you launched `aiui claude` in — the
launcher [preflights it](./config#the-intent-pipeline-openai-key) and warns up front if it's
missing. Without a key the widget's status says transcription is *unavailable*; it never silently
degrades. Working offline? Switch the overlay to the
[mock backends](./intent-overlay#what-runs-where-the-channel-real-vs-mock).
:::

![The intent overlay open over a demo app, a turn sent](/intent-tool.png)

The turn streams over the channel's websocket to the MCP server, gets **lowered** into a prompt,
and appears in your Claude Code session in terminal one. What lands there is more than what you
said: the dictation, any corrections applied, and each screenshot placed at its spot in the prose
with its on-disk path — all prefixed with **where it came from** — the browser tab (URL, title,
and, when the aiui DevTools extension is present in the session browser, the tab's ids) plus the
app's **source root** — and a pointer to the `session-browser` skill that teaches the agent how to
find that exact tab through the Chrome DevTools MCP. So "make *this* wider" arrives with enough
context for the agent to select your tab, look at it, and know which code renders it.

## 5. Inspect the lowering

Every submission records a **lowering trace** — the inputs as they arrived, any intermediate
representations, and the final prompt. The 🔍 button in the widget (or
`http://127.0.0.1:$VITE_AIUI_PORT/debug`) opens the trace debugger:

![The lowering debugger showing a trace's input and output stages](/lowering-debugger.png)

A multimodal turn traces the whole compilation — the merged event stream, the composed body with
its `{shot_N}` tokens, the correction diffs — while the plain-text escape hatch is just
input → output. Either way this view is where you look when you disagree with how your intent was
rendered.

Traces live in `.aiui-cache/` under the directory where `aiui claude` runs (project-local,
gitignored) — screenshots and other blobs are stored there too, so lowered prompts can reference
them by path and the session can read them.

## 6. Optional: the DevTools panel

For the full debugging surface — channel/server monitor, websocket latency + frame sizes as the
page measured them, and the trace debugger in one place — load the
[aiui DevTools panel](./devtools): build it
(`pnpm --filter @habemus-papadum/aiui-devtools-extension build`), load
`packages/aiui-devtools-extension/extension` unpacked at `chrome://extensions`, and open the **aiui** tab
in DevTools on your app's page.

In the [session browser](./chrome), a dev checkout rebuilds the panel every time the browser
starts (~0.3 s, never stale) and tries to auto-load it — see
[The Agent's Browser](./chrome#the-aiui-devtools-panel-when-is-it-available) for the auto-load caveat
(Chrome-branded builds ≥ 137 ignore `--load-extension`; Chrome for Testing honors it) and the
one-time manual fallback that the persistent profile then remembers. The manual build-and-load
above is only for loading the panel into your *personal* browser.

## Scripted sends (no browser)

The same channel takes prompts from the CLI — handy for scripts and tests:

```sh
aiui mcp quick --message "run the tests"        # picks a server, POSTs the text
aiui mcp quick --ws --message "run the tests"   # same, over the websocket protocol
```

## Where to go next

- [The Web Intent Tool](./web-intent-tool) — the design: modalities, lowering, traces, debugging.
- [Prompt Lowering](./prompt-lowering) — why this exists and where it's going.
- [Developing pdum_aiui](./development) — working on this repo itself.
