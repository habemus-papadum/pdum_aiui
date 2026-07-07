# The Code Reader

The aiui cockpit lets you talk *about the running UI* — point at pixels, speak "make **this**
wider," watch the transcript. The [code reader](/packages/aiui-code/) is the **code half** of that
loop: an LSP-backed, Monaco-based, read-only reader that shows what the agent is actually reading and
changing. Go-to-definition, find-references, hover, a document outline, project-wide symbol search,
jump and jump-back — a power tool for a senior developer who wants to *read and move fast*, not an
IDE. The [Language Servers](./lsp) page covers how it gets real cross-file navigation; this page is
about how the reader is **wired into a running session**.

The headline is architectural: the reader's backend does not run as a second process. It is a
**sidecar** the [channel](./channel) hosts *inside the live session* — so one session process, on one
loopback port, serves both the intent pipeline and the reader. Its frontend is served by the app's
own dev overlay, in a second browser tab that shares the session with the app.

## Why the reader is session-hosted

The channel is the one resident, cwd-aware, long-lived process in the system — it already knows the
project root, already serves a loopback web backend, and already outlives every browser tab. The
reader's backend wants exactly those things: it spawns the project's language servers in the project
cwd and relays their bytes to the browser (the "no veneer" byte-relay of [Language Servers](./lsp)).
Standing that up as a *separate* server would mean a second port to discover, a second lifetime to
manage, and a second copy of the project root to keep in sync. Hosting it *in* the session avoids all
three: the reader's backend rides the channel's port and dies with the session.

