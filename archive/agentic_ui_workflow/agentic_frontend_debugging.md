# Agentic frontend debugging

A playbook for debugging a browser client with an agent in the loop — and, more durably, a set of
**instrumentation patterns** that make a streaming frontend debuggable *before* you hit a bug. It
grew out of a real incident: a worker pipeline would stall under certain conditions and the page went
to a **blank screen with zero console output** — nothing to read, nothing to grep, no way to tell an
agent "here's what I see." The fixes below (a tagged logger, a stall watchdog, observable error
paths, a live-reload dev loop) are what turned that class of failure from *invisible* into *named,
counted, and reproducible*.

The running example is a generic client that streams work items from a server over a WebSocket and
processes them in a Web Worker (parse, transform, or render). Nothing here is specific to that shape.

Everything in Part 1 is one law, the same one that governs
[`agent_observable_web_workers.md`](agent_observable_web_workers.md):

> **A failure has to announce itself in a surface the debugging agent can already read** — the
> main-thread console, a screenshot, a `window` expression, a `curl`-able endpoint. A failure that is
> silent, or that lives in a realm the agent's tools can't reach, is a failure you cannot hand to an
> agent.

Instrumenting for debuggability is just applying that law *ahead of time*, at every seam where
streaming tends to break. Two halves: **how to instrument**, then **the pairing workflow** that uses
it.

## Part 1 — Instrument for debuggability

### 1. A gated, tagged logger — quiet by default, loud on demand

Expose a `makeLogger(tag)` returning a three-tier `{ enabled, log, notice, error }`:

- **`log`** is gated by a flag (off by default) → `console.debug`. Hot paths stay silent in
  production; a single toggle turns on the whole play-by-play.
- **`notice`** is a rare, actionable lifecycle event — on by default → `console.info`.
- **`error`** is *always* on → `console.error`. Failures are never gated away.
- Every line is **tagged** (`[app:worker]`, `[app:view]`, `[app:pipeline]`, `[app:stall]`,
  `[app:recover]`, `[app:ws]`) so the console is greppable by subsystem.

The flag rides in from the outside — a `debug` option / `?debug=1` on the demo → the worker `init`
message → the module-level logger in the worker → each sub-component. One switch lights up main
thread **and** worker. Because callers hold a *mutable logger facade*
(see [`agent_observable_web_workers.md`](agent_observable_web_workers.md), Principle 3), that switch
also works **at runtime**, with no rebuild.

> Rule: instrument at the **seams**, not everywhere. Transport connect/close, pipeline setup, the
> gate that admits the first item, each processed item, stall detection, recovery. Those are where
> streaming breaks; a log at each turns "it froze" into "it froze *right after setup*".

### 2. Make failure paths observable — never silent

The incident's root cause was a *silent* catch surface. Every error/empty path now emits:

- The worker's async error callbacks log (`[app:pipeline] error …`) **and** re-arm (reset the
  admit-gate, request a fresh start) instead of leaving a dead component.
- Fallible setup (an unsupported codec, format, or capability) is wrapped in `try/catch`: a throw is
  **fatal**, so it posts `{type:"error"}` to the main thread (→ a visible `onError` state) rather
  than leaving a wedged worker.
- Per-item processing failures are caught and logged instead of vanishing.

And the failures that never reach a `catch` at all — an uncaught throw or an unhandled rejection —
are captured by wiring the realm's global hooks (`self.onerror` / `unhandledrejection` in the worker,
`window.onerror` / `unhandledrejection` on main) straight into `logger.error`. Those *are* the
"blank screen, no logs" bugs; without the global hooks they bypass every seam you instrumented. (The
worker-observability install does this for you — see Principle 1 there.)

> Rule: every `catch`, every early-`return`-on-empty, and every *uncaught* path emits something. A
> failure you can't see is a failure you can't hand to an agent.

### 3. Instrument the *absence* of progress, not just errors

The nastiest streaming bugs throw nothing — the worker simply stops emitting output (a buffering
limit, a dropped start signal, a wedged dependency chain). A **stall watchdog** turns that silence
into an event:

- It tracks `queued − produced` and the wall-clock age of the oldest outstanding item. A backlog
  that produces **zero output** for longer than the expected cadence allows (a configurable
  threshold — default it relative to normal throughput, not a hard-coded 1.2 s that a legitimately
  slow pipeline would trip) is a stall.
- On a stall it logs (`[app:stall]`), rebuilds the stalled component, requests a fresh start, tells
  the server to release its inflight, and bumps a **`recoveries`** counter surfaced in `Stats`
  (visible in the demo HUD).

So an invisible deadlock ("blank screen, no logs") becomes a named, counted, logged, and
*self-healing* event. The watchdog is deliberately **pure and DOM-free** — inject the clock and feed
it plain counters — so the logic is unit-testable headlessly (see rule 6).

### 4. Fix deadlocks at *both* ends

A client-side recovery is only half a fix if the server is also wedged. The stall deadlock was
mutual: the client only ACKs on completion, the server only sends when its inflight window has room →
one stalled worker froze both forever. So the client's recovery sends a **`reset`** control, and the
server *also* has an independent **inflight-timeout backstop**: a sequence number unacked past ~2 s
clears inflight and forces a fresh start even if the client says nothing.

