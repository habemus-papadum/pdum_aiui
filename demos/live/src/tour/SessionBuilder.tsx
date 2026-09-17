/**
 * SessionBuilder.tsx — every parameter of a session, twiddled: the config
 * you give `LiveSession` on one side, the wire object it composes on the
 * other, exactly as `composeWire()` would (same defaults, same weaving).
 * Nothing is sent anywhere.
 */

import {
  backendPrompt,
  backendToolFor,
  DEFAULT_LIVE_VOICE,
  LIVE_MODEL,
  LIVE_VOICES,
  type LiveDelegationConfig,
  type LiveInputMessage,
  type LivePromptSlots,
  type LiveSessionConfig,
  livePrompt,
  type ReasoningEffort,
} from "@habemus-papadum/aiui-live";
import { createMemo, createSignal, For, Show } from "solid-js";
import { BACKENDS_SLOTS } from "../live/prompt";
import { benchTools } from "../live/tools";
import { ENGINE_OPTIONS, LINKS } from "./glossary";

const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

const EXAMPLE_SEED: LiveInputMessage[] = [
  {
    role: "developer",
    content: [
      {
        type: "input_text",
        text: "The conversation below happened moments ago in this same session, before a pause. Continue naturally; do not greet again.",
      },
    ],
  },
  { role: "user", content: [{ type: "input_text", text: "Set the frequency to four hertz." }] },
  { role: "assistant", content: [{ type: "output_text", text: "Done. It's at four hertz." }] },
];

interface FieldNote {
  field: string;
  frozen: string;
  note: string;
  link?: string;
}

const FIELD_NOTES: FieldNote[] = [
  {
    field: "model",
    frozen: "frozen",
    note: "gpt-live-1 is the only live model today.",
    link: LINKS.model,
  },
  {
    field: "instructions",
    frozen: "append-only",
    note: "≤ 16,384 tokens. Woven from slots in the vendor's template order: persona, backchannel policy, interruption policy, delegation policy (tools / when / when not), closing rule. Later text arrives only through session.instructions.append.",
    link: LINKS.livePrompting,
  },
  {
    field: "input",
    frozen: "startup only",
    note: "≤ 128 messages / 8,192 tokens of prior conversation. The engine fills it from its own transcript after an idle close (the 're-seed'), or you pass one.",
    link: LINKS.liveConversations,
  },
  {
    field: "audio.format",
    frozen: "frozen",
    note: "WebSocket only (PCM 24 k / 16 k, or G.711). WebRTC negotiates its own media and must leave it out.",
    link: LINKS.websockets,
  },
  {
    field: "audio.output.voice",
    frozen: "frozen",
    note: "14 voices; marin is the default.",
    link: LINKS.model,
  },
  {
    field: "delegation.type",
    frozen: "frozen",
    note: "client: you get a ticket and nothing else. responses: the vendor runs a Responses model behind the ticket.",
    link: LINKS.liveDelegation,
  },
  {
    field: "delegation.responses.*",
    frozen: "mutable",
    note: "The one live lever besides appends: session.update { session: { delegation: { responses: … } } }. Tools default to the engine's tools list when you give none.",
    link: LINKS.liveDelegation,
  },
  {
    field: "store",
    frozen: "frozen",
    note: "true keeps a 30-day stereo recording (input left, output right), downloadable, and forkable into a new session.",
    link: LINKS.live,
  },
];

