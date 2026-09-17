/**
 * Claude.tsx — Claude Code as the backend, exactly: what the Agent SDK is
 * (a typed client for the CLI's stream-json mode), how the delegator wires
 * one long-lived query with an in-process MCP server, which options it
 * sets and why, and what it would take to expose more. The catalog tables
 * are generated from `sdk-catalog.ts`, itself extracted verbatim from the
 * installed SDK's type definitions and bundle — see the notes file beside
 * it for provenance. The sessions chapter reads the same catalog.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import { LINKS } from "./glossary";
import {
  CONTROL_REQUESTS,
  EFFORT_VALUES,
  FIXED_ARGV,
  PERMISSION_MODES,
  QUERY_METHODS,
  SDK_MESSAGE_TYPES,
  SDK_OPTIONS,
  SDK_VERSION,
  type SdkGroup,
  SESSION_FUNCTIONS,
  SPAWN_ENV,
} from "./sdk-catalog";

/** What `claudeDelegator` passes to `query()` — the keys in packages/aiui-live/src/claude/index.ts. */
const SET_BY_DELEGATOR = new Set([
  "cwd",
  "model",
  "effort",
  "permissionMode",
  "allowDangerouslySkipPermissions",
  "allowedTools",
  "mcpServers",
  "systemPrompt",
  "settingSources",
  "strictMcpConfig",
  "maxTurns",
  "env",
  "pathToClaudeCodeExecutable",
  "includePartialMessages",
]);

/** The rest of the delegator's contract with the SDK, read from the same file. */
const DELEGATOR_RUNTIME = [
  [
    "one query per delegator",
    "created lazily on the first ticket, in streaming-input mode (an AsyncIterable of user messages); it lives until dispose(). The agent keeps its context across tickets — a follow-up lands in the session that just read the code.",
  ],
  [
    "a ticket is one user message",
    'pushed as <delegation id="…"> + the request text with recent transcript + the app tools list. Pushed only after the previous turn\'s `result`: a message pushed mid-turn is not interleaved (measured), so tickets are serialized.',
  ],
  [
    "say / note / steer are MCP tools",
    "an in-process server named `live` (createSdkMcpServer, alwaysLoad so the first call skips a ~4 s ToolSearch detour). Each call becomes req.say / req.note / req.steer on the current ticket — i.e. an append over the relay. app_call / app_list reach the page's tools the same way.",
  ],
  [
    "speech",
    "only through `say`; the agent's own text blocks go to the task log (never spoken). If a turn ends without a `say`, the `result` text is spoken instead.",
  ],
  [
    "cancel",
    "the ticket's abort signal → query.interrupt(): the turn ends with result/error_during_execution and the query survives for the next ticket.",
  ],
  [
    "done",
    "the `result` message: subtype success → task done (cost and turns logged); error_* → task failed (spoken as the failure line).",
  ],
  [
    "auth",
    "the CLI's own login (system/init reports apiKeySource). No key is passed; the child env is scrubbed of CLAUDECODE, CLAUDE_PID and CLAUDE_CODE_* so a nested launch does not inherit a parent session's identity.",
  ],
] as const;

const DELEGATION_MESSAGE = `<delegation id="item_9f3c…">
Recent conversation (transcribed speech, may contain errors):
user: Why does the trace look jagged when the samples are low
assistant: Okay, hang on.
Request (delegation item_9f3c…): Why does the trace look jagged when the samples are low

App tools available through app_call:
set_live_freq — Set freq (0.1–5 Hz). Returns the value applied.
set_live_samples — Set samples (8–1024 points). Returns the value applied.
report — Current app state.
</delegation>`;

const TOOL_BUILTINS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "Agent",
  "Skill",
];
const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "Bash", "WebFetch"];
const LIVE_TOOLS = [
  "mcp__live__say",
  "mcp__live__note",
  "mcp__live__steer",
  "mcp__live__app_list",
  "mcp__live__app_call",
];

const GROUPS: Array<{ id: SdkGroup; label: string }> = [
  { id: "model", label: "model and thinking" },
  { id: "prompt", label: "prompt" },
  { id: "tools", label: "tools, skills, plugins" },
  { id: "permissions", label: "permissions" },
  { id: "mcp", label: "MCP" },
  { id: "session", label: "sessions and persistence" },
  { id: "hooks", label: "hooks" },
  { id: "output", label: "output stream" },
  { id: "process", label: "the child process" },
  { id: "other", label: "other" },
];

