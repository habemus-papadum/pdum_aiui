/**
 * KeysProbe.tsx — where the key is, and where it is not. Probes THIS
 * page's environment: a pasted key in localStorage, a dev key injected by
 * the aiui Vite plugin, the server broker's readiness (GET /live/info).
 * Only presence is ever shown; no key material is read into the DOM.
 */

import {
  browserKey,
  devKey,
  PASTED_KEY_STORAGE_KEY,
  standardBrokers,
} from "@habemus-papadum/aiui-live";
import { createSignal, For, Show } from "solid-js";

interface Probe {
  pasted: boolean;
  dev: boolean;
  server: { ok: boolean; keyed?: boolean; delegators?: string[]; error?: string };
}

const FLOWS = [
  {
    name: "paste-key",
    holds:
      "the user's own project key, in localStorage (aiui.oracle.key — one slot shared with the oracle)",
    exchange: "the page POSTs /v1/live/sessions itself (CORS on that route is open — measured)",
    backends: "in-page backends can use it too (responses-browser)",
    when: "a static build; a person who knowingly holds their key",
  },
  {
    name: "dev-key",
    holds:
      'window.__AIUI__.devKeys.openai, injected by aiui({ devKeys: ["openai"] }) — dev serve only, never in a build',
    exchange: "same direct POST as paste-key",
    backends: "same as paste-key",
    when: "developing a static app: it just works, no pasting",
  },
  {
    name: "server",
    holds:
      "nothing in the page; OPENAI_API_KEY lives in the server process (the Vite plugin here; the channel or any node server elsewhere)",
    exchange:
      "the page POSTs its SDP offer to /live/sessions on its own origin; the server does the vendor exchange and returns the answer",
    backends:
      "server-side delegators over the relay (responses-server, claude) use the server's key or the CLI's login",
    when: "the key must never reach a browser — the aiui posture for installed users (OS vault, env in a source checkout)",
  },
];

export function KeysProbe() {
  const [probe, setProbe] = createSignal<Probe | undefined>();
  const chain = standardBrokers({ serverUrl: "/live/sessions" });

  const run = async () => {
    let pasted = false;
    try {
      pasted = (localStorage.getItem(PASTED_KEY_STORAGE_KEY)?.trim() ?? "") !== "";
    } catch {
      pasted = false;
    }
    const dev = devKey() !== undefined;
    let server: Probe["server"];
    try {
      const response = await fetch("/live/info");
      const body = (await response.json()) as { keyed?: boolean; delegators?: string[] };
      server = { ok: response.ok, keyed: body.keyed, delegators: body.delegators };
    } catch (error) {
      server = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    setProbe({ pasted, dev, server });
  };

  const winner = (p: Probe) =>
    p.pasted
      ? "paste-key"
      : p.dev
        ? "dev-key:openai"
        : p.server.keyed
          ? "server:/live/sessions"
          : "none — no broker would answer";

  return (
    <div class="tour-keys">
      <p>
        GPT-Live has <b>no ephemeral keys</b>. A session is created by{" "}
        <code>POST /v1/live/sessions</code> with the <em>project</em> key, so the only question is
        who holds it. The engine asks a <b>broker</b>; the standard one is a chain, first to answer
        wins: <code>{chain.describe()}</code>.
      </p>
      <table class="tour-table">
        <thead>
          <tr>
            <th>broker</th>
            <th>who holds the key</th>
            <th>the exchange</th>
            <th>backends it enables</th>
            <th>use it when</th>
          </tr>
        </thead>
        <tbody>
          <For each={FLOWS}>
            {(flow) => (
              <tr>
                <td>
                  <code>{flow.name}</code>
                </td>
                <td>{flow.holds}</td>
                <td>{flow.exchange}</td>
                <td>{flow.backends}</td>
                <td>{flow.when}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="tour-chips">
        <button type="button" class="tour-chip" onClick={() => void run()}>
          probe this page's environment
        </button>
        <span class="muted">reads presence only; never prints a key</span>
      </div>
      <Show when={probe()}>
        {(p) => (
          <dl class="tour-facts">
            <dt>pasted key in localStorage</dt>
            <dd>{p().pasted ? "present" : "absent"}</dd>
            <dt>dev key injected by the Vite plugin</dt>
            <dd>{p().dev ? "present (window.__AIUI__.devKeys.openai)" : "absent"}</dd>
            <dt>GET /live/info</dt>
            <dd>
              {p().server.ok
                ? `ok · keyed: ${String(p().server.keyed)} · delegators: ${(p().server.delegators ?? []).join(", ")}`
                : `unreachable (${p().server.error ?? "not ok"}) — no live backend on this origin`}
            </dd>
            <dt>the chain would use</dt>
            <dd>
              <b>{winner(p())}</b>
            </dd>
            <dt>an in-page backend (browserKey())</dt>
            <dd>{browserKey() === undefined ? "no key — use a server delegator" : "has a key"}</dd>
          </dl>
        )}
      </Show>
      <h4>and Claude Code's credentials?</h4>
      <p>
        None cross the wire at all. The Agent SDK spawns the CLI, and the CLI authenticates with its
        own login (<code>apiKeySource: none</code> in the init message — measured). The dev server
        needs a logged-in Claude Code on the machine, nothing else; the page never learns anything
        about it. The delegator scrubs <code>CLAUDECODE</code>, <code>CLAUDE_PID</code> and every{" "}
        <code>CLAUDE_CODE_*</code> variable from the child's environment so a dev server started
        from inside a Claude Code terminal does not hand the child its parent's identity.
      </p>
      <h4>and the hosted backend's bill?</h4>
      <p>
        Hosted (responses) delegation runs on the vendor's side under the same project key that
        created the session: the voice seconds and the backend tokens land on one bill. A client
        backend pays its own way — the Responses loop with whichever key it was given, Claude Code
        through the CLI's plan.
      </p>
    </div>
  );
}
