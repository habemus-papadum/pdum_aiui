# Making Web Workers observable to agentic browser tools

A reusable set of principles — and a small drop-in library — for any web app that pushes heavy
compute into a **Web Worker** and wants an **agent** (driving a real browser through the Chrome
DevTools / MCP tools) to be able to *see inside* that worker. Nothing here is tied to a particular
app; the running example is a generic worker running a continuous, expensive pipeline (parse,
index, simulate, or render to an `OffscreenCanvas`).

The lessons were paid for in a real bug: an `OffscreenCanvas` rendered **blank**, the worker was
producing correct output the whole time, and the single richest log stream in the client — the
worker's `console.*` — was **invisible to the browser automation tools**. The fix had to be found
with ad-hoc `self.__x` hooks that were then thrown away. This doc is what those hooks became:
first-class, off-by-default, runtime-toggleable observability.

---

## The fundamental principle

> **Observability must terminate in a surface the debugging agent can already query.**

An agent debugs through a fixed set of tools — it reads the main-thread console, takes a screenshot,
evaluates an expression on `window`, `curl`s an endpoint. Any signal that lives *outside* those
surfaces — in a worker realm, a cross-origin iframe, a service worker, the server process — might as
well not exist, however rich it is. The entire discipline in this folder is one move applied over
and over: **take the signal that lives in the unreachable realm and forward it, or mirror it, into a
surface the agent's existing tools already read.** A worker's logs → the main-thread console. A
worker's live state → a `window.__<ns>` handle. The server's truth → a REST endpoint
(see [`agentic_frontend_debugging.md`](agentic_frontend_debugging.md), Rule 5). Same law, different
realm each time.

Two clarifications that keep this honest:

- **This is a workaround for a *tooling* gap, not a platform impossibility.** The Chrome DevTools
  Protocol *can* attach to a worker as its own target and receive that worker's `console` events;
  today's MCP tool surface simply doesn't expose that. So "a worker's console is invisible" is a
  statement about the *tools an agent has*, not about the browser. Design for the tools you have —
  and expect the pure log-forwarding to become redundant if the tools gain worker-target support.
- **The ring buffer and state snapshots are valuable regardless of the tooling.** A live console —
  even a perfect one attached to the worker — only shows you what scrolls past *while you watch*.
  A bounded history you can dump on demand (`window.__app.logs`) and a one-call state snapshot
  (`window.__app.state()`) are things no live console gives you. Those survive any improvement in
  worker-attach support; the forwarding is the part that's a stopgap.

The rest of this doc is that one principle, made concrete for the worker↔main boundary, plus the
sharp edges you hit making it real.

---

## The concrete constraint at the worker boundary

The browser tool that reads the console (`read_console_messages` and friends) surfaces **only
main-thread / page** console output. A dedicated worker's `console.debug/info/error` runs in a
*separate realm* and does not appear there — even with verbose logging forced on. So the one stream
that would localize a worker bug is exactly the one the agent cannot read. Everything below follows
from routing that stream — and the worker's state — back to the main thread.

Four mechanisms cover it: **forward the logs**, **capture the failures that never call the logger**,
**expose a discoverable state handle**, and **flip verbosity at runtime**.

---

## Principle 1 — Forward every worker log line to the main thread

Give the worker a logger whose emit path does two things: write to the worker's own console *and*
`postMessage` the line to the main thread. On main, a handler re-`console.*`s each forwarded line
(now readable by main-thread tools) **and** pushes it into a bounded ring buffer.

```
worker realm                                main thread
────────────                                ───────────
logger.notice("ws","open")
  ├─ console.info("[app:worker] ws", …)     (invisible to the agent)
  └─ postMessage({__workerObs, kind:"log"}) ──▶ onmessage → ingest(line)
                                                   ├─ ring.push(line)          → window.__app.logs
                                                   └─ console.info("[app:worker] ws", …)  (agent reads THIS)
```

