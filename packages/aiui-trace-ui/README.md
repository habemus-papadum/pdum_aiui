# @habemus-papadum/aiui-trace-ui

The **lowering-trace debugger UI** — deliberately framework-free imperative DOM, so the same
panes mount anywhere: the intent client's panel embeds `TracesPane` as a Solid island, and the
`./vite` plugin serves the full page at `/__aiui/debug` (what `aiui dashboard` runs).

Lineage: this is the `debug-ui` third of the retired `aiui-dev-overlay`, copied out in the
overlay retirement (`docs/proposals/dev-overlay-retirement.md`). The original is deleted; read
it in git history.

## The pieces

- **`TraceView`** — one channel trace rendered as a reading surface: status header, the lowered
  prompt as a hero (real shot thumbnails), filter chips, and the recorded stages as compact,
  directional, coalesced cards (`trace-cards.ts` is the pure classification underneath).
- **`TracesPane`** — the debugger's whole surface: the session-filtered, follow-newest trace
  list over a live-followed `TraceView`.
- **`mountDebugPage`** — the standalone-page bootstrap: a full-viewport `TracesPane` with a
  channel switcher (fed by `/debug/api/channels`), honoring the `?session=` pin.
- **`EventPanes`** — events / IR / timing / export over an `IntentEvent` stream.
- **`renderJsonTree`** — the dependency-free collapsible JSON widget.
- **`DebugSource`** (`engineSource` / `traceLiveSource`) — the seam behind the panes: a live
  engine, or an HTTP poll of the channel's `/debug/api/traces/:id/live`.
- **`traceViewer()`** (`./vite`) — the dev-server plugin that serves the standalone page.

## Install

```sh
npm install @habemus-papadum/aiui-trace-ui
```

## Serving the standalone page

```ts
import { traceViewer } from "@habemus-papadum/aiui-trace-ui/vite";
import { createServer } from "vite";

const server = await createServer({
  plugins: [traceViewer({ port: channelPort })],
});
```

`aiui dashboard` does exactly this — it picks a running channel from the registry and serves the
viewer against it; the page's header can then hop to any other channel on the machine.
