# @habemus-papadum/aiui-dock

The voice dock: both voice engines embedded in an aiui page, wired to the page's own tools,
with viewers and a key field. A pill row in the corner — `🔮 oracle · 🎙 live · 🧰 tools ·
🔑 key` — each opening one pane: an OpenAI Realtime **oracle** session, a GPT-Live **live**
session with its delegation backends, the page's **tool log**, and one **key** for both.

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
