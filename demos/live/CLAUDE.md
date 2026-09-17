# demo: live

An in-repo aiui demo (scaffolded by `pnpm new-demo`, scenery replaced) that exercises
`@habemus-papadum/aiui-live` — the GPT-Live voice front with pluggable delegation backends. Read
`README.md` for the three pages and how to run them; `docs/proposals/oracle-live.md` is the design.

What differs from a stock demo:

- **The dev server carries a backend.** `vite.config.ts` mounts `live()` from
  `@habemus-papadum/aiui-live/vite`: the session broker (`POST /live/sessions`) and the delegation
  relay (`WS /live/delegate`), whose server-side delegators include Claude Code with THIS directory
  as its working directory. That is why the demo carries no `aiui.sitePage` marker: the gallery's
  static build has no such server, and the page would half-work there.
- **Four entries**, not one: `tour.html` (the architectural tutorial), `index.html` (the app),
  `wire.html`, `backends.html`. The live pages share `src/live/` (the bench, the session setup,
  the prompt slots, the toy tools) and `src/ui/Nav.tsx`; the tour lives in `src/tour/` and calls
  no API — its simulator drives the real `LiveSession` with `fake-live.ts`, and its Claude Code
  tables are generated from `sdk-catalog.ts`, extracted from the installed SDK (regenerate it when
  the SDK is bumped; `sdk-catalog.notes.md` records how).
- **`scripts/headless.mts`** runs a real session over WebSocket with a synthesized voice — the
  test path that needs no microphone. Keep it working when the package's API moves.

The app itself (`src/model/`, `src/ui/Oscilloscope.tsx`) is deliberately small: one oscillator
slice under `scope("live")` plus a `samples` control that makes the trace visibly jagged when
low — the question a voice user asks and a code-reading backend answers from `src/model/graph.ts`.
Keep that trap intact; it is the demo's point.

The wiring rules of every aiui app still apply: controls in `store.ts` (durable, compiler-named),
cells in `graph.ts` (rebuilt on hot edit), components in `ui/` (disposable). `pnpm typecheck`
covers both the pages and the headless script.
