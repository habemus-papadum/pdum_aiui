/**
 * Simulator.tsx — the event flow, run for real: the real `LiveSession`
 * engine and the real widgets, against the fake OpenAI side in
 * `fake-live.ts`. Type what the user would say, pick who answers, twiddle
 * the measured timings, and read the ledger as it happens. The checklist
 * ticks off the canonical sequence as each step shows up in the ledger.
 */

import {
  backendPrompt,
  type DelegationRequest,
  type Delegator,
  echoDelegator,
  type LedgerEntry,
  LiveSession,
  type LiveState,
  runTool,
  scriptedDelegator,
} from "@habemus-papadum/aiui-live";
import {
  LIVE_WIDGET_STYLES,
  LiveCaptions,
  LiveComposer,
  LiveControl,
  LiveLedger,
  LiveTasks,
  stamp,
  useLedger,
  useLiveState,
} from "@habemus-papadum/aiui-live/widgets";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { BACKENDS_SLOTS } from "../live/prompt";
import { benchTools } from "../live/tools";
import { type FakeLiveKnobs, fakeLive, MEASURED_KNOBS } from "./fake-live";
import { explain } from "./glossary";

type SimBackend = "scripted" | "echo" | "toy" | "hosted";

const SIM_BACKENDS: Array<{ id: SimBackend; label: string; blurb: string }> = [
  {
    id: "toy",
    label: "toy reasoner",
    blurb: "keywords pick a tool; logs, a note, then a spoken result — a backend in 30 lines",
  },
  {
    id: "scripted",
    label: "scripted",
    blurb: "waits the delay, answers — watch the progress line past the threshold",
  },
  {
    id: "echo",
    label: "echo",
    blurb: "answers instantly with the request text the engine reconstructed",
  },
  {
    id: "hosted",
    label: "hosted (simulated)",
    blurb:
      "delegation.type: responses — the vendor's loop, toy edition: function call in, answer out",
  },
];

const PHRASES = [
  "what time is it",
  "add 17 and 25",
  "look up the Dirichlet kernel, take 12 seconds",
  "set the frequency to four",
  "hello",
  "never mind, stop",
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });

/** A backend with no model: keywords choose a tool. Everything a real one
 * does — log, note, call a tool, honour cancel, answer — in one function. */
function toyReasoner(): Delegator {
  return {
    name: "toy",
    describe: () => "toy reasoner (keywords → tools, no model)",
    async handle(req: DelegationRequest) {
      const text = req.text.toLowerCase();
      req.log(`reading: "${req.text}"`);
      await sleep(400, req.signal);
      if (/\b(time|clock|date)\b/.test(text)) {
        const result = (await runTool(req.tools, "clock", {})) as { now?: string };
        req.log(`clock → ${JSON.stringify(result)}`);
        return `It is ${result.now ?? "unknown"}.`;
      }
      if (/\b(add|plus|sum)\b/.test(text)) {
        const numbers = (text.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        const result = (await runTool(req.tools, "add", {
          a: numbers[0] ?? 0,
          b: numbers[1] ?? 0,
        })) as { sum?: number };
        req.log(`add → ${JSON.stringify(result)}`);
        return `That makes ${result.sum ?? "?"}.`;
      }
      if (/\blook/.test(text)) {
        const match = /(\d+)\s*second/.exec(text);
        const seconds = match ? Number(match[1]) : 3;
        const term =
          /look(?: it)? up\s+(?:the\s+)?([a-z][a-z\s-]*?)(?:,|\.|\s+take|\s+and|$)/
            .exec(text)?.[1]
            ?.trim() ?? "that";
        await req.note(`Searching the archive for ${term}; about ${seconds} seconds.`);
        req.log(`slow_lookup(${term}, ${seconds} s)`);
        const abort = new Promise<never>((_, reject) =>
          req.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          }),
        );
        const result = (await Promise.race([
          runTool(req.tools, "slow_lookup", { term, seconds }),
          abort,
        ])) as { fact?: string };
        req.log(`slow_lookup → ${JSON.stringify(result).slice(0, 80)}`);
        return result.fact ?? JSON.stringify(result);
      }
      if (/\b(frequency|damping|amplitude|samples)\b/.test(text)) {
        return "There is no oscillator on this page. On the app page this would be an app tool call, set_live_freq, and the applied value would come back in the answer.";
      }
      return `I heard "${req.text}". A real backend would reason about it; the toy only knows time, sums and lookups.`;
    },
  };
}

