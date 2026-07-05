# The shared debug UI (`src/debug-ui/`)

Internals note. The debug UI is the intent pipeline's `-emit-ir`: framework-free DOM panes that
render the multimodal intent stream and its lowering passes, live. It was prototyped as the
workbench's inspector dock and graduated here (`./debug-ui` subpath) so **two homes render intent
debugging identically off one implementation** — the workbench *lab* (over a live `Engine`) and the
DevTools extension's **Intent** pane (over a channel trace it live-follows). Dependency-free;
browser-safe (DOM + the `intent-pipeline` core only).

## Two data sources, one interface

The panes never know where their events come from. A `DebugSource` is just
`subscribe(cb: (events: IntentEvent[]) => void): () => void`, and two adapters implement it:

- **`engineSource(engine)`** — the lab's case. Replays `engine.events` on subscribe and forwards
  each new one. (The `Engine` has no `off`; the source keeps a `live` flag so unsubscribe is real
  from its side without touching the pipeline.)
- **`traceLiveSource({ baseUrl, traceId })`** — the extension's case. Polls the channel's
  `/debug/api/traces/:id/live` route (`?since=<rev>` → `{unchanged:true}` when the manifest's mtime
  hasn't moved), so following a running lowering in another process is a one-second fetch, not an
  open socket. It pulls the event log out of whatever stage carries it and forwards that.

`EventPanes` (events / IR / timing / export) binds to either. `createTracePoll` is the poll logic
factored out for testing and for driving the trace view directly.

## Generic traces, rich where it counts

The extension follows **any** trace the debugger records, not just intent ones. `TraceView` renders
a whole trace generically — each stage as text (absolute paths made previewable) or a blob — and
**feature-detects** an event log (`extractIntentEvents`: the last stage whose payload is a non-empty
array of `{at:number, type:string}`), rendering *that* stage through the full `EventPanes`. So a
`text-concat` trace shows its plain stages and an `intent-v1` trace gets the timeline/IR/timing
view, with no format-specific branching in the extension.

## Host-injected specifics

What differs between homes is injected, not branched: the image-preview URL
(`previewUrl` — the lab's dev-server proxy vs. the channel's cross-origin
`/debug/api/preview`) and, for the trace view, the blob URL. Styles are self-contained
(`aiui-dbg-` prefix, injected once per document) so the panes look of a piece with the channel's
`/debug` viewer in either home.

## Consuming it from the extension

The extension compiles under NodeNext and can't bundle this package's bundler-mode source, so it
esbuilds `./debug-ui` into a standalone `extension/js/debug-ui.js` and imports it lazily — see that
package's README. In-repo (source-first), the lab imports `./debug-ui` directly, no build step.
