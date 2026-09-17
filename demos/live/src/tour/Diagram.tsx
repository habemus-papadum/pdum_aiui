/**
 * Diagram.tsx — the shape of the thing: three parties (your page, the voice
 * service, a backend) and the two seams a host plugs into. Pick a backend
 * to see where its code runs and which hops a delegation takes.
 */

import { createSignal, For } from "solid-js";
import { BACKEND_FACTS } from "./glossary";

export function Diagram() {
  const [picked, setPicked] = createSignal("claude");
  const fact = () => BACKEND_FACTS.find((candidate) => candidate.id === picked());
  const on = (where: "browser" | "server" | "vendor") => fact()?.where === where;
  return (
    <div class="tour-diagram">
      <div class="tour-diagram-grid">
        <div class="tour-box" data-on="true">
          <h4>your page</h4>
          <ul>
            <li>the app and its tools (a control surface, a clock, anything)</li>
            <li>
              <code>LiveSession</code> — the engine: tasks, appends and acks, transcript, progress,
              idle close
            </li>
            <li>
              <code>webRtcTransport</code> — mic out as a track, reply in as a track, events on the{" "}
              <code>oai-events</code> data channel
            </li>
            <li data-dim={String(!on("browser"))}>
              an in-page delegator — scripted, echo, a Responses loop with a browser key
            </li>
          </ul>
        </div>
        <div class="tour-arrow">
          <span>WebRTC</span>
          <span>audio both ways + JSON events</span>
        </div>
        <div class="tour-box" data-on="true">
          <h4>OpenAI · gpt-live-1</h4>
          <ul>
            <li>listens and speaks at the same time (full duplex); backchannels; interruptions</li>
            <li>follows a short prompt whose heart is a delegation policy</li>
            <li>
              cannot call tools, cannot see images — it opens a <b>delegation ticket</b> instead
            </li>
            <li data-dim={String(!on("vendor"))}>
              hosted mode: also runs a Responses model of your choosing behind the ticket
            </li>
          </ul>
        </div>
        <div class="tour-arrow" data-dim={String(!on("server"))}>
          <span>WS /live/delegate</span>
          <span>delegations out, appends back, tools round-trip</span>
        </div>
        <div class="tour-box" data-on={String(on("server"))}>
          <h4>your server (the Vite dev server here)</h4>
          <ul>
            <li>
              the <b>broker</b>: <code>POST /live/sessions</code> exchanges the SDP offer with the
              project key the page never holds
            </li>
            <li>
              the <b>relay</b>: one WebSocket per page session, running a server-side delegator
            </li>
            <li>
              <code>claudeDelegator</code> → Agent SDK → a <code>claude</code> child process
            </li>
            <li>
              <code>responsesDelegator</code> with the server's key
            </li>
          </ul>
        </div>
      </div>
      <div class="tour-chips">
        <For each={BACKEND_FACTS}>
          {(candidate) => (
            <button
              type="button"
              class="tour-chip"
              data-on={String(picked() === candidate.id)}
              data-where={candidate.where}
              onClick={() => setPicked(candidate.id)}
            >
              {candidate.label}
            </button>
          )}
        </For>
      </div>
      <dl class="tour-facts">
        <dt>runs</dt>
        <dd>{fact()?.where}</dd>
        <dt>needs</dt>
        <dd>{fact()?.needs}</dd>
        <dt>a delegation's path</dt>
        <dd>{fact()?.path}</dd>
        <dt>tools</dt>
        <dd>{fact()?.tools}</dd>
        <dt>measured</dt>
        <dd>{fact()?.measured}</dd>
        <dt>reach for it when</dt>
        <dd>{fact()?.useWhen}</dd>
      </dl>
    </div>
  );
}
