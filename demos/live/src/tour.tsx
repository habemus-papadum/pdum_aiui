/**
 * tour.tsx — page 0: a MENTAL MODEL of the live oracle, for someone who
 * wants to integrate it elsewhere. Every parameter, every event, every
 * backend, where the keys live, and exactly how Claude Code is wired in —
 * with things to twiddle at each step. Nothing on this page calls OpenAI
 * or Claude; the simulator runs the real engine against a fake service in
 * this tab, and the one network call (the keys probe) hits this dev server.
 */

import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { For } from "solid-js";
import "./styles.css";
import { AppendLab } from "./tour/AppendLab";
import { ClaudeSection, SessionsSection } from "./tour/Claude";
import { Diagram } from "./tour/Diagram";
import { BACKEND_FACTS, LINKS, MEASURED, WIRE_EVENTS } from "./tour/glossary";
import { KeysProbe } from "./tour/KeysProbe";
import { SessionBuilder } from "./tour/SessionBuilder";
import { Simulator } from "./tour/Simulator";
import { Nav } from "./ui/Nav";

const SECTIONS = [
  ["shape", "the shape"],
  ["session", "the session, every parameter"],
  ["modalities", "modalities: in and out"],
  ["flow", "the event flow, live"],
  ["backends", "backends: who thinks"],
  ["keys", "keys"],
  ["claude", "Claude Code, exactly"],
  ["sessions", "sessions, logs, forks"],
  ["choices", "other choices, and where to read"],
] as const;

const DELEGATOR_SNIPPET = `import type { Delegator } from "@habemus-papadum/aiui-live";

export function myBackend(): Delegator {
  return {
    name: "mine",
    async handle(req) {
      // req.id         the ticket (delegation_id) — the engine tags every append with it
      // req.text       what the user asked, reconstructed from the transcript
      // req.transcript the recent utterances, both sides, with timeline ms
      // req.tools      LiveTool[] — call them wherever you are; the engine/relay routes them
      // req.signal     aborted on cancel or session close
      req.log("thinking…");                       // UI only, never spoken
      await req.note("the user is on page 3");    // session.thinking.append (quiet)
      const value = await req.tools[0]?.execute({}); // a page tool, run where it lives
      await req.say("The value is " + String(value)); // session.commentary.append (spoken)
      // return "…" instead of say() if you only have a final answer:
      // the engine speaks a returned string when nothing was said
    },
  };
}

// browser:  new LiveSession({ transport, delegator: myBackend(), tools })
// server:   live({ delegators: { mine: () => myBackend() } })   // the Vite plugin
//           …and in the page: remoteDelegator({ delegator: "mine" })`;