The forwarded line and its envelope are a small, dependency-free shape — no `window`, no `self` — so
the types compile under any lib and are trivially testable:

```ts
export type LogLevel = "log" | "notice" | "error";

export interface LogLine {
  level: LogLevel;
  tag: string;       // emitter, e.g. "app:worker" — rendered as [tag] on main
  category: string;  // sub-topic within the emitter, e.g. "frame" / "ws" / "hb"
  args: unknown[];   // the remaining console.* arguments
  t: number;         // Date.now() at emit time, in the emitting realm
}

export const OBS_MARKER = "__workerObs" as const;

export interface WorkerLogMessage {
  [OBS_MARKER]: true;     // stable discriminant — demux from the host's own traffic
  channel: string;        // namespace, so independent bridges don't cross-talk
  kind: "log";
  line: LogLine;
}
```

Design notes that matter in practice:

- **Tag every line** (`[app:worker]`, `[app:view]`, `[app:pipeline]`) and carry a **category**
  (`ws` / `frame` / `hb`) so the console + ring buffer are greppable by subsystem.
- **A stable discriminant** on the message (`__workerObs: true` + a `channel` string) lets the host
  demultiplex observability traffic from its own worker messages with one guard, and lets two
  independent bridges on one page coexist without cross-talk.
- **Be robust to un-cloneable args.** A log arg might be a function, a DOM node, a large binary
  buffer — `postMessage` throws `DataCloneError` on those. Post the args as-is (the fast path), and
  **on a throw retry with the offending args replaced by a string**, so a rich log arg never wedges
  the bridge. Stringify only what failed, rather than round-tripping the whole array through JSON:

  ```ts
  const forward = (line: LogLine): void => {
    const msg = { [OBS_MARKER]: true, channel, kind: "log", line } as const;
    try {
      post(msg);
    } catch {
      // a non-clone-safe arg → retry with each arg reduced to a clone-safe form
      post({ ...msg, line: { ...line, args: line.args.map(toCloneSafe) } });
    }
  };
  ```

- **Preserve stack traces.** An `Error` arg is the single most useful thing an agent can read, and
  the naive `toCloneSafe` collapses it to `` `${name}: ${message}` `` — dropping the stack. Serialize
  `error.stack` explicitly so the forwarded line carries where it threw, not just what.
- **Gate the forwarding by tier**, mirroring local console emission: errors always, lifecycle
  notices by default, the verbose per-item firehose only when debug is on. Forwarding then costs
  nothing in the normal (quiet) case. The logger is a conventional three-tier `{ log, notice,
  error }`; the only twist is that `onLine` is the forward-and-record hook, and the two verbose tiers
  collapse to a no-op when debug is off:

  ```ts
  const emit = (level: LogLevel, category: string, args: unknown[]): void => {
    if (localConsole) consoleMethod(con, level)(`[${tag}] ${category}`, ...args);
    if (onLine) onLine({ level, tag, category, args, t: now() });   // ← forward + ring.push
  };
  return {
    enabled: debug,
    log:    debug  ? (c, ...a) => emit("log", c, a)    : noop,   // verbose: off unless debug
    notice: notice ? (c, ...a) => emit("notice", c, a) : noop,   // lifecycle: on by default
    error:  (c, ...a) => emit("error", c, a),                    // failures: always
  };
  ```

### Capture the failures that never call the logger

The failures you most need to see are the ones that *bypass* the logger entirely: an uncaught throw
or an unhandled promise rejection inside the worker. Those are exactly the "blank screen, no logs"
bugs this whole doc exists for, and no `logger.error` call sits in front of them. So the install step
must wire the worker's global error hooks straight into the same forwarding path:

```ts
self.addEventListener("error", (e) =>
  logger.error("uncaught", e.message, e.filename, e.lineno, e.error?.stack));
self.addEventListener("unhandledrejection", (e) =>
  logger.error("unhandled", String(e.reason), (e.reason as Error)?.stack));
```

