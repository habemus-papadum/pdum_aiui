# @habemus-papadum/aiui-dock

The voice dock: both voice engines embedded in an aiui page, wired to the page's own tools,
with viewers, a key field and a source browser. One `aiui` pill in the corner (the sessions'
combined status dot) expands into the row — `🔮 oracle · 🎙 live · 🧰 tools · 🔑 key ·
📄 source` — each opening one pane: an OpenAI Realtime **oracle** session, a GPT-Live **live**
session with its delegation backends, the page's **tool log**, one **key** for both, and the
page's own **source** files (a tree, each file syntax-coloured with line numbers; shown only
when the page can read them — a dev server, or a build made with `aiui({ sources: "ship" })`).

## Install

```sh
npm install @habemus-papadum/aiui-dock
```

## Usage

```tsx
import { VoiceDock } from "@habemus-papadum/aiui-dock";

render(() => (
  <>
    <App />
    <VoiceDock />
  </>
), root);
```

The dock projects `window.__AIUI__.tools` — every kit `agentToolkit` registered, minus the
parked ones — into both sessions, with each kit's brief, and follows the registry as pages
come and go. Nothing connects until a pill is pressed.

**Keys.** In dev, `aiui({ devKeys: ["openai"] })` in the Vite config injects the key. On a
static site, the key pane takes a pasted key: it stays in this browser's localStorage for the
site and is sent only to `api.openai.com` by the page itself — the oracle mints its single-use
ephemeral secret in the browser, the live session's broker posts the SDP straight to the
vendor. Never to a server of ours. The server-side live backends (the dev server's Responses
and Claude Code) appear only when `/live/sessions` answers.

Props: `mintUrl` (an ephemeral-key endpoint for the oracle, tried after the pasted and dev
keys), `serverUrl` (the live routes, default `/live/sessions`), `class`.