export function SessionBuilder() {
  const [model, setModel] = createSignal(LIVE_MODEL);
  const [voice, setVoice] = createSignal<string>(DEFAULT_LIVE_VOICE);
  const [slots, setSlots] = createSignal<LivePromptSlots>({ ...BACKENDS_SLOTS });
  const [mode, setMode] = createSignal<"client" | "responses">("client");
  const [rModel, setRModel] = createSignal("gpt-5.6-terra");
  const [effort, setEffort] = createSignal<ReasoningEffort>("low");
  const [rInstructions, setRInstructions] = createSignal(
    backendPrompt({ app: "a bench with three toy tools" }),
  );
  const [picked, setPicked] = createSignal<string[]>(["clock", "add"]);
  const [toolChoice, setToolChoice] = createSignal<"auto" | "none" | "required">("auto");
  const [parallel, setParallel] = createSignal(true);
  const [maxTokens, setMaxTokens] = createSignal(0);
  const [tier, setTier] = createSignal("");
  const [store, setStore] = createSignal(false);
  const [seed, setSeed] = createSignal(false);
  const [transport, setTransport] = createSignal<"webrtc" | "websocket">("webrtc");
  const [showPrompt, setShowPrompt] = createSignal(false);

  const tools = benchTools();
  const setSlot = (key: keyof LivePromptSlots, value: string) =>
    setSlots((previous) => ({ ...previous, [key]: value }));

  const prompt = createMemo(() => livePrompt(slots()));

  const wire = createMemo((): LiveSessionConfig => {
    const delegation: LiveDelegationConfig =
      mode() === "client"
        ? { type: "client" }
        : {
            type: "responses",
            responses: {
              model: rModel(),
              instructions: rInstructions(),
              tools: tools.filter((tool) => picked().includes(tool.name)).map(backendToolFor),
              ...(toolChoice() === "auto" ? {} : { tool_choice: toolChoice() }),
              ...(parallel() ? {} : { parallel_tool_calls: false }),
              ...(maxTokens() >= 16 ? { max_output_tokens: maxTokens() } : {}),
              ...(tier() === "" ? {} : { service_tier: tier() as "auto" }),
              reasoning: { effort: effort() },
            },
          };
    return {
      model: model(),
      instructions: prompt(),
      audio: {
        ...(transport() === "websocket" ? { format: { type: "audio/pcm", rate: 24000 } } : {}),
        output: { voice: voice() },
      },
      delegation,
      ...(store() ? { store: true } : {}),
      ...(seed() ? { input: EXAMPLE_SEED } : {}),
    };
  });

  const wireText = createMemo(() => {
    const value = wire();
    const shown = showPrompt()
      ? value
      : {
          ...value,
          instructions: `(${value.instructions?.length ?? 0} chars — toggle 'full prompt')`,
        };
    return JSON.stringify(shown, null, 1);
  });

  const envelope = () =>
    transport() === "webrtc"
      ? `POST https://api.openai.com/v1/live/sessions
Authorization: Bearer <PROJECT KEY — on a server, or pasted by the user>
Content-Type: application/json

{ "session": <the object on the right>, "transport": { "type": "webrtc", "sdp": "<the browser's offer>" } }

→ 201 { "session": { "id": "…" }, "transport": { "sdp": "<answer>" } }
(then: setRemoteDescription, wait for session.started on the data channel)`
      : `wss://api.openai.com/v1/live/sessions
Authorization: Bearer <PROJECT KEY>   (a header — browsers cannot set one, hence WebRTC there)

first message:
{ "type": "session.start", "event_id": "start", "session": <the object on the right> }
then session.input_audio.append frames, continuously`;

  return (
    <div class="tour-builder">
      <div class="tour-form">
        <h4>what you hand LiveSession (config)</h4>
        <label>
          model
          <input type="text" value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
        </label>
        <label>
          voice
          <select value={voice()} onChange={(e) => setVoice(e.currentTarget.value)}>
            <For each={LIVE_VOICES}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </label>
        <label>
          transport (decides audio.format)
          <select
            value={transport()}
            onChange={(e) => setTransport(e.currentTarget.value as "webrtc" | "websocket")}
          >
            <option value="webrtc">webrtc (browser)</option>
            <option value="websocket">websocket (node)</option>
          </select>
        </label>
        <h5>instructions — the slots livePrompt() weaves</h5>
        <For
          each={
            [
              ["app", "app — what this app IS (standing)"],
              ["stance", "stance — how to behave this conversation"],
              [
                "backendTools",
                "backendTools — what the backend can do, as the voice model should say it",
              ],
              ["delegateWhen", "delegateWhen — bullet lines"],
              ["dontDelegateWhen", "dontDelegateWhen — bullet lines"],
              ["extra", "extra — verbatim"],
            ] as Array<[keyof LivePromptSlots, string]>
          }
        >
          {([key, label]) => (
            <label>
              {label}
              <textarea
                rows={key === "app" || key === "backendTools" ? 3 : 2}
                value={slots()[key] ?? ""}
                onInput={(e) => setSlot(key, e.currentTarget.value)}
              />
            </label>
          )}
        </For>
        <h5>delegation</h5>
        <label>
          type (frozen for the session)
          <select
            value={mode()}
            onChange={(e) => setMode(e.currentTarget.value as "client" | "responses")}
          >
            <option value="client">client — you answer the tickets</option>
            <option value="responses">responses — the vendor runs a model behind them</option>
          </select>
        </label>
        <Show when={mode() === "responses"}>
          <label>
            responses.model
            <input type="text" value={rModel()} onInput={(e) => setRModel(e.currentTarget.value)} />
          </label>
          <label>
            responses.reasoning.effort
            <select
              value={effort()}
              onChange={(e) => setEffort(e.currentTarget.value as ReasoningEffort)}
            >
              <For each={EFFORTS}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <label>
            responses.instructions (backendPrompt(): context / task / return format)
            <textarea
              rows={5}
              value={rInstructions()}
              onInput={(e) => setRInstructions(e.currentTarget.value)}
            />
          </label>
          <div class="tour-checks">
            responses.tools (the engine's tools list, as function tools)
            <For each={tools}>
              {(tool) => (
                <label class="tour-check">
                  <input
                    type="checkbox"
                    checked={picked().includes(tool.name)}
                    onChange={(e) =>
                      setPicked((previous) =>
                        e.currentTarget.checked
                          ? [...previous, tool.name]
                          : previous.filter((name) => name !== tool.name),
                      )
                    }
                  />
                  {tool.name}
                </label>
              )}
            </For>
          </div>
          <label>
            responses.tool_choice
            <select
              value={toolChoice()}
              onChange={(e) => setToolChoice(e.currentTarget.value as "auto")}
            >
              <option value="auto">auto</option>
              <option value="none">none</option>
              <option value="required">required</option>
            </select>
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={parallel()}
              onChange={(e) => setParallel(e.currentTarget.checked)}
            />
            responses.parallel_tool_calls
          </label>
          <label>
            responses.max_output_tokens (≥ 16; 0 = omit)
            <input
              type="number"
              min="0"
              value={maxTokens()}
              onInput={(e) => setMaxTokens(Number(e.currentTarget.value))}
            />
          </label>
          <label>
            responses.service_tier
            <select value={tier()} onChange={(e) => setTier(e.currentTarget.value)}>
              <option value="">(omit)</option>
              <option value="auto">auto</option>
              <option value="default">default</option>
              <option value="flex">flex</option>
              <option value="priority">priority</option>
            </select>
          </label>
        </Show>
        <h5>persistence</h5>
        <label class="tour-check">
          <input
            type="checkbox"
            checked={store()}
            onChange={(e) => setStore(e.currentTarget.checked)}
          />
          store — keep a 30-day stereo recording (forkable)
        </label>
        <label class="tour-check">
          <input
            type="checkbox"
            checked={seed()}
            onChange={(e) => setSeed(e.currentTarget.checked)}
          />
          input — seed with an example of what the idle re-seed sends
        </label>
      </div>
      <div class="tour-out">
        <h4>
          the wire object, as composeWire() builds it{" "}
          <label class="tour-check tour-inline">
            <input
              type="checkbox"
              checked={showPrompt()}
              onChange={(e) => setShowPrompt(e.currentTarget.checked)}
            />
            full prompt
          </label>
        </h4>
        <pre class="tour-json">{wireText()}</pre>
        <h4>how it travels</h4>
        <pre class="tour-json">{envelope()}</pre>
        <h4>the woven prompt ({prompt().length} chars)</h4>
        <pre class="tour-json tour-prompt">{prompt()}</pre>
      </div>
      <div class="tour-wide">
        <h4>field by field</h4>
        <table class="tour-table">
          <thead>
            <tr>
              <th>field</th>
              <th>after start</th>
              <th>meaning</th>
            </tr>
          </thead>
          <tbody>
            <For each={FIELD_NOTES}>
              {(note) => (
                <tr>
                  <td>
                    <code>{note.field}</code>
                  </td>
                  <td>
                    <span class="tour-tag" data-kind={note.frozen}>
                      {note.frozen}
                    </span>
                  </td>
                  <td>
                    {note.note}{" "}
                    <Show when={note.link}>
                      {(href) => (
                        <a href={href()} target="_blank" rel="noreferrer">
                          docs
                        </a>
                      )}
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <h4>the engine's own options (LiveSessionOptions) — never on the wire</h4>
        <table class="tour-table">
          <thead>
            <tr>
              <th>option</th>
              <th>default</th>
              <th>what it does</th>
            </tr>
          </thead>
          <tbody>
            <For each={ENGINE_OPTIONS}>
              {(option) => (
                <tr>
                  <td>
                    <code>{option.key}</code>
                  </td>
                  <td>
                    <code>{option.defaultValue}</code>
                  </td>
                  <td>{option.meaning}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
