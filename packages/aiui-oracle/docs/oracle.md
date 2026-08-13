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
it was deleted end to end on 2026-07-25 — git history keeps it, along with the `aiui-oracle`
proposal recording the research and decisions behind this rebuild.)

## Developer setup

In an aiui app (scaffolded by `create-aiui` or `pnpm new-demo`), two steps:

**1. The Vite config.** Your app already carries the aiui compiler plugin and Solid; opt in
to dev keys so dev mode needs no pasting and no mint server:

```ts
// vite.config.ts
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [aiui({ locator: true, devKeys: ["openai"] }), solid()],
});
```

`devKeys` is an option on the aiui plugin itself (it already stamps dev context like
`sourceRoot` onto `window.__AIUI__`; keys are just more dev context, vendor-keyed for
Gemini later). Resolution is the house vendor-key machinery: a source checkout honors the
**environment** first (`.env` / direnv), then the **OS vault**; an installed aiui reads the
vault only (`aiui keys set openai`). Serve-only, by construction — `vite build` never sees
it. Note the injected key rides every page the dev server serves: with `server.host: true`
(the trusted-LAN posture) that means LAN-readable, exactly like the rest of the dev
surface — which is why it is opt-in, never a default.

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

(Dev-key injection is NOT an oracle subpath — it is the aiui Vite plugin's `devKeys`
option, above.)

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
**actually applied** (snapped and clamped), which is what the model is told to believe over its
own intent. It stays quiet when that value is what was asked for and speaks only the difference
when it is not ("capped at 8 hertz") — a clean set gets no spoken confirmation at all, because
narrating every successful change is what makes a voice assistant tiresome. Actions become tools
too; custom tools are just more entries in the array. The
surface is **live**: `session.setTools(…)` / `setInstructions(…)` update mid-session, and
`sendText(…)` / `sendImage(…)` inject ad-hoc context into the running conversation.

## The three key flows

Auth is a pluggable `KeySource`; `standardKeySources()` is the decided priority chain:

1. **A pasted key trumps everything.** The `OracleKey` widget writes `localStorage`;
   whatever the user pastes (an `sk-…` parent key or a pre-minted `ek_…`) wins. This is
   also the whole deployment story for a purely static app.
2. **The dev key** — opt in with `aiui({ devKeys: ["openai"] })` and dev mode just works:
   the dev server resolves the key (env first, OS vault fallback) and injects it as
   `window.__AIUI__.devKeys`. The seed applies to serve alone, so it does not exist during
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
  dot, a mic level meter, the streaming reply line, running token usage.
- **`OracleKey`** — key management as its own widget, deliberately separate from the strip:
  the paste field, clear, and a hint about what blank falls through to. Placement is the
  composition story (below).
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

## Composed documents (the gallery pattern)

When a shell composes many apps into one document — the gallery mounting every demo — the
pieces are designed to already do the right thing, and the idiom is about **placement**:

- **Keys are origin-shared by construction.** The paste slot is one fixed `localStorage`
  key and the dev seed is one global, and a composed site is one origin — so the user
  pastes once and every app's oracle sees it. Nothing to wire.
- **Key UI placement follows the dual shape.** A demo's *standalone chrome* (the header
  its `main.tsx` renders around the page) carries `OracleKey`; a composing shell renders
  ONE `OracleKey` for the whole site; the *mounted page* never renders it. No host
  detection — the layer that renders the widget is the decision.
- **Per-app oracles scope their tools.** The control surface is document-global, so a
  composed document makes an unscoped projection see every app's controls. An embedded
  oracle passes its own scope — `toolsFromControlSurface({ scope: appScope })`. "A scope's
  surface" is aiui-viz's `surfaceViewFor` — the scope's own subtree **plus unscoped
  declarations** — the same membership test `registerStandardTools` gives an agent toolkit,
  so an app's oracle and its agent tools see one surface, and an app that declares no scope
  at all keeps its own tools when a sibling mounts beside it. (Omitting the scope
  deliberately is the seed of a *host-level* oracle that drives the whole site — possible,
  not yet built.)
- **Park rides `deactivate`.** The site shell's pause-not-destroy contract maps directly
  onto the oracle's free park: park on page-switch away, resume on return, conversation
  intact, $0 while parked.

## The prompt

`weaveInstructions()` composes the standard persona with the app-specific portion. The base
persona, published verbatim (`ORACLE_BASE_PERSONA` in `packages/aiui-oracle/src/prompt.ts`):

> You are the oracle: a real-time voice assistant embedded in an interactive app. You answer
> questions about the app and drive it on the user's behalf through the tools you are given.
> Use as few words as possible — this is speech: no lists, no preamble, no recaps. When the
> user asks for a change, make it with a tool call; when it lands as asked, say only "done".
> Tools return the value actually applied — trust it over your intent, and don't announce it.
> Speak up only when the outcome differs from what was asked — a clamped, snapped, or coerced
> value, a change that only partly landed — and give just the difference: "capped at 8 hertz".
> When the divergence is too tangled to put in a phrase, say you couldn't fully apply the
> change. When translating the request into tool calls took some interpretation on your
> part — whether one call or several — you may surface it in a sentence: the approach, not
> the mechanics: "you asked to focus on Japan, so I centered the map there and zoomed in" —
> never a play-by-play of tool calls or a string of numbers. When asked a question, give a
> technically competent answer, brief and to the point; trust the user to ask follow-ups
> rather than explaining preemptively. If a tool fails, say what went wrong. Only use tools
> that are currently available; if something asked for has no tool, say so plainly. If unsure
> what the app currently shows, consult your tools before guessing.

The woven prompt stays **generic about which tools exist** — the `tools` array is the single
source of truth (a prompt naming an absent tool makes realtime models invent or pretend; the
vendor documents this failure mode).

## The lab

`pnpm -C packages/aiui-oracle lab` — a standing-wave bench with the oracle wired in: all
three key flows mounted, a composer for text/image injection, a live instructions editor,
per-tool toggles, and the viewer. The lab is where every capability lands first.

## Status

V1 (2026-07-26): WebRTC transport, OpenAI only, live-verified end to end. The intent-panel
embedding (the "intent oracle") has since landed — see
[the intent panel](/guide/intent-panel#the-oracle). Still deliberately parked, with their
seams in place: the WebSocket transport, the sideband control channel, and
session resume-by-replay. Gemini follows once the OpenAI shapes settle.