function TourPage() {
  return (
    <div class="app tour">
      <Nav current="tour" />
      <header class="app-head">
        <h1>tour · a mental model of the live oracle</h1>
        <p class="app-sub">
          Read top to bottom once, then come back to twiddle. Every number here was measured against
          the real API on 2026-09-15; every parameter is the one the package actually sends. Nothing
          on this page talks to OpenAI or Claude — the simulator in §4 runs the real engine against
          a fake service in this tab. The OpenAI links go to the guides this was built from; add{" "}
          <code>.md</code> to any of them for the exact source text.
        </p>
        <ul class="tour-toc">
          <For each={SECTIONS}>
            {([id, label], i) => (
              <li>
                <a href={`#${id}`}>
                  {i() + 1} · {label}
                </a>
              </li>
            )}
          </For>
        </ul>
      </header>

      <section id="shape" class="tour-section">
        <h2>
          <span class="tour-num">1</span>the shape
        </h2>
        <p class="tour-lead">
          GPT-Live is <b>two parts in one session</b>: a full-duplex voice model that only converses
          and decides <em>when to ask for help</em>, and a backend that does the thinking with no
          latency budget. The voice model cannot call a tool or see an image. When it needs either,
          it opens a <b>delegation ticket</b> — an id and a timestamp, nothing else — and keeps
          talking. You answer the ticket by streaming text back into the conversation, in pieces,
          whenever you have them. That backend can be a script in the page, a Responses model, or
          Claude Code on a server. Pick one below to see where it runs.
        </p>
        <Diagram />
        <div class="tour-callout">
          <b>The two seams.</b> Everything a host plugs into is one of two interfaces. A{" "}
          <code>LiveTransport</code> moves audio and events (WebRTC in a browser, WebSocket in node,
          the simulator's fake here). A <code>Delegator</code> answers tickets (
          <code>handle(req)</code> with <code>say</code>/<code>note</code>/<code>steer</code>,
          tools, an abort signal). The engine in between — <code>LiveSession</code> — never knows
          which side of a wire it is on, which is why the same delegator runs in the page, in a
          headless script, or behind a relay.
        </div>
      </section>

      <section id="session" class="tour-section">
        <h2>
          <span class="tour-num">2</span>the session, every parameter
        </h2>
        <p class="tour-lead">
          The session is <b>nearly immutable after start</b>. What you hand the engine on the left
          becomes the wire object on the right, exactly as <code>composeWire()</code> builds it: the
          prompt is woven from slots in the vendor's template order, the voice lands in{" "}
          <code>audio.output</code>, tools become the hosted backend's function tools when you pick
          that mode. After <code>session.started</code> the only levers left are the three appends
          and <code>session.update</code> of the hosted backend.
        </p>
        <SessionBuilder />
      </section>

      <section id="modalities" class="tour-section">
        <h2>
          <span class="tour-num">3</span>modalities: what goes in, what comes out
        </h2>
        <p class="tour-lead">
          <b>In:</b> the user's voice (a WebRTC track, or PCM frames over WebSocket), typed text, a
          startup <code>input</code> seed, and the three appends. <b>Out:</b> the reply audio
          (continuous, silence included), two fragment transcripts with timeline stamps, the
          delegation ticket, hosted-backend events, acks, usage, and the close. There is no turn
          boundary anywhere: the engine regroups fragments by silence and attributes speech to
          tickets by timing.
        </p>
        <div class="tour-table-scroll">
          <table class="tour-table">
            <thead>
              <tr>
                <th>event</th>
                <th>mode</th>
                <th>transport</th>
                <th>meaning</th>
              </tr>
            </thead>
            <tbody>
              <For each={WIRE_EVENTS}>
                {(event) => (
                  <tr data-dir={event.dir}>
                    <td>
                      <code>{event.type}</code>
                    </td>
                    <td>{event.mode}</td>
                    <td>{event.transport}</td>
                    <td>{event.meaning}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <h3 class="tour-h3">the three ways back in — try them</h3>
        <AppendLab />
      </section>

      <section id="flow" class="tour-section">
        <h2>
          <span class="tour-num">4</span>the event flow, live
        </h2>
        <p class="tour-lead">
          This is the real <code>LiveSession</code> and the real widgets, wired to a stand-in for
          OpenAI that speaks the same events with the timings we measured. Connect, "speak" a
          phrase, and read the ledger. The checklist ticks off the canonical sequence as it happens.
          Switch to the simulated hosted mode to see the vendor's function-call loop instead of a
          client ticket; drag the delay past the progress threshold to hear the engine fill the
          silence; set the idle close short and watch the next connect re-seed.
        </p>
        <Simulator />
        <div class="tour-callout">
          <b>What the engine owns, and why.</b> The wire never says "this speech was that append",
          never carries the request text, and never fills a silence. So the engine keeps the task
          table (ticket → appends → first spoken word → done), reconstructs each request from the
          user transcript since the previous ticket, speaks a progress line on a quiet task, closes
          an idle session (silence is billed) and re-seeds the next one from its own transcript.
          Those are application decisions the vendor leaves to you; the package makes them once.
        </div>
      </section>

      <section id="backends" class="tour-section">
        <h2>
          <span class="tour-num">5</span>backends: who does the thinking
        </h2>
        <p class="tour-lead">
          Six ways to answer a ticket, three places they run. The table is the decision; the code
          below is the whole interface — a backend is one function.
        </p>
        <div class="tour-table-scroll">
          <table class="tour-table">
            <thead>
              <tr>
                <th>backend</th>
                <th>runs</th>
                <th>needs</th>
                <th>a delegation's path</th>
                <th>tools</th>
                <th>measured</th>
                <th>reach for it when</th>
              </tr>
            </thead>
            <tbody>
              <For each={BACKEND_FACTS}>
                {(fact) => (
                  <tr>
                    <td>
                      <b>{fact.label}</b>
                    </td>
                    <td>{fact.where}</td>
                    <td>{fact.needs}</td>
                    <td>{fact.path}</td>
                    <td>{fact.tools}</td>
                    <td>{fact.measured}</td>
                    <td>{fact.useWhen}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <h3 class="tour-h3">the whole interface</h3>
        <pre class="tour-code">{DELEGATOR_SNIPPET}</pre>
        <p class="tour-note">
          Two rules the engine enforces for you: a delegation is serialized per backend only if the
          backend serializes (Claude Code does; the Responses loop runs tickets in parallel), and a
          returned string is spoken only if nothing was said during handling. Cancel is{" "}
          <code>req.signal</code>: the scripted and toy backends stop; the Responses loop aborts its
          fetch; Claude Code gets <code>interrupt()</code>.
        </p>
      </section>

      <section id="keys" class="tour-section">
        <h2>
          <span class="tour-num">6</span>keys
        </h2>
        <KeysProbe />
      </section>

      <section id="claude" class="tour-section">
        <h2>
          <span class="tour-num">7</span>Claude Code, exactly
        </h2>
        <ClaudeSection />
      </section>

      <section id="sessions" class="tour-section">
        <h2>
          <span class="tour-num">8</span>sessions, logs, forks
        </h2>
        <SessionsSection />
      </section>

      <section id="choices" class="tour-section">
        <h2>
          <span class="tour-num">9</span>other choices, and where to read
        </h2>
        <div class="tour-cols">
          <div>
            <h3 class="tour-h3">which backend, when</h3>
            <ul class="tour-list">
              <li>
                <b>Hosted (responses) delegation</b> when the tools live in the page and you want
                zero infrastructure and the lowest latency for small tasks. Its cost: the loop is
                the vendor's, the model must be an OpenAI model, and the tool list is session config
                (mutable, but through <code>session.update</code>).
              </li>
              <li>
                <b>Client delegation with your own Responses loop</b> when you want to watch every
                round, run tools anywhere, or chain models; it costs a key in the page or a server.
              </li>
              <li>
                <b>Client delegation with Claude Code</b> when the answer needs the code, a shell, a
                file, or minutes of work — and you want the agent's context to persist across
                tickets. It costs a server with a logged-in CLI and 10–20 s per answer.
              </li>
              <li>
                <b>The channel as the backend</b> (the proposal's §5, not built): the aiui channel
                already holds the page-tool directory and the pipe into the interactive Claude Code
                session, so a ticket could become a push into the session you are already talking
                to, with <code>oracle_say</code>-style MCP tools coming back. The relay here is the
                standalone version of that idea.
              </li>
            </ul>
            <h3 class="tour-h3">what it costs</h3>
            <p class="tour-note">
              Voice: $0.05 per minute, per second, silence and mute included, so an open idle
              session is $3 an hour — the idle close is load-bearing. Backends bill separately:
              Responses tokens (≈ 1,100 in / 30 out per hosted delegation), Claude Code through the
              CLI's plan (≈ $0.31 for the code-reading answer, reported in the task log).
            </p>
          </div>
          <div>
            <h3 class="tour-h3">measured, 2026-09-15</h3>
            <table class="tour-table">
              <tbody>
                <For each={MEASURED}>
                  {(row) => (
                    <tr>
                      <td>{row.what}</td>
                      <td>{row.value}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
        <h3 class="tour-h3">read the sources</h3>
        <ul class="tour-list">
          <li>
            OpenAI: <a href={LINKS.live}>GPT-Live guide</a> ·{" "}
            <a href={LINKS.livePrompting}>prompting</a> ·{" "}
            <a href={LINKS.liveConversations}>conversations</a> ·{" "}
            <a href={LINKS.liveDelegation}>delegation</a> ·{" "}
            <a href={LINKS.liveMigration}>migration from Realtime</a> ·{" "}
            <a href={LINKS.webrtc}>WebRTC</a> · <a href={LINKS.websockets}>WebSockets</a> ·{" "}
            <a href={LINKS.serverControls}>server controls (the sideband)</a> ·{" "}
            <a href={LINKS.latencyCost}>latency and cost</a> · <a href={LINKS.model}>gpt-live-1</a>
          </li>
          <li>
            Claude Agent SDK: <a href={LINKS.sdkOverview}>overview</a> ·{" "}
            <a href={LINKS.sdkTypescript}>TypeScript reference</a> ·{" "}
            <a href={LINKS.sdkSessions}>sessions</a> ·{" "}
            <a href={LINKS.sdkCustomTools}>custom tools</a> ·{" "}
            <a href={LINKS.sdkPermissions}>permissions</a> ·{" "}
            <a href={LINKS.sdkRepo}>the repository</a>
          </li>
          <li>
            This repo: <a href={LINKS.proposal}>docs/proposals/oracle-live.md</a> (the design and
            the measurements), <code>packages/aiui-live/src/protocol.ts</code> (the typed wire),{" "}
            <code>session.ts</code> (the engine), <code>claude/index.ts</code> (the delegator),{" "}
            <code>exploration/live-probe/</code> (the raw scenarios).
          </li>
        </ul>
      </section>
      <p class="app-foot">
        Then: <a href="/wire.html">1 · wire</a> to hear the timings,{" "}
        <a href="/backends.html">2 · backends</a> to compare who answers,{" "}
        <a href="/">3 · the app</a> for the whole loop.
      </p>
    </div>
  );
}

render(
  () => (
    <PageBoundary name="tour">
      <TourPage />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