export function Simulator() {
  const [knobs, setKnobs] = createSignal<FakeLiveKnobs>({ ...MEASURED_KNOBS });
  const [backend, setBackend] = createSignal<SimBackend>("toy");
  const [delay, setDelay] = createSignal(1500);
  const [progressAfter, setProgressAfter] = createSignal(9000);
  const [idleAfter, setIdleAfter] = createSignal(120);
  const [simLog, setSimLog] = createSignal<string[]>([]);
  const [session, setSession] = createSignal<LiveSession | undefined>();
  const [state, setState] = createSignal<LiveState | undefined>();
  const [draft, setDraft] = createSignal("");
  const fake = fakeLive(knobs, (line) => setSimLog((lines) => [...lines.slice(-8), line]));

  const knob = <K extends keyof FakeLiveKnobs>(key: K, value: FakeLiveKnobs[K]) =>
    setKnobs((previous) => ({ ...previous, [key]: value }));

  const delegatorFor = (id: SimBackend): Delegator | undefined => {
    switch (id) {
      case "scripted":
        return scriptedDelegator({
          delayMs: delay(),
          reply: (req) => `Done. I heard: ${req.text}.`,
          notesAt:
            delay() >= 3000 ? [{ atMs: Math.floor(delay() / 2), text: "Halfway there." }] : [],
        });
      case "echo":
        return echoDelegator();
      case "toy":
        return toyReasoner();
      case "hosted":
        return undefined;
    }
  };

  // `id` is passed explicitly because Solid 2 STAGES signal writes: right after
  // setBackend(x), backend() still returns the previous value in the same tick.
  const build = (id: SimBackend): LiveSession =>
    new LiveSession({
      transport: fake.transport,
      config: {
        instructions: BACKENDS_SLOTS,
        delegation:
          id === "hosted"
            ? {
                type: "responses",
                responses: {
                  model: "gpt-5.6-terra",
                  instructions: backendPrompt({ app: "a bench with three toy tools" }),
                  reasoning: { effort: "low" },
                },
              }
            : undefined,
      },
      delegator: delegatorFor(id),
      tools: benchTools(),
      progress: { afterMs: progressAfter() },
      idle: { closeAfterSeconds: idleAfter() },
    });

  const isBusy = (current: LiveSession | undefined) => {
    const status = current?.state().status;
    return status === "live" || status === "connecting" || status === "closing";
  };

  const rebuild = (id: SimBackend) => {
    session()?.currentDelegator()?.dispose?.();
    setSession(build(id));
  };

  const restart = async (id: SimBackend) => {
    const current = session();
    if (current !== undefined && isBusy(current)) {
      await current.close();
    }
    rebuild(id);
  };

  // Engine knobs are constructor options: rebuild when idle (and once, at mount).
  createEffect(
    () => ({ progress: progressAfter(), idle: idleAfter() }),
    () => {
      // Signal reads inside an effect callback are untracked on purpose (Solid 2
      // warns STRICT_READ_UNTRACKED otherwise): the compute above decides when.
      untrack(() => {
        if (!isBusy(session())) {
          rebuild(backend());
        }
      });
    },
  );
  // The scripted delay only needs a new delegator; that works mid-session.
  createEffect(
    () => delay(),
    () => {
      untrack(() => {
        const current = session();
        if (current !== undefined && backend() === "scripted") {
          current.setDelegator(delegatorFor("scripted"));
        }
      });
    },
  );
  // Follow whichever session object is current; the effect RETURNS its unsubscribe.
  createEffect(
    () => session(),
    (current) => {
      if (current === undefined) {
        return;
      }
      setState(current.state());
      return current.onState(setState);
    },
  );
  onCleanup(() => void session()?.close());

  const live = () => state()?.status === "live";
  const say = (text: string) => {
    fake.userSays(text);
    setDraft("");
  };

  return (
    <div class="tour-sim">
      <style>{LIVE_WIDGET_STYLES}</style>
      <div class="tour-knobs">
        <div class="tour-knob-group">
          <h5>who answers (restarts the session)</h5>
          <div class="tour-chips">
            <For each={SIM_BACKENDS}>
              {(choice) => (
                <button
                  type="button"
                  class="tour-chip"
                  data-on={String(backend() === choice.id)}
                  title={choice.blurb}
                  onClick={() => {
                    setBackend(choice.id);
                    void restart(choice.id);
                  }}
                >
                  {choice.label}
                </button>
              )}
            </For>
          </div>
          <p class="tour-note">{SIM_BACKENDS.find((choice) => choice.id === backend())?.blurb}</p>
          <Show when={backend() === "scripted"}>
            <label class="tour-range">
              scripted delay {delay()} ms
              <input
                type="range"
                min="0"
                max="20000"
                step="250"
                value={delay()}
                onInput={(e) => setDelay(Number(e.currentTarget.value))}
              />
            </label>
          </Show>
        </div>
        <div class="tour-knob-group">
          <h5>the voice model (measured defaults; read at connect)</h5>
          <label class="tour-range">
            last word → delegation {knobs().delegateAfterMs} ms
            <input
              type="range"
              min="0"
              max="3000"
              step="50"
              value={knobs().delegateAfterMs}
              onInput={(e) => knob("delegateAfterMs", Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-range">
            commentary → first word {knobs().speakAfterMs} ms
            <input
              type="range"
              min="0"
              max="3000"
              step="50"
              value={knobs().speakAfterMs}
              onInput={(e) => knob("speakAfterMs", Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-range">
            append → ack {knobs().ackAfterMs} ms
            <input
              type="range"
              min="0"
              max="3000"
              step="50"
              value={knobs().ackAfterMs}
              onInput={(e) => knob("ackAfterMs", Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-range">
            speed ×{knobs().speed}
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              value={knobs().speed}
              onInput={(e) => knob("speed", Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={knobs().acknowledgeDelegation}
              onChange={(e) => knob("acknowledgeDelegation", e.currentTarget.checked)}
            />
            says "Okay, hang on." when it delegates
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={knobs().narrateThinking}
              onChange={(e) => knob("narrateThinking", e.currentTarget.checked)}
            />
            narrates thinking appends (what a "relay progress" prompt line buys)
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={knobs().paraphrase}
              onChange={(e) => knob("paraphrase", e.currentTarget.checked)}
            />
            imitates the paraphrase (prefixes a ticket's first line)
          </label>
        </div>
        <div class="tour-knob-group">
          <h5>the engine (applies at the next connect)</h5>
          <label class="tour-range">
            progress line after {progressAfter()} ms of silence on a task
            <input
              type="range"
              min="1000"
              max="20000"
              step="500"
              value={progressAfter()}
              onInput={(e) => setProgressAfter(Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-range">
            idle close after {idleAfter()} s
            <input
              type="range"
              min="5"
              max="300"
              step="5"
              value={idleAfter()}
              onInput={(e) => setIdleAfter(Number(e.currentTarget.value))}
            />
          </label>
          <p class="tour-note">
            Try: scripted at 12 s with progress at 3 s; idle at 10 s, then connect again and watch
            the re-seed in the session config fold.
          </p>
        </div>
      </div>
      <Show when={session()} keyed>
        {(current) => (
          <>
            <div class="bench-row">
              <LiveControl session={current} />
            </div>
            <div class="tour-speak">
              <input
                type="text"
                value={draft()}
                placeholder={live() ? "what the user says (Enter)" : "connect first"}
                disabled={!live()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    say(draft());
                  }
                }}
              />
              <button type="button" disabled={!live()} onClick={() => say(draft())}>
                speak
              </button>
              <For each={PHRASES}>
                {(phrase) => (
                  <button
                    type="button"
                    class="tour-chip"
                    disabled={!live()}
                    onClick={() => say(phrase)}
                  >
                    {phrase}
                  </button>
                )}
              </For>
            </div>
            <Show when={simLog().length > 0}>
              <pre class="bench-serverlog">{simLog().join("\n")}</pre>
            </Show>
            <SimInner session={current} />
          </>
        )}
      </Show>
    </div>
  );
}

function SimInner(props: { session: LiveSession }) {
  const state = useLiveState(props.session);
  const entries = useLedger(props.session);
  const hosted = () => props.session.sessionConfig()?.delegation?.type === "responses";

  const steps = createMemo(() => {
    const e = entries();
    const any = (pred: (entry: LedgerEntry) => boolean) => e.some(pred);
    const shared = [
      {
        label: "connect → session.started (the engine flips to live, arms the idle timer)",
        done: any((x) => x.kind === "session" && x.dir === "in" && x.summary.startsWith("started")),
      },
      {
        label: "you speak → session.input_transcript.delta fragments, regrouped by silence",
        done: any((x) => x.kind === "transcript" && x.summary.startsWith("user:")),
      },
      {
        label: `the model delegates → session.delegation.created (target ${hosted() ? "responses" : "client"}; an id and offset_ms, nothing else)`,
        done: any((x) => x.kind === "delegation" && x.dir === "in"),
      },
    ];
    const middle = hosted()
      ? [
          {
            label:
              "response.event: the hosted backend asks for a tool (response.output_item.done, a function_call item)",
            done: any((x) => x.kind === "response" && x.summary === "response.output_item.done"),
          },
          {
            label:
              "the page runs the tool and answers: response.item.create (function_call_output) + response.create",
            done: any((x) => x.kind === "response" && x.dir === "out"),
          },
          {
            label:
              "response.event: response.completed — the text the voice model will speak; the engine closes the task",
            done: any((x) => x.kind === "response" && x.summary === "response.completed"),
          },
        ]
      : [
          {
            label:
              "the engine hands the ticket to the delegator with the user's words since the last ticket",
            done: any(
              (x) => x.kind === "delegation" && x.dir === "local" && x.summary.startsWith("→"),
            ),
          },
          {
            label: "the delegator logs (UI only) and notes (session.thinking.append, quiet)",
            done:
              any((x) => x.kind === "backend") ||
              any((x) => x.kind === "append" && x.summary.startsWith("thinking")),
          },
          {
            label: "say → session.commentary.append with the ticket's delegation_id",
            done: any((x) => x.kind === "append" && x.summary.startsWith("commentary")),
          },
          {
            label: "…appended — the ack, matched by client_event_id",
            done: any((x) => x.kind === "ack"),
          },
        ];
    const tail = [
      {
        label:
          "the voice model speaks → session.output_transcript.delta (the engine attributes the first fragment to the task: 🔊)",
        done: any((x) => x.kind === "transcript" && x.summary.startsWith("assistant:")),
      },
      {
        label: "the task closes: done, failed or cancelled (∑ on the task row)",
        done:
          any(
            (x) =>
              x.kind === "delegation" && x.dir === "local" && /^(done|cancelled)/.test(x.summary),
          ) || any((x) => x.kind === "error" && x.summary.startsWith("failed")),
      },
      {
        label: "session.usage.updated — billed seconds, about every 15 s",
        done: any((x) => x.kind === "usage"),
      },
      {
        label: "close → session.closed (yours, the idle timer's, or the vendor's expiry)",
        done: any((x) => x.kind === "session" && x.dir === "in" && x.summary.startsWith("closed")),
      },
    ];
    return [...shared, ...middle, ...tail];
  });

  const last = () => entries().at(-1);

  return (
    <div class="tour-sim-body">
      <div class="tour-sim-cols">
        <div>
          <h3 class="tour-h3">the sequence, ticked off from the ledger</h3>
          <ol class="tour-steps">
            <For each={steps()}>
              {(step) => (
                <li data-done={String(step.done)}>
                  <span class="tour-step-mark">{step.done ? "✓" : "·"}</span> {step.label}
                </li>
              )}
            </For>
          </ol>
          <h3 class="tour-h3">captions</h3>
          <LiveCaptions session={props.session} />
          <h3 class="tour-h3">by hand</h3>
          <LiveComposer session={props.session} />
          <p class="tour-note">
            Send a <b>note</b> session-wide ("the user is on the settings page"), then speak a
            question about it: the real model answers from the note without a ticket. Send a
            commentary on an open ticket and watch 🔊 on its row.
          </p>
        </div>
        <div>
          <h3 class="tour-h3">
            tasks <span class="muted">({state().openTasks} open)</span>
          </h3>
          <LiveTasks session={props.session} />
          <h3 class="tour-h3">what just happened</h3>
          <Show when={last()} fallback={<p class="tour-note">nothing yet — connect</p>}>
            {(entry) => (
              <div class="tour-explain">
                <div class="tour-explain-row">
                  <span class="muted">{stamp(entry().t)}</span> <b>{entry().kind}</b>{" "}
                  <span>{entry().summary.slice(0, 120)}</span>
                </div>
                <p>{explain(entry())}</p>
              </div>
            )}
          </Show>
        </div>
      </div>
      <h3 class="tour-h3">the ledger — every event, both directions, ms since connect</h3>
      <LiveLedger session={props.session} />
      <details class="bench-fold">
        <summary>session config (as this session sent it)</summary>
        <pre>
          {state().status === "idle"
            ? "(connect first)"
            : JSON.stringify(props.session.sessionConfig(), null, 1)}
        </pre>
      </details>
    </div>
  );
}