This is TCP's retransmission wisdom rediscovered: **any ACK-gated flow-control loop needs an
independent timeout on both parties**, because a one-sided recovery just re-wedges on the side that
didn't time out.

> Rule: when you instrument one side of a two-party protocol, ask what the *other* side does while
> the first is stuck. Add the symmetric backstop, or the bug comes back wearing a hat.

### 5. Expose server truth over a side channel

The same law again, pointed at the backend: the server's state lives in a realm the browser tools
can't read, so **mirror it into one they can**. Don't make the browser the only place state lives:

- opt-in `stats` control frames (server → client) folded into the client `Stats`;
- REST introspection — e.g. `GET /capabilities`, `GET /streams`, `GET /metrics` — so both sides'
  truth is inspectable with `curl`, no debugger attached.

### 6. Keep the logic testable headlessly

A headless e2e (e.g. Playwright with a software rendering fallback) will not reproduce a *hardware*-
or *timing*-specific stall. So the resilience logic is factored into pure units you can test by
**simulating the trigger** rather than reproducing the environment: inject a clock, feed `onQueued`
with no `onProduced`, assert the watchdog trips. Determinism hooks (injected `now`, plain counters)
are themselves an instrumentation choice — they make the failure reproducible in CI, not just in
someone's hands. The mechanism (logger, ring buffer, bridge) is unit-tested directly; the *promise*
("the agent can read the worker's stream") is worth one integration test that drives a worker path
and asserts on `window.__app.logs`.

## Part 2 — The pairing workflow

### Start the live-reload loop

```bash
app-dev --open
```

The dev command runs the SPA under **Vite (instant TS HMR)** and the API under an **auto-restarting
server** (e.g. `uvicorn reload=True`, `nodemon`, `watchexec`); the browser opens on the Vite URL,
which proxies REST + the WebSocket back to the backend. `--open` launches the browser; the port is a
**free one picked at random** (pass `--port N` to pin it). Edit either side → it's picked up live, no
manual restart.

HMR is not a detail of the dev server — it is the substrate of the whole loop, because the state the
human established (connection open, bug reproduced, panel open) is expensive and must survive each
edit. Structuring code so an edit *preserves* that hard-won state instead of resetting it is its own
discipline: see [`hmr_for_agentic_coding.md`](hmr_for_agentic_coding.md).

### The loop

1. **Reproduce.** The human drives the UI and triggers the glitch (resize, backend switch, …).
2. **Read all four channels.** Browser console with the demo's **Debug** toggle on (or `?debug=1`) →
   the tagged play-by-play; the **backend process stdout**; the **stats HUD** (watch `recoveries`,
   `dropped`, RTT); and REST (`curl …/capabilities`, `…/streams`). Or, in one call,
   `window.__app.report()`. The human can literally read an `[app:stall]` line to the agent.
3. **Hypothesize + instrument.** The agent adds/opens a log at the suspect seam and saves — HMR
   applies it with no restart and, ideally, without losing the reproduced state. The human
   re-triggers.
4. **Fix.** Once the failure is visible in the logs, apply the fix; the same loop confirms it.
5. **Lock it in.** For logic bugs, add a headless test that *simulates the trigger* (unit or e2e) so
   the fix can't silently regress — a software rendering fallback won't catch hardware-specific
   stalls.
6. **Tear down.** `Ctrl-C` cleanly stops both dev servers.

### Anti-patterns

- **Silent catches.** A `catch {}` with no emit is how the original bug hid for so long.
- **Ungated `console.log` in hot paths.** Gate behind the debug flag; keep `error` always-on.
  Littered logs get deleted wholesale, taking the useful ones with them.
- **Trusting the headless e2e for hardware paths.** A software fallback is not the real backend;
  simulate the trigger instead of assuming coverage.
- **One-sided fixes to two-party deadlocks.** Add the symmetric backstop (rule 4).
- **Debugging through the built bundle.** Use the dev server (source + HMR); the built, on-demand
  bundles are for shipping, not for iterating.
- **An edit that resets the reproduced state.** If every save tears down the connection and the
  30-second computation the human just triggered, the loop is broken before it starts — the code
  isn't structured for HMR (see [`hmr_for_agentic_coding.md`](hmr_for_agentic_coding.md)).

## Map

| Concern | Where |
| --- | --- |
| Tagged, gated, runtime-toggleable logger + mutable facade | the `worker-observability` library (`buildLogger`, `MutableLogger`) |
| Worker→main log bridge, `window.__<ns>` registry, `setDebug`, heartbeat, global-error capture | the `worker-observability` library — see [`agent_observable_web_workers.md`](agent_observable_web_workers.md) |
| Worker play-by-play + debug-toggle plumbing | the worker entry + init message types |
| Observable errors, fatal-setup surface | the worker's pipeline module |
| Stall watchdog (pure, testable) | a DOM-free `stallWatchdog` unit (+ its unit test) |
| Server backstops (`reset`, inflight timeout) | the server session module (+ its test) |
| Live-reload dev loop (`--dev`, `--open`, free port) | the dev command / server |
| Surviving HMR without losing reproduced state | [`hmr_for_agentic_coding.md`](hmr_for_agentic_coding.md) |
