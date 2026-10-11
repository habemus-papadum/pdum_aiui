# @habemus-papadum/aiui-dock

The voice dock: both voice engines embedded in an aiui page, wired to the page's own tools,
with viewers, shared vendor keys and a source browser. One `aiui` pill in the corner (the sessions'
combined status dot) expands into the row — `🔮 oracle · 🎙 live · 🧰 tools · 🔑 key ·
📄 source` — each opening one pane: an OpenAI Realtime **oracle** session, a GPT-Live **live**
session with its delegation backends, the page's **tool log**, shared **keys**, and the
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

**Keys.** The keys pane has OpenAI, MotherDuck and ElevenLabs fields. Each saved key is
shared across demos on this origin, persists across visits, and takes precedence over the
dev server's key. Clearing a field removes only that provider's saved key. Existing OpenAI
keys keep working (`aiui.oracle.key`). The page sends credentials directly to their providers.

For local development, opt into the providers the app uses:

```ts
aiui({ devKeys: ["openai", "motherduck", "elevenlabs"] })
```

The variables are `OPENAI_API_KEY`, `MOTHERDUCK_BROWSER_TOKEN` (a read-scaling token), and
`ELEVEN_LABS_API_KEY`. Export them in the server's environment (`.env` with direnv works),
then restart the dev server. Keys are never injected into a production build.

A demo reads a key at request/connect time with the lightweight shared helper:

```ts
import { browserVendorKey } from "@habemus-papadum/aiui-viz/vendor-keys";
const key = browserVendorKey("elevenlabs"); // pasted → dev → undefined
```

`VendorKeyInput` is the same field for inline onboarding (the MotherDuck demo uses it).
To add another provider, add its row to `src/keys.tsx` and the source processor's
`VENDOR_KEYS` table, then opt in with `devKeys`; storage and resolution need no changes.
The server-side live backends appear only when `/live/sessions` answers.

Props: `mintUrl` (an ephemeral-key endpoint for the oracle, tried after the pasted and dev
keys), `serverUrl` (the live routes, default `/live/sessions`), `class`.