Do the symmetric thing for the main thread (`window.onerror` / `unhandledrejection` → the
main-thread logger). Now a silent crash in either realm lands in the ring buffer and the main-thread
console as a tagged, stack-carrying `error` line, instead of vanishing.

### Give observability its own channel

By default the bridge shares the app's own `postMessage` channel, which is why every message needs
the `__workerObs` guard and why a verbose firehose can contend with the real data path — turning on
debug perturbs timing, and a timing bug can move or vanish (a heisenbug). When that matters, hand
observability a **dedicated `MessageChannel` port**: the guard leaves the hot data path entirely, and
you can throttle or drop obs traffic under load without touching application messages. Same principle
(forward to a surface the agent reads); just don't make it fight the payload for the wire.

## Principle 2 — A discoverable `window.__<ns>` registry + state snapshots

Even with zero logs, an agent (or a human) should be able to interrogate a live instance from the
console. Install a small registry at `window.__<ns>` where each instance **registers on construct**
and **deregisters on dispose**:

- `window.__app.logs` — the ring buffer of forwarded lines.
- `window.__app.state()` / `.stats()` / `.surface()` / `.capture()` — **pluggable snapshot
  providers** the host supplies (live getters, not frozen values), so current state is one call away.
- `window.__app.report()` — see below; the one call an agent should reach for first.
- `window.__app.instances` — every live instance (a page may host several); `.view` is the sole /
  first one for the common single-widget case.

Three refinements that avoid sharp edges:

- **The log history lives on the registry, not on the instance.** This is a deliberate ownership
  choice, and getting it wrong quietly breaks the feature. Embedding hosts (an SPA route swap, a
  notebook cell rebuild, an HMR update) dispose and recreate a widget constantly; if each instance
  owned its own ring buffer, disposing it would erase the very log history that explains what just
  happened. So the **registry** owns the ring, keyed by channel; instances only *push into* it, and
  dispose removes the instance without clearing the log. The stable `window.__app` handle and its
  `.logs` both **outlive any single instance** — which is the whole point of a handle that survives
  churn.

  ```ts
  __deregister(inst) {
    const i = instances.indexOf(inst);
    if (i >= 0) instances.splice(i, 1);
    // NOTE: neither the registry object NOR its ring buffer is torn down here.
    // The handle and the log history survive dispose/recreate churn on purpose.
  }
  ```

- **One call for the whole picture.** A human reads four channels aloud; an autonomous agent should
  not have to make four tool calls (and blow its context on a 500-line ring dumped as JSON). Expose a
  single `report()` that returns a **bounded, JSON-serializable** snapshot — state, stats, and the
  last N lines (optionally filtered by severity):

  ```ts
  report(opts?: { logs?: number; level?: LogLevel }): unknown {
    return {
      state: reg.state(),
      stats: reg.stats(),
      logs: reg.logs
        .filter((l) => !opts?.level || l.level === opts.level)
        .slice(-(opts?.logs ?? 50)),   // bounded by default — don't flood an agent's context
    };
  }
  ```

