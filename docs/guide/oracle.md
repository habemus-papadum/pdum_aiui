# The Oracle

The **oracle** is a realtime voice control surface for aiui apps: a component
(`@habemus-papadum/aiui-oracle`) that opens a WebRTC session directly from the browser to
OpenAI's Realtime API and presents the app's own cells and actions to the model as **tools**.
The user talks; the oracle answers *and drives the app* — "make it a square wave and crank the
frequency" moves the actual sliders, through the same validated setters the widgets use.

It is deliberately simple: one session, one tool surface, one conversation. The oracle tracks
no navigation and no page content, and contributes **nothing** to intent turns or prompt
lowering — it is an app feature, like the pencil, not part of the briefing
pipeline. (An earlier, entirely different oracle lived inside the intent client and channel;
it was deleted end to end on 2026-07-25 — git history keeps it, and
`docs/proposals/aiui-oracle.md` records the research and decisions behind this rebuild.)

## Developer setup

In an aiui app (scaffolded by `create-aiui` or `pnpm new-demo`), two steps:

**1. The Vite config.** Your app already carries the aiui compiler plugin and Solid; add the
dev-key plugin so dev mode needs no pasting and no mint server:

```ts
// vite.config.ts
import { oracleDevKey } from "@habemus-papadum/aiui-oracle/vite";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [oracleDevKey(), aiui({ locator: true }), solid()],
});
```

`oracleDevKey()` reads `OPENAI_API_KEY` from the **dev server's** environment (a `.env` /
direnv setup, same as the channel's source-checkout posture) and injects it into served
pages. Serve-only, by construction — `vite build` never sees it. Note the injected key rides
every page the dev server serves: with `server.host: true` (the trusted-LAN posture) that
means LAN-readable, exactly like the rest of the dev surface.

**2. The app wiring** — a session over the projected tool surface plus whichever widgets you
want (the sketch below). `pnpm dev`, open the app, hit start: the chain finds the dev key and
you are talking to your app. When you later deploy the same app statically, the dev key
simply does not exist — users paste their own key (or you stand up a mint endpoint and pass
`mintUrl`).

To also exercise the **mint flow** in dev, mount the backend into the same dev server:

```ts
// an extra plugin in vite.config.ts — optional, only to test the minted-key flow
import { createMintBackend } from "@habemus-papadum/aiui-oracle/server";

const oracleMint = () => ({
  name: "oracle-mint",
  configureServer(server) {
    const backend = createMintBackend({ log: (l) => server.config.logger.info(l) });
    server.middlewares.use((req, res, next) => backend.handleHttp(req, res) || next());
  },
});
```

## Using it in an app

The package has four subpaths — dev-mode source-first like every workspace package:

| Subpath | What lives there |
|---|---|
| `.` | the chromeless core: `OracleSession`, key sources, transports, the tool bridge |
| `./widgets` | the Solid widgets: `OracleControl`, `OracleMind`, `OracleViewer` |
| `./server` | node-only: the mint backend (`createMintBackend`, `runMintServer`) |
| `./vite` | the `oracleDevKey()` dev-server plugin |

A minimal integration, in an app whose store declares `control()`s and `action()`s:

```ts
import {
  OracleSession, standardKeySources, toolsFromControlSurface,
  weaveInstructions, webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import { OracleControl, OracleViewer } from "@habemus-papadum/aiui-oracle/widgets";

const session = new OracleSession({
  config: {
    instructions: weaveInstructions({ app: "What this app is, in a sentence or two." }),
    tools: toolsFromControlSurface(),
  },
  keySource: standardKeySources(), // or { mintUrl: "/oracle/mint" } when a minter exists
  transport: webRtcTransport(),
});
// then render <OracleControl session={session} /> and, if wanted, <OracleViewer …/>
```