function quote(value: string): string {
  return /[\s"'{}]/.test(value) ? JSON.stringify(value) : value;
}

export function ClaudeSection() {
  const [model, setModel] = createSignal("");
  const [effort, setEffort] = createSignal("");
  const [mode, setMode] = createSignal("bypassPermissions");
  const [tools, setTools] = createSignal<string[]>(DEFAULT_TOOLS);
  const [maxTurns, setMaxTurns] = createSignal(60);
  const [isolate, setIsolate] = createSignal(true);
  const [cwd, setCwd] = createSignal("/path/to/your/app");
  const [append, setAppend] = createSignal("");
  const [execPath, setExecPath] = createSignal("");
  const [partial, setPartial] = createSignal(false);

  /** The delegator call as an integrator writes it. */
  const delegatorCall = createMemo(() => {
    const lines: string[] = [];
    lines.push(`  cwd: ${JSON.stringify(cwd())},`);
    if (model() !== "") lines.push(`  model: ${JSON.stringify(model())},`);
    if (effort() !== "") lines.push(`  effort: ${JSON.stringify(effort())},`);
    if (mode() !== "bypassPermissions") lines.push(`  permissionMode: ${JSON.stringify(mode())},`);
    if (tools().join() !== DEFAULT_TOOLS.join())
      lines.push(`  allowedTools: ${JSON.stringify(tools())},`);
    if (maxTurns() !== 60) lines.push(`  maxTurns: ${maxTurns()},`);
    if (!isolate()) lines.push("  isolate: false,");
    if (append() !== "") lines.push(`  systemPrompt: ${JSON.stringify(append())},`);
    if (execPath() !== "")
      lines.push(`  pathToClaudeCodeExecutable: ${JSON.stringify(execPath())},`);
    return `import { claudeDelegator } from "@habemus-papadum/aiui-live/claude";\n\nconst backend = claudeDelegator({\n${lines.join("\n")}\n});\n\n// or, in vite.config.ts:  live({ claude: { …the same options… } })`;
  });

  /** The options object the delegator builds for query(). */
  const queryOptions = createMemo(() => {
    const options: Record<string, unknown> = {
      cwd: cwd(),
      model: model() === "" ? undefined : model(),
      effort: effort() === "" ? undefined : effort(),
      permissionMode: mode(),
      allowDangerouslySkipPermissions: mode() === "bypassPermissions" ? true : undefined,
      allowedTools: [...tools(), ...LIVE_TOOLS],
      mcpServers: { live: "<the in-process server: say, note, steer, app_list, app_call>" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: append() === "" ? "<CLAUDE_LIVE_BRIEF>" : `<CLAUDE_LIVE_BRIEF>\\n\\n${append()}`,
      },
      settingSources: isolate() ? [] : undefined,
      strictMcpConfig: isolate(),
      maxTurns: maxTurns(),
      env: "<process.env minus CLAUDECODE / CLAUDE_PID / CLAUDE_CODE_*>",
      pathToClaudeCodeExecutable: execPath() === "" ? undefined : execPath(),
      includePartialMessages: partial(),
    };
    return options;
  });

  /** The argv the SDK spawns, from the catalog's flag table — one flag per line. */
  const argv = createMemo(() => {
    const lines: string[] = [execPath() === "" ? "<bundled claude binary>" : quote(execPath())];
    lines.push(
      `${FIXED_ARGV[0]} ${FIXED_ARGV[1]}`,
      FIXED_ARGV[2] ?? "",
      `${FIXED_ARGV[3]} ${FIXED_ARGV[4]}`,
    );
    if (model() !== "") lines.push(`--model ${quote(model())}`);
    if (effort() !== "") lines.push(`--effort ${effort()}`);
    lines.push(`--permission-mode ${mode()}`);
    if (mode() === "bypassPermissions") lines.push("--allow-dangerously-skip-permissions");
    lines.push(`--allowedTools ${[...tools(), ...LIVE_TOOLS].join(",")}`);
    lines.push(`--max-turns ${maxTurns()}`);
    if (isolate()) lines.push("--setting-sources=", "--strict-mcp-config");
    if (partial()) lines.push("--include-partial-messages");
    return lines.filter((line) => line !== "");
  });

  const [filter, setFilter] = createSignal("");
  const [onlySet, setOnlySet] = createSignal(false);
  const visible = createMemo(() => {
    const needle = filter().trim().toLowerCase();
    return SDK_OPTIONS.filter(
      (option) =>
        (!onlySet() || SET_BY_DELEGATOR.has(option.key)) &&
        (needle === "" ||
          option.key.toLowerCase().includes(needle) ||
          option.doc.toLowerCase().includes(needle) ||
          (option.flag ?? "").toLowerCase().includes(needle)),
    );
  });

  return (
    <div class="tour-claude">
      <p class="tour-lead">
        The Agent SDK (<code>@anthropic-ai/claude-agent-sdk</code> {SDK_VERSION}) is a{" "}
        <b>typed client for the CLI's JSON mode</b>. <code>query()</code> spawns a{" "}
        <code>claude</code> process with <code>{FIXED_ARGV.join(" ")}</code>, writes your user
        messages to its stdin as newline-delimited JSON, and yields the same records{" "}
        <code>claude -p --output-format stream-json</code> prints: <code>system/init</code>,{" "}
        <code>assistant</code>, <code>user</code> (tool results), <code>result</code>. On the same
        stream ride <code>control_request</code> / <code>control_response</code> records:
        initialize, interrupt, permission prompts, hook callbacks, and <code>mcp_message</code>,
        which is how a tool you define in your process is called by the model — the CLI sees an
        "sdk" MCP server and every JSON-RPC call to it is tunnelled back over stdio. The bundled
        binary is version-matched to the SDK; <code>pathToClaudeCodeExecutable</code> points it at
        an installed one instead.
      </p>

      <div class="tour-cols">
        <div>
          <h3 class="tour-h3">the process picture</h3>
          <pre class="tour-code">{`browser page ──WS /live/delegate──▶ dev server (vite plugin)
                                     │
                                     ▼
                              claudeDelegator()          one per relay socket
                                     │ query({ prompt: <AsyncIterable of user messages>, options })
                                     ▼
                              @anthropic-ai/claude-agent-sdk
                                     │ spawn(<bundled claude>, [${FIXED_ARGV.join(" ")}, …])
                                     │ stdin: {"type":"user",…}            ▲ stdout: {"type":"assistant",…}
                                     │        {"type":"control_response",…}│         {"type":"result",…}
                                     │                                     │         {"type":"control_request",
                                     ▼                                     │           "request":{"subtype":"mcp_message",…}}
                              claude (CLI 2.1.x, the CLI's own login) ─────┘
                                     │ tools: Read Grep Glob Bash WebFetch
                                     │ + mcp__live__say / note / steer / app_list / app_call
                                     ▼
                              say → relay frame → page → session.commentary.append → voice`}</pre>
          <h3 class="tour-h3">how the delegator uses it</h3>
          <table class="tour-table">
            <tbody>
              <For each={DELEGATOR_RUNTIME}>
                {([what, how]) => (
                  <tr>
                    <td>
                      <b>{what}</b>
                    </td>
                    <td>{how}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <div>
          <h3 class="tour-h3">what a ticket looks like to the agent</h3>
          <pre class="tour-code">{DELEGATION_MESSAGE}</pre>
          <p class="tour-note">
            Before that, the system prompt is the <code>claude_code</code> preset with{" "}
            <code>CLAUDE_LIVE_BRIEF</code> appended: speak only through <code>say</code>, one or two
            plain sentences, a progress line first if it will take more than ten seconds,{" "}
            <code>note</code> for quiet facts, <code>steer</code> rarely, <code>app_call</code> for
            the app's state (read before you change), the working directory for questions about how
            the app behaves.
          </p>
          <h3 class="tour-h3">what comes back, and what the delegator does with it</h3>
          <table class="tour-table">
            <tbody>
              <For
                each={SDK_MESSAGE_TYPES.filter(
                  (m) =>
                    ["assistant", "result", "system", "stream_event", "user"].includes(m.type) &&
                    (m.subtype === undefined ||
                      m.subtype === "init" ||
                      m.subtype.startsWith("success") ||
                      m.subtype.startsWith("error")),
                )}
              >
                {(message) => (
                  <tr>
                    <td>
                      <code>
                        {message.type}
                        {message.subtype === undefined ? "" : `/${message.subtype.split(" ")[0]}`}
                      </code>
                    </td>
                    <td>{message.doc.split(". ")[0]}.</td>
                    <td class="muted">
                      {message.type === "system"
                        ? "logs model + CLI version + cwd"
                        : message.type === "assistant"
                          ? "text and tool_use blocks → the task log"
                          : message.type === "result"
                            ? message.subtype?.startsWith("success")
                              ? "task done; result spoken if nothing was said"
                              : "task failed (or cancelled, if we interrupted)"
                            : message.type === "stream_event"
                              ? "ignored (includePartialMessages is off)"
                              : "ignored (tool results are the agent's business)"}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>

      <h3 class="tour-h3">the options builder — what the delegator exposes today</h3>
      <div class="tour-builder">
        <div class="tour-form">
          <label>
            cwd — the agent's working directory (the app's source tree)
            <input type="text" value={cwd()} onInput={(e) => setCwd(e.currentTarget.value)} />
          </label>
          <label>
            model (blank = the CLI's default; e.g. claude-sonnet-5, claude-opus-5, claude-fable-5-1)
            <input type="text" value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
          </label>
          <label>
            effort
            <select value={effort()} onChange={(e) => setEffort(e.currentTarget.value)}>
              <option value="">(default: high)</option>
              <For each={EFFORT_VALUES}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <label>
            permissionMode
            <select value={mode()} onChange={(e) => setMode(e.currentTarget.value)}>
              <For each={PERMISSION_MODES}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
          <div class="tour-checks">
            allowedTools (the built-ins; the five live tools are always added)
            <For each={TOOL_BUILTINS}>
              {(name) => (
                <label class="tour-check">
                  <input
                    type="checkbox"
                    checked={tools().includes(name)}
                    onChange={(e) =>
                      setTools((previous) =>
                        e.currentTarget.checked
                          ? [...previous, name]
                          : previous.filter((candidate) => candidate !== name),
                      )
                    }
                  />
                  {name}
                </label>
              )}
            </For>
          </div>
          <label>
            maxTurns
            <input
              type="number"
              min="1"
              value={maxTurns()}
              onInput={(e) => setMaxTurns(Number(e.currentTarget.value))}
            />
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={isolate()}
              onChange={(e) => setIsolate(e.currentTarget.checked)}
            />
            isolate — settingSources: [] + strictMcpConfig (no user settings, no other MCP servers)
          </label>
          <label>
            systemPrompt — appended after the live brief
            <textarea rows={2} value={append()} onInput={(e) => setAppend(e.currentTarget.value)} />
          </label>
          <label>
            pathToClaudeCodeExecutable (blank = the SDK's bundled binary)
            <input
              type="text"
              value={execPath()}
              onInput={(e) => setExecPath(e.currentTarget.value)}
            />
          </label>
          <label class="tour-check">
            <input
              type="checkbox"
              checked={partial()}
              onChange={(e) => setPartial(e.currentTarget.checked)}
            />
            includePartialMessages (not exposed by the delegator; shown to see the flag)
          </label>
        </div>
        <div class="tour-out">
          <h4>what you write</h4>
          <pre class="tour-json">{delegatorCall()}</pre>
          <h4>what query() receives</h4>
          <pre class="tour-json">
            {JSON.stringify(queryOptions(), (_, v) => (v === undefined ? undefined : v), 1)}
          </pre>
          <h4>what gets spawned (from the SDK's flag table)</h4>
          <pre class="tour-json">{argv().join(" \\\n  ")}</pre>
          <p class="tour-note">
            Not on the command line: the system prompt, the in-process MCP server and any hooks
            travel in the <code>initialize</code> control request over stdin; <code>cwd</code> and{" "}
            <code>env</code> are spawn options. Two flags the SDK pushes on its own even when you
            set nothing: <code>--permission-mode default</code> and a{" "}
            <code>--debug-file &lt;path&gt;</code> when its debug-log setting yields one. It also
            sets <For each={SPAWN_ENV.slice(0, 2)}>{(entry) => <code>{entry.key} </code>}</For>
            on the child.
          </p>
        </div>
      </div>

      <h3 class="tour-h3">exposing more — how complicated?</h3>
      <div class="tour-cols">
        <div>
          <p>
            <b>Per query (frozen once the long-lived query starts):</b> everything in the builder
            above plus any other <code>Options</code> key. Three touch points to expose one:
          </p>
          <ol class="tour-list">
            <li>
              the page: a knob whose value rides the relay's <code>hello</code> frame (today:{" "}
              <code>{'{ type: "hello", delegator, sessionId }'}</code> — add a <code>config</code>{" "}
              object).
            </li>
            <li>
              the relay: <code>DelegatorFactory</code> receives it in its context and hands it to{" "}
              <code>claudeDelegator(…)</code>.
            </li>
            <li>
              the delegator: pass it through to <code>query()</code> — most keys are a one-line
              pass-through, as <code>model</code> and <code>effort</code> are now.
            </li>
          </ol>
          <p class="tour-note">
            Because the query is created lazily on the first ticket, a config that arrives with{" "}
            <code>hello</code> is in time; changing it later means <code>dispose()</code> and a
            fresh query — which also drops the agent's context unless you resume (next chapter).
          </p>
        </div>
        <div>
          <p>
            <b>At runtime (no restart):</b> the <code>Query</code> object has setters the delegator
            does not use yet. A <code>configure</code> relay frame could call them mid-session:
          </p>
          <table class="tour-table">
            <tbody>
              <For
                each={QUERY_METHODS.filter((m) =>
                  [
                    "setModel",
                    "setPermissionMode",
                    "applyFlagSettings",
                    "setMcpServers",
                    "interrupt",
                    "getContextUsage",
                    "accountInfo",
                    "supportedModels",
                  ].includes(m.name),
                )}
              >
                {(method) => (
                  <tr>
                    <td>
                      <code>{method.name}</code>
                    </td>
                    <td>{method.doc.split(". ")[0]}.</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <p class="tour-note">
            Effort has no setter; it is a query option (or <code>applyFlagSettings</code>'s{" "}
            <code>effortLevel</code>, per the type). The full method list is below.
          </p>
        </div>
      </div>

      <h3 class="tour-h3">
        every option the SDK accepts ({SDK_OPTIONS.length}), grouped — with the flag it becomes
      </h3>
      <div class="tour-chips">
        <input
          type="search"
          class="tour-filter"
          placeholder="filter by name, doc or flag"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <label class="tour-check">
          <input
            type="checkbox"
            checked={onlySet()}
            onChange={(e) => setOnlySet(e.currentTarget.checked)}
          />
          only the {SET_BY_DELEGATOR.size} the delegator sets
        </label>
        <span class="muted">
          {visible().length} shown · highlighted rows are set by the delegator
        </span>
      </div>
      <div class="tour-table-scroll">
        <For each={GROUPS}>
          {(group) => (
            <Show when={visible().some((option) => option.group === group.id)}>
              <table class="tour-table">
                <thead>
                  <tr>
                    <th>{group.label}</th>
                    <th>type</th>
                    <th>doc</th>
                    <th>becomes</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={visible().filter((option) => option.group === group.id)}>
                    {(option) => (
                      <tr data-set={String(SET_BY_DELEGATOR.has(option.key))}>
                        <td>
                          <code>{option.key}</code>
                        </td>
                        <td class="muted">{option.type}</td>
                        <td>{option.doc}</td>
                        <td class="muted">{option.flag ?? "(in-process)"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          )}
        </For>
      </div>

      <details class="bench-fold">
        <summary>the Query object's methods ({QUERY_METHODS.length})</summary>
        <table class="tour-table">
          <tbody>
            <For each={QUERY_METHODS}>
              {(method) => (
                <tr>
                  <td>
                    <code>{method.signature}</code>
                  </td>
                  <td>{method.doc}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </details>
      <details class="bench-fold">
        <summary>the control channel ({CONTROL_REQUESTS.length} request subtypes)</summary>
        <table class="tour-table">
          <tbody>
            <For each={CONTROL_REQUESTS}>
              {(request) => (
                <tr>
                  <td>
                    <code>{request.subtype}</code>
                  </td>
                  <td>{request.doc}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </details>
      <details class="bench-fold">
        <summary>every message type on the stream ({SDK_MESSAGE_TYPES.length})</summary>
        <table class="tour-table">
          <tbody>
            <For each={SDK_MESSAGE_TYPES}>
              {(message) => (
                <tr>
                  <td>
                    <code>
                      {message.type}
                      {message.subtype === undefined ? "" : `/${message.subtype}`}
                    </code>
                  </td>
                  <td>{message.doc}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </details>
      <details class="bench-fold">
        <summary>environment the SDK sets on the child ({SPAWN_ENV.length})</summary>
        <table class="tour-table">
          <tbody>
            <For each={SPAWN_ENV}>
              {(entry) => (
                <tr>
                  <td>
                    <code>{entry.key}</code>
                  </td>
                  <td>{entry.value}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </details>
      <p class="tour-note">
        Sources: <a href={LINKS.sdkTypescript}>the TypeScript reference</a>,{" "}
        <a href={LINKS.sdkCustomTools}>custom tools</a>,{" "}
        <a href={LINKS.sdkPermissions}>permissions</a>; the tables above come from the installed
        package's own <code>sdk.d.ts</code> and bundle.
      </p>
    </div>
  );
}

const SESSION_OPTIONS = SDK_OPTIONS.filter((option) => option.group === "session");

const PERSIST_SKETCH = `// 1. remember the id: it arrives on the first system/init message
case "system":
  if (message.subtype === "init") {
    sessionId = message.session_id;      // save it per app (a file, the channel's cache, a DB)
  }

// 2. next server start: pick the conversation up where it left off
query({ prompt: input, options: { ...options, resume: savedId } });

// 3. a "what if" without polluting the main thread
query({ prompt: input, options: { ...options, resume: savedId, forkSession: true } });

// 4. rewind to a point, then branch — the uuid of any assistant message
query({ prompt: input, options: { ...options, resume: savedId, resumeSessionAt: uuid, forkSession: true } });

// 5. your own storage: mirror every transcript entry as it is written (dual-write)
query({ prompt: input, options: { ...options, sessionStore: myStore /* SessionStore, @alpha */ } });

// 6. or read the JSONL after the fact — what cc-assay does
import { listSessions, getSessionMessages, forkSession } from "@anthropic-ai/claude-agent-sdk";
const sessions = await listSessions({ dir: cwd });
const messages = await getSessionMessages(sessionId, { dir: cwd });
const branch = await forkSession(sessionId, { dir: cwd, upToMessageId: uuid, title: "voice: samples question" });`;

export function SessionsSection() {
  return (
    <div class="tour-sessions">
      <p class="tour-lead">
        Every query is a Claude Code <b>session</b>: the CLI writes its transcript as JSONL under{" "}
        <code>~/.claude/projects/&lt;cwd-slug&gt;/&lt;session_id&gt;.jsonl</code> (subagents beside
        it), exactly as an interactive session does, and the id arrives on the first{" "}
        <code>system/init</code> message. The delegator does not persist it yet — each dev-server
        relay socket starts a fresh session — but everything needed is in the SDK: resume, fork,
        truncate-then-fork, a mirror store for your own storage, and read/list/fork helpers over the
        files on disk.
      </p>
      <div class="tour-cols">
        <div>
          <h3 class="tour-h3">the session options</h3>
          <table class="tour-table">
            <tbody>
              <For each={SESSION_OPTIONS}>
                {(option) => (
                  <tr>
                    <td>
                      <code>{option.key}</code>
                    </td>
                    <td>{option.doc}</td>
                    <td class="muted">{option.flag ?? "(in-process)"}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <div>
          <h3 class="tour-h3">the helpers over the transcripts</h3>
          <table class="tour-table">
            <tbody>
              <For each={SESSION_FUNCTIONS}>
                {(fn) => (
                  <tr>
                    <td>
                      <code>{fn.name}</code>
                    </td>
                    <td>{fn.doc}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
      <h3 class="tour-h3">what it would take in the delegator</h3>
      <pre class="tour-code">{PERSIST_SKETCH}</pre>
      <div class="tour-callout">
        <b>Where this lands for the oracle.</b> A per-app session id (keyed by the app's{" "}
        <code>cwd</code>) makes the voice backend <em>remember</em>: "what did we change last time"
        is answerable, and the code it read stays read. Forking is what a "try something" ticket
        wants — branch from the main thread, answer, and let the branch go. And because the
        transcripts are ordinary JSONL where the interactive CLI keeps its own, the same mining that
        reads your Claude Code usage reads the oracle's sessions too. The delegator needs about
        fifteen lines for the first two; the store adapter is an alpha API worth waiting on.
      </div>
      <p class="tour-note">
        Sources: <a href={LINKS.sdkSessions}>sessions</a> and{" "}
        <a href={LINKS.sdkTypescript}>the TypeScript reference</a>.
      </p>
    </div>
  );
}