- **One discoverability line, once.** On first construct, emit a single `notice` naming the handle:
  `[app] worker observability at window.__app — .report(), .setDebug(true), .logs, .state(), …`. One
  line, not spam, and it tells a human/agent exactly what to type. (Keep it out of any `[app:`
  greppable prefix so log filters don't trip over it.)

## Principle 3 — Runtime debug toggle, not compile-time

If verbosity is fixed at construction, debugging a *running* page means a rebuild + reload (or, in a
notebook, a kernel restart) just to turn logs on — far too slow for a pairing loop. Make it flippable
**at runtime**:

- `window.__app.setDebug(true)` posts `{__workerObs, kind:"set_debug", debug:true}` to each
  instance's worker, which **rebuilds its logger** in place, and simultaneously rebuilds the
  **main-thread** loggers the registry minted. No rebuild, no reload.
- The trick that makes "rebuild in place" work is a **mutable logger facade**: callers hold one
  stable logger reference forever; `setDebug` swaps the backing logger underneath them. A logger
  handed to a sub-component flips too, because it holds the same facade.

  ```ts
  export class MutableLogger implements Logger {
    private inner: Logger;
    constructor(initial: Logger) { this.inner = initial; }
    get enabled() { return this.inner.enabled; }
    log(c: string, ...a: unknown[])    { this.inner.log(c, ...a); }
    notice(c: string, ...a: unknown[]) { this.inner.notice(c, ...a); }
    error(c: string, ...a: unknown[])  { this.inner.error(c, ...a); }
    set(inner: Logger) { this.inner = inner; }   // ← setDebug() rebuilds and swaps here
  }
  ```

- **Optional convenience:** honor `?debug=1` / `?<ns>Debug=1` in the URL and a
  `localStorage.<ns>Debug` flag, read once at construct, so a plain reload can start verbose without
  touching code. (Read these on the main thread only — a worker realm has no `localStorage`.)

## Principle 4 — A cadence heartbeat, not per-item spam

Per-item logging is a firehose that is useless at high throughput and drowns the console. The useful
middle ground is a **periodic one-line summary** emitted from the worker (and forwarded to main):

```
[app:worker] hb rate 12.4/s processed 372 dropped 0 queue 3 · rtt 1.6ms seq 371
```

Rules that keep it clean: one line per interval (~5 s); include the fields that actually localize
bugs (throughput, produced/dropped deltas, queue depth, recoveries, RTT); emit on the **verbose
(debug) tier** so it appears exactly when someone has flipped debug on to watch health.

The one subtlety: **emit a single line on the flowing→idle edge, then go quiet.** "Only log when
something is flowing" is tempting, but then *absence of a heartbeat* means "idle" **or** "dead" — the
two states you most need to tell apart. One `hb idle, drained` line on the transition disambiguates;
after that, silence is unambiguous.

```ts
startHeartbeat(summary: () => string | null, intervalMs = 5000): () => void {
  let wasFlowing = false;
  const handle = setIntervalFn(() => {
    const s = summary();
    if (s !== null) { mutable.log("hb", s); wasFlowing = true; }
    else if (wasFlowing) { mutable.log("hb", "idle, drained"); wasFlowing = false; } // edge, once
  }, intervalMs);
  return () => clearIntervalFn(handle);
}
```

---

## Sharp edges worth stating

- **Ordering: the ring is the source of truth, the re-console is a convenience.** Forwarded worker
  lines arrive on main asynchronously, so in the *live console* a worker line can appear after a
  main-thread line that actually happened later. The `t` timestamp is trustworthy — worker and main
  share the same same-origin `Date.now()` epoch, so skew is ~zero — so anything that needs true order
  should read `.logs` (sorted by `t`), not eyeball the console.
- **Production exposure.** "Off by default" is about *spam*; the `window.__app` handle itself is
  *always installed*, and it exposes `setDebug` and a `.capture()` that can read pixels. On a
  hostile or multi-tenant page that is an information-disclosure surface. Gate the *handle* (not just
  the verbosity) behind a build flag or a debug token in production.
- **Scope.** This assumes a **dedicated** worker with a single main-thread owner. A `SharedWorker`
  has multiple ports (forward to each, or to a broadcast channel); Worklets can't `postMessage`
  arbitrary values; a nested worker is two hops from main and must be relayed. The principle holds;
  the plumbing differs.

## Screenshot vs. readback — name the distinction

A corollary worth writing down, because the two disagree and that disagreement *is* the diagnosis.
When a "blank" symptom appears on a worker-drawn `OffscreenCanvas`, check **both** a pixel
**readback** of the drawing surface *and* a **screenshot** of the composited element:

| readback | screenshot | conclusion |
| --- | --- | --- |
| has content | blank | **compositing / DOM / host** problem (pixels exist, never composited) |
| blank | blank | **produce / draw** problem (upstream of present) |
| has content | has content, user says blank | wrong element / a cached view |
| blank | has content | **you're reading the wrong surface** — a back buffer vs. the presented one, or offscreen vs. onscreen |

Expose a `capture()` snapshot provider that reads the *on-screen* surface where possible, so an agent
can compare `window.__app.capture()` against a `screenshot` rather than trusting either alone.

---

## How the library packages this for drop-in reuse

The library splits along the realm boundary so each side typechecks under its own lib (DOM vs
WebWorker) and imports only what is safe there:

| import | use | contents |
| --- | --- | --- |
| `.../worker` | inside the Worker | `installWorkerObservability({channel, tag, debug, post})` → a stable `logger` (with global error hooks wired), a `handleMessage` that consumes `set_debug`, and `startHeartbeat(summary)`. |
| `.../main` | on the main thread | `registerObservable({channel, snapshots, postToWorker})` → an `ObsInstance` (`ingest`, `makeLogger`, `setDebug`, `dispose`) that installs `window.__<ns>` (registry-owned ring + `report()`); plus `readDebugFlag()`. |
| `.` (root) | either realm | pure core: `RingBuffer`, `buildLogger`/`MutableLogger`, the message types + `isWorkerObsMessage`/`isMainObsMessage` guards, `toCloneSafe`. |

Everything is injectable (the `post` function, the console, the clock, the timer, the registry target
object), so the whole thing is unit-testable in Node with no DOM — the ring buffer, the registry, and
the worker↔main round-trip each have tests.

Wiring it into an app is four small seams:

1. **Worker:** install, use `obs.logger` everywhere, consume control messages at the top of
   `onmessage`, start the heartbeat. The install wires the worker's global error hooks for you.

   ```ts
   const obs = installWorkerObservability({
     channel: "app", tag: "app:worker",
     debug: initOptions.debug,
     post: (m) => self.postMessage(m),
   });
   const log = obs.logger;

   self.onmessage = ({ data }) => {
     if (obs.handleMessage(data)) return;   // consume set_debug before your own handling
     // …the worker's real message handling…
   };
   obs.startHeartbeat(() => (flowing ? `rate ${rate} queue ${queue}` : null));
   ```

2. **Main:** register, ingest before your own handling, mint the main-thread logger, dispose on
   teardown.

   ```ts
   const obs = registerObservable({
     channel: "app",
     debug: readDebugFlag("app"),
     postToWorker: (m) => worker.postMessage(m),
     snapshots: {
       state:   () => ({ connected, queue: queue.length }),
       capture: () => surface.readback(),   // on-screen pixels, for the readback/screenshot compare
     },
   });
   const log = obs.makeLogger("app:view");

   worker.onmessage = ({ data }) => {
     if (obs.ingest(data)) return;   // record + re-console forwarded worker lines, then bail
     // …the host's real message handling…
   };
   // on teardown: obs.dispose();  // removes the instance; the registry + log history persist
   ```

3. **Debug flag:** seed it from `options.debug ?? readDebugFlag(ns)` and pass `obs.debug` into the
   worker's init so URL/localStorage propagate.
4. **Nothing else** — every embedding (a plain page, a framework wrapper, a notebook widget) that
   mounts the view gets `window.__<ns>` for free.

The result: **off by default** (zero console spam in normal use), **flippable from the console**
without a rebuild, and the worker's internals — including its silent crashes — finally readable by
the exact tools an agent uses to debug them.

See also: [`agentic_frontend_debugging.md`](agentic_frontend_debugging.md) — the pairing workflow and
the instrument-at-the-seams rules this builds on — and
[`hmr_for_agentic_coding.md`](hmr_for_agentic_coding.md), which treats a code edit as one more thing
the durable `window.__<ns>` handle must survive.