`toolsFromControlSurface()` synthesizes one typed tool per control — `options` become an
`enum`, `min`/`max` become schema bounds, and every `set_*` tool answers with the value
**actually applied** (snapped and clamped), so the model reports honestly ("8 hertz, which is
the maximum"). Actions become tools too; custom tools are just more entries in the array. The
surface is **live**: `session.setTools(…)` / `setInstructions(…)` update mid-session, and
`sendText(…)` / `sendImage(…)` inject ad-hoc context into the running conversation.

## The three key flows

Auth is a pluggable `KeySource`; `standardKeySources()` is the decided priority chain:

1. **A pasted key trumps everything.** The control widget's key field writes
   `localStorage`; whatever the user pastes (an `sk-…` parent key or a pre-minted `ek_…`)
   wins. This is also the whole deployment story for a purely static app.
2. **The dev key** — add `oracleDevKey()` from `./vite` to the app's Vite config and dev
   mode just works: the dev server injects its own `OPENAI_API_KEY` into the page as a
   runtime global. The plugin declares `apply: "serve"`, so it does not exist during
   `vite build` — a production bundle structurally cannot contain the key.
3. **A mint endpoint**, when the app has one: pass `mintUrl` and the chain fetches
   short-lived credentials from it (cached, refreshed near expiry). The endpoint is the
   host-neutral backend from `./server` — mountable in a Vite dev server, a standalone
   express/node server, or (later) the channel sidecar, one code path everywhere.

Whatever the source, every connection uses an **ephemeral client secret** (`ek_…`, minted via
`POST /v1/realtime/client_secrets`); a parent key mints in the browser only in the modes where
the user knowingly holds their own key. The session ledger's `live` line names which flow
answered (`key: dev-key`).

## The widgets

- **`OracleControl`** — the embeddable strip: start / park / resume / stop / shush, a status
  dot, a mic level meter, the streaming reply line, running token usage, and the key field.
- **`OracleMind`** — the ambient one-liner answering *what is it doing right now*:
  `listening…`, `thinking…`, the reply as it streams, `doing: set_freq`, `parked`.
- **`OracleViewer`** — the debugging view: the session's ledger grouped into **turns** (an
  utterance and everything it caused) with progressive detail — one story line per turn,
  expandable to entries, expandable to an entry's JSON. Category chips
  (`turn / tool / config / flow / error / raw`) keep the chatter off by default.

**Park is free**: parking gates the mic and keeps the connection open — idle time bills
nothing (cost accrues only when a response is generated); resume picks the conversation up
exactly where it stopped. Sessions have a vendor-side 60-minute ceiling; the oracle closes
cleanly and a new start begins fresh.

## The prompt

`weaveInstructions()` composes the standard persona with the app-specific portion. The base
persona, published verbatim (`ORACLE_BASE_PERSONA` in `packages/aiui-oracle/src/prompt.ts`):

> You are the oracle: a real-time voice assistant embedded in an interactive app. You answer
> questions about the app and drive it on the user's behalf through the tools you are given.
> Speak plainly and briefly — a few spoken sentences, no lists, no preamble. When the user
> asks for a change, make it with a tool call and confirm what you actually applied (tools
> return the applied value — trust it over your intent). Only use tools that are currently
> available; if something asked for has no tool, say so plainly. If unsure what the app
> currently shows, consult your tools before guessing.

The woven prompt stays **generic about which tools exist** — the `tools` array is the single
source of truth (a prompt naming an absent tool makes realtime models invent or pretend; the
vendor documents this failure mode).

## The lab

`pnpm -C packages/aiui-oracle lab` — a standing-wave bench with the oracle wired in: all
three key flows mounted, a composer for text/image injection, a live instructions editor,
per-tool toggles, and the viewer. The lab is where every capability lands first.

## Status

V1 (2026-07-26): WebRTC transport, OpenAI only, live-verified end to end. Deliberately
parked, with their seams in place: the WebSocket transport, the sideband control channel,
session resume-by-replay, and the intent-panel embedding (the "intent oracle"). Gemini
follows once the OpenAI shapes settle.