That seam — hosting an extra backend inside the session — is generic, and the reader is its first
user. The mechanism is documented on the [channel page](./channel#sidecars); here it's the worked
example.

## Three packages, one reader

The reader ships as three packages (all public), split along the line between the browser, the Node
backend, and the bytes on the wire between them:

| Package | Role | Key exports |
| --- | --- | --- |
| [`@habemus-papadum/aiui-code`](/packages/aiui-code/) | The reader **frontend** — a browser-only SolidJS 2.0 app built on Monaco. Session-agnostic. | `mountCodeReader(el, opts?)` → `{ reader, dispose }` |
| [`@habemus-papadum/aiui-code-server`](/packages/aiui-code-server/) | The Node **backend** — the request + upgrade handler, the channel sidecar factory, and a Vite plugin for standalone dev. | `mountAiuiCodeBackend`, `codeReaderSidecar` (`./sidecar`), `aiuiCodeBackendPlugin` (`./vite`) |
| [`@habemus-papadum/aiui-code-protocol`](/packages/aiui-code-protocol/) | The shared **wire contract** — route table, URL helpers, payload + walkthrough types. Zero runtime deps. | `AIUI_CODE_PREFIX`, `ROUTES`, `lspSocketUrl`, `walkthroughPath` |

`mountCodeReader(el)` renders the reader into an element and hands back the live model plus a
disposer; the frontend never assumes anything about the session it lives in — a host wires its model
to the session bus. The backend is pure Node — it spawns language servers, reads files, stores
walkthroughs — and mounts on any http/ws host through two seams (`handleHttp`, `handleUpgrade`).

**Why the protocol is its own package.** Both halves import the same route strings, the same
`lspSocketUrl` builder, and the same payload types, so the two can never drift on the bytes they
exchange — the frontend fetches exactly the routes the backend serves. Keeping the contract in a
**dependency-free** third package (not, say, in the server, which the frontend would then have to
depend on) is what lets the browser bundle stay clear of Node code and lets the two halves be built,
published, and versioned independently. The dependency graph is acyclic: **frontend → protocol**,
**server → protocol**, and nothing points back.

## Sidecars: the reader's backend, hosted by the channel

A **sidecar** is an extra HTTP (and optional websocket) surface the channel mounts alongside its own.
The channel is deliberately **sidecar-agnostic**: it takes no dependency on the code reader (or any
concrete sidecar) and hardcodes no names — it is handed a JSON array of descriptors and treats each
opaquely. A descriptor is:

```ts
interface SidecarDescriptor {
  name: string;      // stable id, used in logs and the CLI flags (e.g. "code")
  module: string;    // an importable specifier the channel `import()`s
  export?: string;   // the factory export to call; defaults to "default"
  options?: unknown; // passed opaquely to the factory (e.g. { root: "/proj" })
}
```

At startup the channel dynamic-imports each `module`, calls `mod[export ?? "default"](options)`, and
mounts the returned sidecar on its Express app. The code reader's descriptor points `module` at
`@habemus-papadum/aiui-code-server/sidecar`, `export` at `codeReaderSidecar`, and `options` at
`{ root }`. The sidecar mounts the reader's API under `AIUI_CODE_PREFIX` (`/__aiui_code/*`) plus a
`/lsp` websocket byte-relay that spawns the project's language servers lazily, one per connection,
disposed when the channel closes.

Mount ordering is deliberate — the channel's own routes go on first and always win (`/health`,
`POST /prompt`, and the `/ws` / `/tools` / `/session` upgrades), and a malformed descriptor is logged
and skipped rather than fatal. The full mechanism — descriptor loading, mount ordering, the
opaque/no-dependency stance — lives on the [channel page](./channel#sidecars). What follows is how
*this* sidecar gets selected and found.

## How `aiui claude` selects the reader

The channel doesn't decide which sidecars to run; the launcher does. On launch, `aiui claude` calls
`resolveSidecars(process.cwd(), { enable, disable })` (`packages/aiui/src/util/sidecars.ts`) and
hands the result to the channel's `mcp` command as `--sidecars <json>`, next to `--launch-info`.

The `code` sidecar **auto-enables when the project has an LSP setup** — that is, when `loadManifest`
from [`@habemus-papadum/aiui-lsp`](/packages/aiui-lsp/) finds a manifest for the cwd (see
[Language Servers](./lsp)). So opening a project that Claude has already run `aiui setup-lsp` on gets
a reader with no extra flag. Two flags override the auto-detection, both repeatable:

```sh
aiui claude --aiui-sidecar code       # force the reader on, even without an LSP setup
aiui claude --aiui-no-sidecar code    # don't host the reader this launch
```

Disable wins over enable.

**Why the CLI resolves the module to an absolute path.** The descriptor's `module` is resolved to a
concrete on-disk path *by the CLI*, which depends on `aiui-code-server`. The channel does **not**
depend on the sidecar package, so a bare specifier would resolve from the channel's own isolated
`node_modules` (pnpm's layout) and fail to import. The CLI — which *can* resolve it — passes the
absolute path, and the channel imports whatever string it's handed. This is what keeps the channel
free of any sidecar dependency while still being able to load one.

## Finding the backend: the port handoff and CORS

The reader's frontend runs in the **app's** page (served by the app's dev overlay) while its backend
is a sidecar on the **channel** — a different origin. The two are bridged by the same port injection
the intent tool uses:

1. The channel runs its loopback web server on an OS-assigned port and advertises it in the
   [registry](./channel#discovery-the-registry).
2. `aiui vite` exports that port to the app's dev server as `VITE_AIUI_PORT`, and the dev overlay's
   Vite plugin seeds it into every served page as `window.__AIUI__.port`.
3. In the browser, `backendOrigin()` (`packages/aiui-code/src/model/backend-origin.ts`) resolves, in
   order: an explicit override → `window.__AIUI__.port` (→ `http://127.0.0.1:<port>`) →
   `location.origin` (the standalone-harness fallback).

The reader then fetches `/__aiui_code/*` and opens its `/lsp` socket against that origin. Because the
page and the backend are on **different origins**, every backend call is cross-origin — which is why
the backend sends a permissive `Access-Control-Allow-Origin`. This rides the same loopback-only,
no-auth posture as the rest of the channel (see [Trust model](./channel#trust-model) and
[Read before running](./warning)) — the reader adds no network exposure the channel didn't already
have.

## The overlay serves the reader

The reader's frontend is served from the **app's own dev server**, not a separate reader process.
Turn it on in the app's Vite config:

```ts
// app vite.config.ts
aiuiDevOverlay({ code: true })
```

`aiuiDevOverlay({ code: true })` does two things (`packages/aiui-dev-overlay/src/vite.ts`):

- **Serves the reader page at `/__aiui/code`.** The page is a small Solid bootstrap — `mountReaderPage`
  installs the session bus in role `"code"`, calls `mountCodeReader`, and renders a `SessionPanel`
  wired to the reader's live model.
- **Shows the intent tool's "⧉ Code" button**, which opens `/__aiui/code` in a second tab.

The two tabs — the app and the reader — are two views of the same session. They share **arming**, the
**prompt preview**, and **code selections** over the session bus: arm in the app, select code in the
reader, hit **Add to prompt →**, and the selection lands in the turn you're dictating in the app tab.
That machinery — the single-owner turn, the contributor role, the bus — is its own page:
[Multi-View Sessions](./multi-view-sessions).

::: tip This replaces `codeUrl`
There is no separate reader dev server in the normal flow anymore. `code: true` serving the reader
from the app's dev server replaces the old `codeUrl` external-URL option; the "⧉ Code" button now
points at `/__aiui/code` on the same origin.
:::

## Two ways the backend gets mounted

The same backend (`mountAiuiCodeBackend`) mounts through two host seams. Which one runs depends on
what you're doing:

1. **Channel-hosted (the real path).** `aiui claude` selects the `code` sidecar, the channel hosts
   `codeReaderSidecar({ root })`, and the reader — served by the app's dev overlay at
   `/__aiui/code` — talks to it over the injected port. No separate reader process; the reader's
   backend lives and dies with the session.
2. **Standalone reader dev.** When you're hacking on the reader *itself*, the `aiui-code` package's
   own dev server mounts the identical backend in-process via `aiuiCodeBackendPlugin({ root })`
   (`@habemus-papadum/aiui-code-server/vite`). Here the reader page and its backend are same-origin,
   so the harness pins the reader to its own origin — `mountCodeReader(el, { backendOrigin:
   location.origin })`. Run it with `pnpm --filter @habemus-papadum/aiui-code dev`.

Because the backend is host-neutral, the two paths run the exact same file/LSP/walkthrough code —
the only difference is who owns the http/ws server it's bolted onto.

## Where the code lives

- **Frontend** — `mountCodeReader` (`packages/aiui-code/src/mount.tsx`), `backendOrigin()`
  (`.../src/model/backend-origin.ts`), the `SessionPanel` contributor UI.
- **Backend** — `mountAiuiCodeBackend` (`packages/aiui-code-server/src/backend.ts`), the sidecar
  factory (`.../src/sidecar.ts`), the Vite plugin (`.../src/vite-plugin.ts`).
- **Wire contract** — `packages/aiui-code-protocol/src/protocol.ts` (`AIUI_CODE_PREFIX`, `ROUTES`,
  `lspSocketUrl`) and `walkthrough.ts`.
- **Sidecar host** — `Sidecar` / `MountedSidecar` (`packages/aiui-claude-channel/src/sidecar.ts`) and
  the descriptor loader (`.../src/load-sidecars.ts`).
- **CLI selection** — `resolveSidecars` (`packages/aiui/src/util/sidecars.ts`), wired in
  `packages/aiui/src/commands/claude.ts`.

## See also

- [Language Servers](./lsp) — the LSP setup the reader navigates against, and what auto-enables it.
- [Multi-View Sessions](./multi-view-sessions) — the session bus the app and reader tabs share.
- [The Web Intent Tool](./web-intent-tool) — the overlay that serves the reader and hosts the turn.
- [The Channel MCP Server](./channel#sidecars) — the generic sidecar host mechanism.
