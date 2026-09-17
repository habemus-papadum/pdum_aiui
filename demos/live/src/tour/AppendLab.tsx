/**
 * AppendLab.tsx — the three ways back into the voice model, and the two
 * ways to type at it. Pick a kind, write text, see the exact event, the
 * token estimate against the 500-token cap, how a long text is chunked,
 * and the ack that settles it. The tables beside it say what the model
 * DOES with each kind — the measured answer, not the brochure.
 */

import {
  APPEND_TOKEN_LIMIT,
  APPENDED_EVENT,
  type AppendKind,
  appendEvent,
  approxTokens,
  chunkForAppend,
  typedInputEvents,
} from "@habemus-papadum/aiui-live";
import { createMemo, createSignal, For, Show } from "solid-js";

const KINDS: Array<{ kind: AppendKind; method: string; does: string; measured: string }> = [
  {
    kind: "commentary",
    method: "say / req.say",
    does: "Something to say aloud. The model paraphrases and compresses.",
    measured:
      "'Done. The frequency is now 5 hertz.' came out as 'Done. It's set to five hertz.'; 'Frequency set to 5 hertz.' became just 'Done.' First word 0.52–0.67 s after the append.",
  },
  {
    kind: "thinking",
    method: "note / req.note",
    does: "A quiet fact for later. Not spoken on arrival — unless the prompt says to narrate progress.",
    measured:
      "With delegation_id null it answered 'what is the damping?' from a note without delegating (0.9 s). With a 'relay progress' line in the prompt a note was spoken as 'Still checking. I'm reading the renderer…'.",
  },
  {
    kind: "instructions",
    method: "steer / req.steer",
    does: "A trusted directive; can interrupt speech; exact wording survives. Append-only, for the session's life.",
    measured:
      "The vendor's own pattern for 'stop', disclosures and greetings; the oracle's 'say only done' survives as a line here.",
  },
];

const SHORT =
  "Done. The frequency is now four hertz, and the trace has two hundred and fifty-six samples.";
const LONG = Array.from(
  { length: 9 },
  (_, i) =>
    `Paragraph ${i + 1}: the trace is a polyline through samples of x(t) = A e^(−ζωt) cos(ωt + φ) over four seconds; with few samples per cycle the straight segments between them show, which is what reads as jagged, and raising the sample count or lowering the frequency smooths it again.`,
).join(" ");

export function AppendLab() {
  const [kind, setKind] = createSignal<AppendKind>("commentary");
  const [target, setTarget] = createSignal<"null" | "item">("item");
  const [text, setText] = createSignal(SHORT);
  const [typedMode, setTypedMode] = createSignal<"client" | "responses">("client");

  const delegationId = () => (target() === "null" ? null : "item_9f3c…");
  const tokens = createMemo(() => approxTokens(text()));
  const chunks = createMemo(() => chunkForAppend(text()));
  const event = createMemo(() => appendEvent(kind(), "c_7", delegationId(), chunks()[0] ?? ""));
  const ack = () => ({
    type: APPENDED_EVENT[kind()],
    event_id: "s_41",
    client_event_id: "c_7",
    delegation_id: delegationId(),
    start_ms: 18_420,
    end_ms: 18_440,
  });
  const info = () => KINDS.find((candidate) => candidate.kind === kind());

  return (
    <div class="tour-builder">
      <div class="tour-form">
        <label>
          kind
          <select value={kind()} onChange={(e) => setKind(e.currentTarget.value as AppendKind)}>
            <For each={KINDS}>
              {(entry) => (
                <option value={entry.kind}>
                  {entry.kind} — {entry.method}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          delegation_id
          <select value={target()} onChange={(e) => setTarget(e.currentTarget.value as "null")}>
            <option value="item">
              an open ticket's id (what a delegator's say/note/steer uses)
            </option>
            <option value="null">
              null — session-wide (UI context, a greeting, a typed request's answer)
            </option>
          </select>
        </label>
        <label>
          content
          <textarea rows={5} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        </label>
        <div class="tour-chips">
          <button type="button" class="tour-chip" onClick={() => setText(SHORT)}>
            a short result
          </button>
          <button type="button" class="tour-chip" onClick={() => setText(LONG)}>
            a long answer (chunked)
          </button>
          <button type="button" class="tour-chip" onClick={() => setText("Still working on it.")}>
            the progress line
          </button>
        </div>
        <p class="tour-meter">
          ≈ {tokens()} tokens (3.5 chars each, conservative) against a cap of {APPEND_TOKEN_LIMIT}
          {" → "}
          <b>{chunks().length}</b> append{chunks().length === 1 ? "" : "s"} (chunked at 70 % of the
          cap, on sentence ends)
        </p>
        <Show when={chunks().length > 1}>
          <ol class="tour-chunks">
            <For each={chunks()}>
              {(chunk) => (
                <li>
                  <span class="muted">≈ {approxTokens(chunk)} t</span> {chunk.slice(0, 90)}…
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
      <div class="tour-out">
        <h4>the event (first chunk)</h4>
        <pre class="tour-json">{JSON.stringify(event(), null, 1)}</pre>
        <h4>its ack, ≈ 0.7 s later</h4>
        <pre class="tour-json">{JSON.stringify(ack(), null, 1)}</pre>
        <p class="tour-note">
          The ack means <em>injected</em>, not spoken: in our runs the first word of a commentary
          was already out before the ack arrived. A stale id gets <code>error</code> "Unknown client
          delegation."; more than 500 tokens gets <code>invalid_value</code> — the engine never
          sends either, because it chunks and it knows its tickets.
        </p>
        <h4>what {kind()} does</h4>
        <p>
          <b>{info()?.does}</b>
        </p>
        <p class="tour-note">measured: {info()?.measured}</p>
      </div>
      <div class="tour-wide">
        <h4>typing at it</h4>
        <div class="tour-form tour-form-row">
          <label>
            mode
            <select
              value={typedMode()}
              onChange={(e) => setTypedMode(e.currentTarget.value as "client")}
            >
              <option value="client">client delegation</option>
              <option value="responses">hosted (responses) delegation</option>
            </select>
          </label>
          <Show
            when={typedMode() === "client"}
            fallback={
              <div>
                <p class="tour-note">
                  Hosted mode: the text goes to the vendor's backend as a user message item, then a{" "}
                  <code>response.create</code> — two events, and the reply comes back as{" "}
                  <code>response.event</code>s like any delegation.
                </p>
                <pre class="tour-json">
                  {JSON.stringify(typedInputEvents("set the frequency to four", "c_8"), null, 1)}
                </pre>
              </div>
            }
          >
            <p class="tour-note">
              Client mode: <b>nothing goes on the wire.</b> The engine opens a <em>local</em> task (
              <code>local_3</code>) and runs the delegator on the typed text; its appends go out
              with <code>delegation_id: null</code>, because the voice model never issued a ticket
              for it. The voice model hears the answer as session-wide commentary.
            </p>
          </Show>
        </div>
        <h4>what never reaches the voice model</h4>
        <ul class="tour-list">
          <li>images and screenshots — the voice model cannot see; send them to the backend</li>
          <li>tool definitions — it has no tools; in hosted mode they belong to the backend</li>
          <li>
            a new prompt — instructions are append-only; the engine's re-seed uses{" "}
            <code>input</code> on the <em>next</em> session instead
          </li>
        </ul>
      </div>
    </div>
  );
}
