// Fact catalog extracted from the installed @anthropic-ai/claude-agent-sdk.
// Every string here is copied or condensed from sdk.d.ts / sdk.mjs / package.json
// of that package (see sdk-catalog.notes.md for provenance). Nothing is invented.

export const SDK_VERSION = "0.3.272";

export type SdkGroup =
  | "model"
  | "prompt"
  | "tools"
  | "permissions"
  | "mcp"
  | "session"
  | "hooks"
  | "process"
  | "output"
  | "other";

export interface SdkOption {
  key: string;
  type: string;
  doc: string;
  /** CLI flag(s) sdk.mjs emits for this option; "(control channel: …)" when it rides the initialize request instead; omitted when handled in-process. */
  flag?: string;
  group: SdkGroup;
}

/** One entry per key of the exported `Options` type in sdk.d.ts, in declaration order. */
export const SDK_OPTIONS: SdkOption[] = [
  {
    key: "abortController",
    type: "AbortController",
    doc: "Controller for cancelling the query. When aborted, the query will stop and clean up resources.",
    group: "process",
  },
  {
    key: "additionalDirectories",
    type: "string[]",
    doc: "Additional directories Claude can access beyond the current working directory. Paths should be absolute.",
    flag: "--add-dir <path> (one per directory)",
    group: "permissions",
  },
  {
    key: "agent",
    type: "string",
    doc: "Agent name for the main thread. When specified, the agent's system prompt, tool restrictions, and model will be applied to the main conversation. The agent must be defined either in the `agents` option or in settings; equivalent to the `--agent` CLI flag.",
    flag: "--agent <name>",
    group: "prompt",
  },
  {
    key: "agents",
    type: "Record<string, AgentDefinition>",
    doc: "Programmatically define custom subagents that can be invoked via the Agent tool. Keys are agent names, values are agent definitions.",
    flag: "(control channel: initialize.agents)",
    group: "tools",
  },
  {
    key: "allowedTools",
    type: "string[]",
    doc: "List of tool names that are auto-allowed without prompting for permission. To restrict which tools are available, use the `tools` option instead. Passing 'Skill' here is deprecated — use the `skills` option instead.",
    flag: "--allowedTools <comma-list>",
    group: "permissions",
  },
  {
    key: "canUseTool",
    type: "CanUseTool",
    doc: "Custom permission handler for controlling tool usage. Called before each tool execution to determine if it should be allowed, denied, or prompt the user.",
    flag: "--permission-prompt-tool stdio (then can_use_tool control requests)",
    group: "permissions",
  },
  {
    key: "continue",
    type: "boolean",
    doc: "Continue the most recent conversation in the current directory instead of starting a new one. Mutually exclusive with `resume`.",
    flag: "--continue",
    group: "session",
  },
  {
    key: "cwd",
    type: "string",
    doc: "Current working directory for the session. Defaults to `process.cwd()`. (Passed as the spawn cwd, not a flag.)",
    group: "process",
  },
  {
    key: "disallowedTools",
    type: "string[]",
    doc: "List of tool names that are disallowed. These tools will be removed from the model's context and cannot be used, even if they would otherwise be allowed.",
    flag: "--disallowedTools <comma-list>",
    group: "tools",
  },
  {
    key: "toolAliases",
    type: "Record<string, string>",
    doc: "Map of tool-name aliases applied before name resolution. When the model emits a `tool_use` whose name is a key in this map, the tool execution path resolves the mapped name instead. The redirect is single-hop; complementary to `disallowedTools`, not a replacement for it.",
    flag: "(control channel: initialize.toolAliases)",
    group: "tools",
  },
  {
    key: "tools",
    type: "string[] | { type: 'preset'; preset: 'claude_code' }",
    doc: "Specify the base set of available built-in tools: an array of specific tool names, `[]` to disable all built-in tools, or the 'claude_code' preset to use all default Claude Code tools. Native builds may provide search via Bash find/grep instead of the dedicated Grep/Glob tools; list Grep/Glob here or in `allowedTools` to get them.",
    flag: '--tools <comma-list> | --tools "" (empty array) | --tools default (preset)',
    group: "tools",
  },
  {
    key: "env",
    type: "{ [envVar: string]: string | undefined }",
    doc: "Environment variables for the Claude Code process. When set, this value REPLACES the subprocess environment entirely — it is not merged with `process.env`; when omitted, the subprocess inherits `process.env`. Set `CLAUDE_AGENT_SDK_CLIENT_APP` to identify your app in the User-Agent header.",
    group: "process",
  },
  {
    key: "executable",
    type: "'bun' | 'deno' | 'node'",
    doc: "JavaScript runtime to use for executing Claude Code. Auto-detected if not specified. (Only used as the command when `pathToClaudeCodeExecutable` is a .js/.mjs/.ts/.tsx/.jsx script; a native binary is run directly.)",
    group: "process",
  },
  {
    key: "executableArgs",
    type: "string[]",
    doc: "Additional arguments to pass to the JavaScript runtime executable. (Prepended to the argv ahead of the SDK's own flags.)",
    group: "process",
  },
  {
    key: "extraArgs",
    type: "Record<string, string | null>",
    doc: "Additional CLI arguments to pass to Claude Code. Keys are argument names (without --), values are argument values. Use `null` for boolean flags.",
    flag: "--<key> (null) | --<key> <value> (written as --<key>=<value> when the value starts with '-')",
    group: "process",
  },
  {
    key: "fallbackModel",
    type: "string",
    doc: "Fallback model(s) to use if the primary model is overloaded or unavailable. Accepts a comma-separated list to try each in order. The primary model is re-tried at the start of each user turn.",
    flag: "--fallback-model <model>",
    group: "model",
  },
  {
    key: "enableFileCheckpointing",
    type: "boolean",
    doc: "Enable file checkpointing to track file changes during the session. When enabled, files can be rewound to their state at any user message using `Query.rewindFiles()`.",
    flag: "(env: CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true)",
    group: "session",
  },
  {
    key: "toolConfig",
    type: "ToolConfig ({ askUserQuestion?: { previewFormat?: 'markdown' | 'html' } })",
    doc: "Per-tool configuration for built-in tools.",
    flag: "(env: CLAUDE_CODE_QUESTION_PREVIEW_FORMAT, CLAUDE_CODE_QUESTION_EXTENDED, CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS)",
    group: "tools",
  },
  {
    key: "forkSession",
    type: "boolean",
    doc: "When true, resumed sessions will fork to a new session ID rather than continuing the previous session. Use with `resume`.",
    flag: "--fork-session",
    group: "session",
  },
  {
    key: "betas",
    type: "SdkBeta[] (SdkBeta = 'context-1m-2025-08-07')",
    doc: "Enable beta features. Currently supported: 'context-1m-2025-08-07' — Enable 1M token context window (Sonnet 4/4.5 only).",
    flag: "--betas <comma-list>",
    group: "model",
  },
  {
    key: "hooks",
    type: "Partial<Record<HookEvent, HookCallbackMatcher[]>>",
    doc: "Hook callbacks for responding to various events during execution. Hooks can modify behavior, add context, or implement custom logic.",
    flag: "(control channel: initialize.hooks, then hook_callback requests)",
    group: "hooks",
  },
  {
    key: "onElicitation",
    type: "OnElicitation",
    doc: "Callback for handling MCP elicitation requests. Called when an MCP server requests user input (form fields, URL auth, etc.) and no hook handles the request first. If not provided, elicitation requests that aren't handled by hooks will be declined automatically.",
    flag: "(control channel: elicitation requests)",
    group: "mcp",
  },
  {
    key: "onUserDialog",
    type: "OnUserDialog",
    doc: "Callback for handling `request_user_dialog` control requests — blocking dialogs the CLI asks the host to render. Each `dialogKind` defines its own payload and result shape. If the callback is not provided at all, the SDK sends no answer.",
    flag: "(control channel: request_user_dialog requests)",
    group: "other",
  },
  {
    key: "supportedDialogKinds",
    type: "string[]",
    doc: "Dialog kinds this consumer's `onUserDialog` can actually render. Providing `onUserDialog` alone does NOT opt the consumer into receiving dialogs — the CLI only emits a dialog kind declared here. Requires `onUserDialog`; passing a non-empty list without the callback throws at option intake.",
    flag: "(control channel: initialize.supportedDialogKinds)",
    group: "other",
  },
  {
    key: "perTaskStopAffordance",
    type: "boolean",
    doc: "Declares that this consumer renders a per-task stop control wired to the `stop_task` control request. When declared, an interrupt on an open-input session spares running background agents/workflows — Stop only aborts the current turn. Without the declaration, an interrupt kills background tasks.",
    flag: "(control channel: initialize.perTaskStopAffordance)",
    group: "other",
  },
  {
    key: "persistSession",
    type: "boolean",
    doc: "When false, disables session persistence to disk. Sessions will not be saved to ~/.claude/projects/ and cannot be resumed later. Default true.",
    flag: "--no-session-persistence (when false)",
    group: "session",
  },
  {
    key: "sessionStore",
    type: "SessionStore",
    doc: "Mirror session transcripts to an external store. When set, the subprocess still writes to CLAUDE_CONFIG_DIR AND emits entries to this adapter via dual-write. Cannot be used with persistSession: false. @alpha",
    flag: "--session-mirror",
    group: "session",
  },
  {
    key: "sessionStoreFlush",
    type: "SessionStoreFlush ('batched' | 'eager')",
    doc: "Controls how aggressively transcript entries are flushed to `sessionStore`. Defaults to 'batched'. Ignored when `sessionStore` is not set. @alpha",
    group: "session",
  },
  {
    key: "loadTimeoutMs",
    type: "number",
    doc: "Timeout for each `sessionStore.load()` / `sessionStore.listSubkeys()` call during resume materialization. If the adapter doesn't settle within this window the query fails with a clear error instead of hanging the iterator forever. Default 60_000. @alpha",
    group: "session",
  },
  {
    key: "includeHookEvents",
    type: "boolean",
    doc: "Include hook lifecycle events in the output stream. When true, `hook_started`, `hook_progress`, and `hook_response` system messages will be emitted for all hook event types. SessionStart and Setup hook events are always emitted regardless of this setting. Default false.",
    flag: "--include-hook-events",
    group: "output",
  },
  {
    key: "includePartialMessages",
    type: "boolean",
    doc: "Include partial/streaming message events in the output. When true, `SDKPartialAssistantMessage` events will be emitted during streaming.",
    flag: "--include-partial-messages",
    group: "output",
  },
  {
    key: "forwardSubagentText",
    type: "boolean",
    doc: "Forward subagent text and thinking blocks as assistant/user messages with `parent_tool_use_id` set. By default, only tool_use/tool_result blocks from subagents are emitted. When true, the full subagent conversation is forwarded so consumers can render a nested transcript.",
    flag: "(control channel: initialize.forwardSubagentText)",
    group: "output",
  },
  {
    key: "thinking",
    type: "ThinkingConfig ({ type: 'adaptive'; display? } | { type: 'enabled'; budgetTokens?; display? } | { type: 'disabled' })",
    doc: "Controls Claude's thinking/reasoning behavior. 'adaptive' — Claude decides when and how much to think (Opus 4.6+; the default for models that support it); 'enabled' with budgetTokens — fixed thinking token budget (older models); 'disabled' — no extended thinking. When set, takes precedence over the deprecated `maxThinkingTokens`.",
    flag: "--thinking adaptive | --thinking disabled | --max-thinking-tokens <budgetTokens> (enabled with a budget); plus --thinking-display <summarized|omitted>",
    group: "model",
  },
  {
    key: "effort",
    type: "EffortLevel ('low' | 'medium' | 'high' | 'xhigh' | 'max')",
    doc: "Controls how much effort Claude puts into its response. Works with adaptive thinking to guide thinking depth. 'low' — minimal thinking, fastest responses; 'medium' — moderate; 'high' — deep reasoning (default); 'xhigh' — deeper than high (Fable 5, Opus 4.7+, Sonnet 5); 'max' — maximum effort (Fable 5, Opus 4.6+, Sonnet 4.6+).",
    flag: "--effort <level>",
    group: "model",
  },
  {
    key: "maxThinkingTokens",
    type: "number",
    doc: "Maximum number of tokens the model can use for its thinking/reasoning process. @deprecated Use `thinking` instead. On Opus 4.6, this is treated as on/off (0 = disabled, any other value = adaptive).",
    flag: "--max-thinking-tokens <n> (0 becomes --thinking disabled)",
    group: "model",
  },
  {
    key: "maxTurns",
    type: "number",
    doc: "Maximum number of conversation turns before the query stops. A turn consists of a user message and assistant response.",
    flag: "--max-turns <n>",
    group: "other",
  },
  {
    key: "maxBudgetUsd",
    type: "number",
    doc: "Maximum budget in USD for the query. The query will stop if this budget is exceeded, returning an `error_max_budget_usd` result.",
    flag: "--max-budget-usd <n>",
    group: "other",
  },
  {
    key: "taskBudget",
    type: "{ total: number }",
    doc: "API-side task budget in tokens. When set, the model is made aware of its remaining token budget so it can pace tool use and wrap up before the limit. Sent as `output_config.task_budget` with the `task-budgets-2026-03-13` beta header. @alpha",
    flag: "--task-budget <total>",
    group: "other",
  },
  {
    key: "mcpServers",
    type: "Record<string, McpServerConfig> (stdio | sse | http | sdk-with-instance)",
    doc: "MCP (Model Context Protocol) server configurations. Keys are server names, values are server configurations. Process-based servers go to the CLI; `type: 'sdk'` servers with an instance are kept in-process and bridged over the control channel.",
    flag: "--mcp-config <json {mcpServers}> for stdio/sse/http servers; sdk servers ride initialize.sdkMcpServers + mcp_message control requests",
    group: "mcp",
  },
  {
    key: "model",
    type: "string",
    doc: "Claude model to use. Defaults to the CLI default model. Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'.",
    flag: "--model <model>",
    group: "model",
  },
  {
    key: "outputFormat",
    type: "OutputFormat ({ type: 'json_schema'; schema: Record<string, unknown> })",
    doc: "Output format configuration for structured responses. When specified, the agent will return structured data matching the schema.",
    flag: "--json-schema <json>",
    group: "output",
  },
  {
    key: "pathToClaudeCodeExecutable",
    type: "string",
    doc: "Path to the Claude Code executable. Uses the built-in executable if not specified. (Becomes the spawned command, or the script argument when it is a JS/TS file.)",
    group: "process",
  },
  {
    key: "permissionMode",
    type: "PermissionMode",
    doc: "Permission mode for the session. 'default' — prompts for dangerous operations; 'acceptEdits' — auto-accept file edit operations; 'bypassPermissions' — bypass all permission checks (requires `allowDangerouslySkipPermissions`); 'plan' — planning mode, no execution of tools; 'dontAsk' — don't prompt, deny if not pre-approved.",
    flag: "--permission-mode <mode> (sent as 'default' when omitted)",
    group: "permissions",
  },
  {
    key: "planModeInstructions",
    type: "string",
    doc: "Custom workflow instructions for plan mode. When `permissionMode` is 'plan', this string replaces the default code-implementation workflow body in the plan-mode system reminder. The CLI still wraps it with the read-only enforcement preamble and the ExitPlanMode protocol footer.",
    flag: "(control channel: initialize.planModeInstructions)",
    group: "prompt",
  },
  {
    key: "allowDangerouslySkipPermissions",
    type: "boolean",
    doc: "Must be set to `true` when using `permissionMode: 'bypassPermissions'`. This is a safety measure to ensure intentional bypassing of permissions.",
    flag: "--allow-dangerously-skip-permissions",
    group: "permissions",
  },
  {
    key: "permissionPromptToolName",
    type: "string",
    doc: "MCP tool name to use for permission prompts. When set, permission requests will be routed through this MCP tool instead of the default handler. (Cannot be combined with `canUseTool`.)",
    flag: "--permission-prompt-tool <name>",
    group: "permissions",
  },
  {
    key: "permissionPrompts",
    type: "'host' | 'none'",
    doc: "Who answers permission prompts. 'host' (default): this process, through `canUseTool` or `permissionPromptToolName`. 'none': nobody — the permission mode, rules and hooks still decide, and anything that would otherwise prompt is denied immediately; `canUseTool` is never called.",
    flag: "--permission-prompts <host|none>",
    group: "permissions",
  },
  {
    key: "plugins",
    type: "SdkPluginConfig[] ({ type: 'local'; path: string; skipMcpDiscovery?: boolean })",
    doc: "Load plugins for this session. Plugins provide custom commands, agents, skills, and hooks that extend Claude Code's capabilities. Currently only local plugins are supported via the 'local' type.",
    flag: "--plugin-dir <path> or --plugin-dir-no-mcp <path> per plugin (argv delivery); --await-initialize + initialize.plugins (initialize delivery)",
    group: "tools",
  },
  {
    key: "pluginDelivery",
    type: "'argv' | 'initialize'",
    doc: "How `plugins` reach the Claude Code process. 'argv' (default) — one `--plugin-dir <path>` flag per plugin; 'initialize' — the list is sent over stdin in the initialize request and Claude Code is started with `--await-initialize`, so the command line does not depend on the plugin count. Requires Claude Code 2.1.261 or newer.",
    flag: "(selects --plugin-dir per plugin vs --await-initialize)",
    group: "tools",
  },
  {
    key: "promptSuggestions",
    type: "boolean",
    doc: "Enable prompt suggestions. When true, the agent emits a `prompt_suggestion` message after each turn with a predicted next user prompt. At most one per turn; arrives after the `result` message, so consumers must keep iterating the stream after `result` to receive it.",
    flag: "(control channel: initialize.promptSuggestions)",
    group: "output",
  },
  {
    key: "agentProgressSummaries",
    type: "boolean",
    doc: "Enable periodic AI-generated progress summaries for running subagents. When true, the subagent's conversation is forked every ~30s to produce a short present-tense description, emitted on `task_progress` events via the `summary` field. Defaults to false.",
    flag: "(control channel: initialize.agentProgressSummaries)",
    group: "output",
  },
  {
    key: "resume",
    type: "string",
    doc: "Session ID to resume. Loads the conversation history from the specified session.",
    flag: "--resume=<sessionId>",
    group: "session",
  },
  {
    key: "sessionId",
    type: "string",
    doc: "Use a specific session ID for the conversation instead of an auto-generated one. Must be a valid UUID. Cannot be used with `continue` or `resume` unless `forkSession` is also set.",
    flag: "--session-id=<uuid>",
    group: "session",
  },
  {
    key: "resumeSessionAt",
    type: "string",
    doc: "When resuming, only resume messages up to and including the message with this UUID. Use with `resume`. Accepts any chain-entry UUID — typically `SDKAssistantMessage.uuid`.",
    flag: "--resume-session-at=<uuid>",
    group: "session",
  },
  {
    key: "resumeDropsTurn",
    type: "string",
    doc: "With `resumeSessionAt`: declares the prompt UUID of the turn this truncating resume intends to discard. The CLI validates at fork time that every entry past the `resumeSessionAt` point is attributable to that turn, and refuses the resume (an `error_during_execution` result whose message starts with `Resume rejected by --resume-drops-turn:`) otherwise. PRINT/HEADLESS LANE ONLY.",
    flag: "--resume-drops-turn=<uuid>",
    group: "session",
  },
  {
    key: "sandbox",
    type: "SandboxSettings (zod-inferred)",
    doc: "Sandbox settings for command execution isolation. Filesystem and network restrictions are configured via permission rules, not via these sandbox settings. When `enabled: true` is passed, `failIfUnavailable` defaults to `true`.",
    flag: "--settings <json> (merged into the settings JSON as its `sandbox` key; cannot combine with a settings file path)",
    group: "permissions",
  },
  {
    key: "settings",
    type: "string | Settings",
    doc: 'Additional settings to apply. Accepts either a path to a settings JSON file or a settings object. These are loaded into the "flag settings" layer, which has the highest priority among user-controlled settings; equivalent to the `--settings` CLI flag.',
    flag: "--settings <path-or-json>",
    group: "other",
  },
  {
    key: "managedSettings",
    type: "Settings",
    doc: "Policy-tier settings supplied by the spawning parent process. When an IT-controlled managed-settings tier exists on the user's machine, these are dropped by default; the value is filtered restrictive-only. Intended for embedding applications that derive lockdown settings from their own enterprise configuration.",
    flag: "--managed-settings <json>",
    group: "other",
  },
  {
    key: "settingSources",
    type: "SettingSource[] ('user' | 'project' | 'local')",
    doc: "Control which filesystem settings to load. When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode); must include 'project' to load CLAUDE.md files.",
    flag: "--setting-sources=<comma-list>",
    group: "other",
  },
  {
    key: "skills",
    type: "string[] | 'all'",
    doc: "Skills to enable for the main session; the single place to turn skills on. Omitted: no SDK auto-configuration (not \"skills off\"); 'all': enable every discovered skill; string[]: enable only the listed skills. This is a context filter, not a sandbox.",
    flag: "--allowedTools Skill ('all') or Skill(<name>) per skill, merged into allowedTools; a listed array also rides initialize.skills",
    group: "tools",
  },
  {
    key: "debug",
    type: "boolean",
    doc: "Enable debug mode for the Claude Code process. When true, enables verbose debug logging (equivalent to `--debug` CLI flag). Debug logs are written to a file (see `debugFile` option) or to stderr.",
    flag: "--debug",
    group: "process",
  },
  {
    key: "debugFile",
    type: "string",
    doc: "Write debug logs to a specific file path. Implicitly enables debug mode. Equivalent to `--debug-file <path>` CLI flag.",
    flag: "--debug-file <path>",
    group: "process",
  },
  {
    key: "stderr",
    type: "(data: string) => void",
    doc: "Callback for stderr output from the Claude Code process. Useful for debugging and logging.",
    group: "process",
  },
  {
    key: "strictMcpConfig",
    type: "boolean",
    doc: "Only use MCP servers passed via the `mcpServers` option (and servers declared by explicitly-passed agent definitions in `agents`), ignoring all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter.",
    flag: "--strict-mcp-config",
    group: "mcp",
  },
  {
    key: "systemPrompt",
    type: "string | string[] | { type: 'custom'; prompt: string | string[]; snapshot? } | { type: 'preset'; preset: 'claude_code'; append?; excludeDynamicSections?; snapshot? }",
    doc: "System prompt configuration: a custom string, an array of blocks (with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marking the static/dynamic split), or the 'claude_code' preset optionally with `append` / `excludeDynamicSections`. `snapshot` — whether the conversation's system prompt is recorded once and reused verbatim on every later request and resume; recommended `snapshot: true`.",
    flag: "(control channel: initialize.systemPrompt / appendSystemPrompt / excludeDynamicSections / systemPromptSnapshot)",
    group: "prompt",
  },
  {
    key: "title",
    type: "string",
    doc: "Custom title for a new session. When provided, the session uses this title instead of auto-generating one from the first user message. When resuming, the resumed session's persisted title takes precedence — use `renameSession()` to retitle an existing session.",
    flag: "(control channel: initialize.title)",
    group: "session",
  },
  {
    key: "spawnClaudeCodeProcess",
    type: "(options: SpawnOptions) => SpawnedProcess",
    doc: "Custom function to spawn the Claude Code process. Use this to run Claude Code in VMs, containers, or remote environments. When provided, this function is called instead of the default local spawn; `signal` is forwarded and aborts only AFTER the SDK's stdin-EOF + ~2 s grace window.",
    group: "process",
  },
];

/** Every method of the exported `Query` interface in sdk.d.ts, in declaration order. */
export const QUERY_METHODS: { name: string; signature: string; doc: string }[] = [
  {
    name: "interrupt",
    signature: "interrupt(): Promise<SDKControlInterruptResponse | undefined>",
    doc: "Interrupt the current query execution. On CLIs advertising the `interrupt_receipt_v1` capability the resolved value is the interrupt receipt — `still_queued` uuids of async user messages that WILL still run unless cancelled first. Older CLIs resolve to `undefined`.",
  },
  {
    name: "setPermissionMode",
    signature: "setPermissionMode(mode: PermissionMode): Promise<void>",
    doc: "Change the permission mode for the current session. Only available in streaming input mode.",
  },
  {
    name: "setMcpPermissionModeOverride",
    signature:
      "setMcpPermissionModeOverride(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }>",
    doc: "Pin (or clear, with mode:null) a per-MCP-server permission-mode override. Tighten-only: the override applies only when the session mode would already auto-allow, so it can never widen privilege. Returns a `warning` when `serverName` does not match any currently known MCP server.",
  },
  {
    name: "setModel",
    signature: "setModel(model?: string): Promise<void>",
    doc: "Change the model used for subsequent responses. Only available in streaming input mode. Pass undefined to use the default.",
  },
  {
    name: "setMaxThinkingTokens",
    signature:
      "setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: 'summarized' | 'omitted' | null): Promise<void>",
    doc: "Set the maximum number of thinking tokens the model is allowed to use. Use `null` to clear any previously set limit. @deprecated Use the `thinking` option in `query()` instead.",
  },
  {
    name: "applyFlagSettings",
    signature:
      "applyFlagSettings(settings: { [K in keyof Settings]?: K extends 'effortLevel' ? EffortLevel | null : Settings[K] | null }): Promise<void>",
    doc: "Merge settings into the flag settings layer — the inline `settings` option of `query()`, applied mid-session. Successive calls shallow-merge top-level keys; pass `null` for a key to clear it from the flag layer. Only available in streaming input mode.",
  },
  {
    name: "updateSettings",
    signature:
      "updateSettings(source: 'localSettings', settings: Record<string, unknown>): Promise<void>",
    doc: "Merge settings into a settings FILE through the CLI's own writer — the same path /config uses — and live-apply them. The handler accepts only an explicit key allowlist (currently just outputStyle) with string values; deletion is not supported.",
  },
  {
    name: "initializationResult",
    signature: "initializationResult(): Promise<SDKControlInitializeResponse>",
    doc: "Get the full initialization result, including supported commands, models, account info, and output style configuration.",
  },
  {
    name: "reinitialize",
    signature: "reinitialize(): Promise<SDKControlInitializeResponse>",
    doc: "Re-send the `initialize` control request to an already-running CLI. Use this after a transport gap: the CLI's response carries any `can_use_tool` / `request_user_dialog` control requests the loop is still blocked on, and the SDK redelivers them. Unlike `initializationResult`, this always sends a fresh request.",
  },
  {
    name: "supportedCommands",
    signature: "supportedCommands(): Promise<SlashCommand[]>",
    doc: "Get the list of available skills for the current session — an array of available skills with their names and descriptions.",
  },
  {
    name: "supportedModels",
    signature: "supportedModels(): Promise<ModelInfo[]>",
    doc: "Get the list of available models, including display names and descriptions.",
  },
  {
    name: "supportedAgents",
    signature: "supportedAgents(): Promise<AgentInfo[]>",
    doc: "Get the list of available subagents for the current session, with their names, descriptions, and configuration.",
  },
  {
    name: "mcpServerStatus",
    signature: "mcpServerStatus(): Promise<McpServerStatus[]>",
    doc: "Get the current status of all configured MCP servers (connected, failed, needs-auth, pending).",
  },
  {
    name: "getContextUsage",
    signature:
      "getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>",
    doc: "Get a breakdown of current context window usage by category (system prompt, tools, messages, MCP tools, memory files, etc.). `detail: 'full'` counts each category with the token-count API; 'summary' answers from the last response's usage and local estimates. Defaults to 'full'.",
  },
  {
    name: "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
    signature:
      "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>",
    doc: "Get the structured data behind the `/usage` command: session cost and token usage totals plus claude.ai plan rate-limit utilization windows when available. EXPERIMENTAL: this API is unstable and may change or be removed in any release without notice.",
  },
  {
    name: "readFile",
    signature:
      "readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<SDKControlReadFileResponse | null>",
    doc: "Read a file from the session's filesystem for the remote sidebar viewer. Path is resolved against cwd and gated by the same read-permission rules as the Read tool. Returns null on permission denial, missing file, or transport error.",
  },
  {
    name: "reloadPlugins",
    signature:
      "reloadPlugins(options?: { holdOnCacheImpact?: boolean }): Promise<SDKControlReloadPluginsResponse>",
    doc: "Reload plugins from disk and return the refreshed commands, agents, plugins, and MCP server status. With `holdOnCacheImpact`, nothing is applied when applying would change the session's tool list while the prompt cache depends on it; the response carries `held: true`.",
  },
  {
    name: "reloadSkills",
    signature: "reloadSkills(): Promise<SDKControlReloadSkillsResponse>",
    doc: "Reload skills from disk and return the refreshed skill list.",
  },
  {
    name: "reloadOutputStyles",
    signature: "reloadOutputStyles(): Promise<SDKControlReloadOutputStylesResponse>",
    doc: "Re-read the output-style directories from disk and return the refreshed style names. Also drops the shared markdown-file scan cache, so agents, skills and routines re-read their directories on their next use.",
  },
  {
    name: "accountInfo",
    signature: "accountInfo(): Promise<AccountInfo>",
    doc: "Get information about the authenticated account, including email, organization, and subscription type.",
  },
  {
    name: "rewindFiles",
    signature:
      "rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>",
    doc: "Rewind tracked files to their state at a specific user message. Requires file checkpointing to be enabled via the `enableFileCheckpointing` option. `dryRun` previews changes without modifying files.",
  },
  {
    name: "seedReadState",
    signature: "seedReadState(path: string, mtime: number): Promise<void>",
    doc: "Seed the CLI's readFileState cache with a path+mtime entry. Use when the client observed a Read that has since been removed from context, so a subsequent Edit won't fail \"file not read yet\". If the file changed on disk since the given mtime, the seed is skipped.",
  },
  {
    name: "reconnectMcpServer",
    signature: "reconnectMcpServer(serverName: string): Promise<void>",
    doc: "Reconnect an MCP server by name. Throws on failure.",
  },
  {
    name: "toggleMcpServer",
    signature: "toggleMcpServer(serverName: string, enabled: boolean): Promise<void>",
    doc: "Enable or disable an MCP server by name. Throws on failure.",
  },
  {
    name: "setMcpServers",
    signature:
      "setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>",
    doc: "Dynamically set the MCP servers for this session; replaces the current set of dynamically-added MCP servers with the provided set. Supports both process-based servers and SDK servers (in-process). Servers configured via settings files are not affected, and plugin-introduced servers are exempt.",
  },
  {
    name: "streamInput",
    signature: "streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>",
    doc: "Stream input messages to the query. Used internally for multi-turn conversations.",
  },
  {
    name: "stopTask",
    signature: "stopTask(taskId: string): Promise<void>",
    doc: "Stop a running task. A task_notification with status 'stopped' will be emitted.",
  },
  {
    name: "backgroundTasks",
    signature: "backgroundTasks(toolUseId?: string): Promise<boolean>",
    doc: "Background in-flight foreground tasks (Bash commands and subagents). With `toolUseId`, targets the single task started by that tool_use block; without it, backgrounds all foreground tasks — equivalent to pressing Ctrl+B in the terminal. Throws when background tasks are disabled for the session.",
  },
  {
    name: "close",
    signature: "close(): void",
    doc: "Close the query and terminate the underlying process. This forcefully ends the query, cleaning up all resources including pending requests, MCP transports, and the CLI subprocess. After calling close(), no further messages will be received.",
  },
];

/** Every exported top-level function in sdk.d.ts that concerns sessions or transcripts. */
export const SESSION_FUNCTIONS: { name: string; signature: string; doc: string }[] = [
  {
    name: "listSessions",
    signature:
      "listSessions(options?: { dir?; limit?; offset?; includeWorktrees?; includeProgrammatic?; sessionStore? }): Promise<SDKSessionInfo[]>",
    doc: "List sessions with metadata. When `dir` is provided, returns sessions for that project directory and its git worktrees; when omitted, returns sessions across all projects. Use `limit` and `offset` for pagination.",
  },
  {
    name: "getSessionInfo",
    signature:
      "getSessionInfo(sessionId: string, options?: { dir?; sessionStore? }): Promise<SDKSessionInfo | undefined>",
    doc: "Reads metadata for a single session by ID. Unlike `listSessions`, this only reads the single session file rather than every session in the project. Returns undefined if the session file is not found, is a sidechain session, or has no extractable summary.",
  },
  {
    name: "getSessionMessages",
    signature:
      "getSessionMessages(sessionId: string, options?: { dir?; limit?; offset?; includeSystemMessages?; sessionStore? }): Promise<SessionMessage[]>",
    doc: "Reads a session's conversation messages from its JSONL transcript file. Parses the transcript, builds the conversation chain via parentUuid links, and returns user/assistant messages in chronological order. Set `includeSystemMessages: true` to also include system messages.",
  },
  {
    name: "listSubagents",
    signature:
      "listSubagents(sessionId: string, options?: { dir?; sessionStore? }): Promise<string[]>",
    doc: "Lists subagent IDs for a given session by scanning the subagents directory. Subagent transcripts are stored at `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`.",
  },
  {
    name: "getSubagentMessages",
    signature:
      "getSubagentMessages(sessionId: string, agentId: string, options?: { dir?; limit?; offset?; sessionStore? }): Promise<SessionMessage[]>",
    doc: "Reads a subagent's conversation messages from its JSONL transcript file. Parses the subagent transcript, builds the conversation chain via parentUuid links, and returns user/assistant messages in chronological order.",
  },
  {
    name: "renameSession",
    signature:
      "renameSession(sessionId: string, title: string, options?: { dir?; sessionStore? }): Promise<void>",
    doc: "Rename a session. Appends a custom-title entry to the session's JSONL file.",
  },
  {
    name: "tagSession",
    signature:
      "tagSession(sessionId: string, tag: string | null, options?: { dir?; sessionStore? }): Promise<void>",
    doc: "Tag a session. Pass null to clear the tag.",
  },
  {
    name: "deleteSession",
    signature: "deleteSession(sessionId: string, options?: { dir?; sessionStore? }): Promise<void>",
    doc: "Delete a session. With `sessionStore`: calls `sessionStore.delete()` if implemented; no-op otherwise. Without `sessionStore`: removes `{sessionId}.jsonl` and the `{sessionId}/` subagent-transcript subdirectory from the local projects dir; throws if the session is not found.",
  },
  {
    name: "forkSession",
    signature:
      "forkSession(sessionId: string, options?: { dir?; sessionStore?; upToMessageId?; title? }): Promise<{ sessionId: string }>",
    doc: "Fork a session into a new branch with fresh UUIDs. Copies transcript messages from the source session into a new session file, remapping every message UUID and preserving the parentUuid chain; supports `upToMessageId` for branching from a specific point. Forked sessions start without undo history.",
  },
  {
    name: "importSessionToStore",
    signature:
      "importSessionToStore(sessionId: string, store: SessionStore, options?: { dir?; includeSubagents?; batchSize? }): Promise<void>",
    doc: "Copy a local JSONL session into a SessionStore. Reads the session file (and optionally subagent transcripts) from disk and calls `store.append()` for each, in batches of `batchSize`. Useful for migrating existing local sessions to a remote backend. @alpha",
  },
  {
    name: "foldSessionSummary",
    signature:
      "foldSessionSummary(prev: SessionSummaryEntry | undefined, key: SessionKey, entries: SessionStoreEntry[], options?: { mtime?: number }): SessionSummaryEntry",
    doc: "Fold a batch of appended entries into the running summary for `key`. Stores call this from inside `append()` to keep a SessionSummaryEntry sidecar up to date without re-reading the transcript. @alpha",
  },
];

/**
 * Every member of the exported `SDKMessage` union in sdk.d.ts, in union order.
 * `SDKResultMessage` is itself a union (SDKResultSuccess | SDKResultError) and is listed as two entries.
 */
export const SDK_MESSAGE_TYPES: {
  type: string;
  subtype?: string;
  doc: string;
  fields: string[];
}[] = [
  {
    type: "assistant",
    doc: "An assistant message. While a response streams the CLI emits one assistant message per completed content block, so several consecutive assistant messages can share message.id and each carries just that block; the turn's stop reason and total usage arrive on the result message.",
    fields: [
      "type",
      "message",
      "parent_tool_use_id",
      "error",
      "uuid",
      "session_id",
      "request_id",
      "user_message_uuid",
      "user_message_uuids",
      "resume_reason",
      "resumed_from_incomplete_thinking",
      "supersedes",
      "aborted",
      "subagent_type",
      "task_description",
      "timestamp",
      "context_usage",
    ],
  },
  {
    type: "user",
    doc: "A user-role message. A client writes one to the CLI to submit a prompt (this starts a turn); the CLI emits them for user-role content it adds to the conversation itself, chiefly the tool_result blocks answering the assistant's tool_use blocks.",
    fields: [
      "type",
      "message",
      "parent_tool_use_id",
      "isSynthetic",
      "tool_use_result",
      "priority",
      "origin",
      "shouldQuery",
      "timestamp",
      "uuid",
      "session_id",
      "subagent_type",
      "task_description",
    ],
  },
  {
    type: "user",
    doc: "(SDKUserMessageReplay; no type-level doc) A replayed user message — same shape as SDKUserMessage plus `isReplay: true` and optional `file_attachments`.",
    fields: [
      "type",
      "message",
      "parent_tool_use_id",
      "isSynthetic",
      "tool_use_result",
      "priority",
      "origin",
      "shouldQuery",
      "timestamp",
      "uuid",
      "session_id",
      "isReplay",
      "file_attachments",
    ],
  },
  {
    type: "result",
    subtype: "success",
    doc: "The outcome of a turn (SDKResultSuccess). The CLI emits exactly one result message per turn, after that turn's assistant, user and stream_event messages; treat it as the turn-complete signal. Carries the final assistant text in `result` — or, with is_error true, the error text.",
    fields: [
      "type",
      "subtype",
      "duration_ms",
      "duration_api_ms",
      "ttft_ms",
      "ttft_stream_ms",
      "time_to_request_ms",
      "user_message_uuid",
      "user_message_uuids",
      "resume_reason",
      "local_command",
      "request_sent_wall_ms",
      "first_content_frame_ms",
      "first_stream_post_ms",
      "first_stream_post_ack_ms",
      "first_stream_post_wall_ms",
      "time_to_request_from_spawn_ms",
      "warm_spare_claimed",
      "time_origin_ms",
      "is_error",
      "api_error_status",
      "num_turns",
      "result",
      "stop_reason",
      "total_cost_usd",
      "usage",
      "modelUsage",
      "permission_denials",
      "queued_turn_count",
      "structured_output",
      "deferred_tool_use",
      "terminal_reason",
      "result_index",
      "fast_mode_state",
      "fast_mode_disabled_reason",
      "origin",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "result",
    subtype:
      "error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries",
    doc: "The outcome of a turn that ended in an error (SDKResultError). Same turn-complete role as the success variant; carries `errors: string[]` instead of `result`.",
    fields: [
      "type",
      "subtype",
      "duration_ms",
      "duration_api_ms",
      "is_error",
      "num_turns",
      "stop_reason",
      "total_cost_usd",
      "usage",
      "modelUsage",
      "permission_denials",
      "queued_turn_count",
      "errors",
      "user_message_uuid",
      "user_message_uuids",
      "resume_reason",
      "terminal_reason",
      "result_index",
      "fast_mode_state",
      "fast_mode_disabled_reason",
      "origin",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "init",
    doc: "Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn: session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities list for feature detection.",
    fields: [
      "type",
      "subtype",
      "agents",
      "apiKeySource",
      "betas",
      "claude_code_version",
      "cwd",
      "tools",
      "mcp_servers",
      "model",
      "permissionMode",
      "slash_commands",
      "terminal_slash_commands",
      "output_style",
      "skills",
      "plugins",
      "fast_mode_state",
      "fast_mode_disabled_reason",
      "effort",
      "capabilities",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "stream_event",
    doc: "An incremental streaming event for the assistant message being generated, emitted only when partial messages are requested (--include-partial-messages). The complete assistant message still follows as its own message.",
    fields: [
      "type",
      "event",
      "parent_tool_use_id",
      "uuid",
      "session_id",
      "ttft_ms",
      "user_message_uuid",
      "user_message_uuids",
      "resume_reason",
    ],
  },
  {
    type: "system",
    subtype: "compact_boundary",
    doc: "(no type-level doc) Marks a context compaction; `compact_metadata` carries trigger ('manual' | 'auto'), pre_tokens, post_tokens, duration_ms and the preserved-segment relink info.",
    fields: ["type", "subtype", "compact_metadata", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "status",
    doc: "(no type-level doc) A status change: `status: SDKStatus`, optional permissionMode, and compact_result / compact_error.",
    fields: [
      "type",
      "subtype",
      "status",
      "permissionMode",
      "compact_result",
      "compact_error",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "api_retry",
    doc: "Emitted when an API request fails with a retryable error and will be retried after a delay. error_status is null for connection errors (e.g. timeouts) that had no HTTP response.",
    fields: [
      "type",
      "subtype",
      "attempt",
      "max_retries",
      "retry_delay_ms",
      "error_status",
      "error",
      "no_response",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "control_request_progress",
    doc: "Progress for a long-running client-originated control_request (currently only side_question), correlated by request_id. status 'started' means the worker accepted the request and launched the work; 'api_retry' carries the same retry counters as SDKAPIRetryMessage.",
    fields: [
      "type",
      "subtype",
      "request_id",
      "status",
      "attempt",
      "max_retries",
      "retry_delay_ms",
      "error_status",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "model_refusal_fallback",
    doc: 'Emitted when the primary model ends the stream with stop_reason "refusal" and the turn is retried once on a fallback model (direction: "retry"). When `scope` is "session" the swap is made persistent for the session; when "local", only that subagent/side-question response came from the fallback model.',
    fields: [
      "type",
      "subtype",
      "trigger",
      "direction",
      "scope",
      "original_model",
      "fallback_model",
      "request_id",
      "api_refusal_category",
      "api_refusal_explanation",
      "retracted_message_uuids",
      "refused_user_message_uuid",
      "content",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "model_refusal_no_fallback",
    doc: 'Emitted when the model ends the stream with stop_reason "refusal" and no retry runs: no fallback model is configured, or per-category routing declined the retry. The structured counterpart to detecting stop_reason "refusal" on the assistant message.',
    fields: [
      "type",
      "subtype",
      "original_model",
      "request_id",
      "api_refusal_category",
      "api_refusal_explanation",
      "refused_user_message_uuid",
      "content",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "local_command_output",
    doc: "Output from a local slash command (e.g. /voice, /usage). Displayed as assistant-style text in the transcript.",
    fields: ["type", "subtype", "content", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "hook_started",
    doc: "(no type-level doc) A hook began running; identifies it by hook_id, hook_name and hook_event. Emitted for all hook events only when `includeHookEvents` is true.",
    fields: ["type", "subtype", "hook_id", "hook_name", "hook_event", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "hook_progress",
    doc: "(no type-level doc) Incremental stdout/stderr/output from a running hook.",
    fields: [
      "type",
      "subtype",
      "hook_id",
      "hook_name",
      "hook_event",
      "stdout",
      "stderr",
      "output",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "hook_response",
    doc: "(no type-level doc) A hook finished; carries output, stdout, stderr, optional exit_code and `outcome: 'success' | 'error' | 'cancelled'`.",
    fields: [
      "type",
      "subtype",
      "hook_id",
      "hook_name",
      "hook_event",
      "output",
      "stdout",
      "stderr",
      "exit_code",
      "outcome",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "plugin_install",
    doc: "Headless plugin installation progress (CLAUDE_CODE_SYNC_PLUGIN_INSTALL). started/completed bracket the whole install; installed/failed carry a per-marketplace name.",
    fields: ["type", "subtype", "status", "name", "error", "uuid", "session_id"],
  },
  {
    type: "tool_progress",
    doc: "(no type-level doc) Progress heartbeat for a running tool call: tool_use_id, tool_name, elapsed_time_seconds, optional task_id / heartbeat / subagent_type / subagent_retry.",
    fields: [
      "type",
      "tool_use_id",
      "tool_name",
      "parent_tool_use_id",
      "elapsed_time_seconds",
      "task_id",
      "uuid",
      "session_id",
      "heartbeat",
      "subagent_type",
      "subagent_retry",
    ],
  },
  {
    type: "auth_status",
    doc: "(no type-level doc) Authentication state: `isAuthenticating`, `output: string[]`, optional `error`.",
    fields: ["type", "isAuthenticating", "output", "error", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "task_notification",
    doc: "(no type-level doc) A background task settled: `status: 'completed' | 'failed' | 'stopped'`, its output_file, summary, optional usage and resource_links; `ambient` marks tasks that are not activity.",
    fields: [
      "type",
      "subtype",
      "task_id",
      "tool_use_id",
      "status",
      "output_file",
      "summary",
      "usage",
      "resource_links",
      "skip_transcript",
      "ambient",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "task_started",
    doc: "(no type-level doc) A task was registered: description, optional subagent_type, is_backgrounded (background vs. foreground with the spawning tool call blocking), spawn_depth, task_type, workflow_name, prompt.",
    fields: [
      "type",
      "subtype",
      "task_id",
      "tool_use_id",
      "description",
      "subagent_type",
      "is_backgrounded",
      "spawn_depth",
      "task_type",
      "workflow_name",
      "prompt",
      "skip_transcript",
      "ambient",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "task_updated",
    doc: "(no type-level doc) `patch` is the wire-safe subset of TaskState fields that changed (status, description, end_time, total_paused_ms, error, is_backgrounded); clients merge it into their local task map.",
    fields: ["type", "subtype", "task_id", "patch", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "task_progress",
    doc: "(no type-level doc) Running-task progress: usage (total_tokens, tool_uses, duration_ms), last_tool_name, and `summary` — the model-generated progress summary when `agentProgressSummaries` is on.",
    fields: [
      "type",
      "subtype",
      "task_id",
      "tool_use_id",
      "description",
      "subagent_type",
      "usage",
      "last_tool_name",
      "summary",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "background_tasks_changed",
    doc: "The full set of live background tasks, emitted whenever membership changes or an entry's `ambient` flag flips. A level signal, unlike the task_started/task_notification edge bookends: consumers should replace their set with each payload rather than pairing edges.",
    fields: ["type", "subtype", "tasks", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "thinking_tokens",
    doc: "Live thinking-token estimate, digested from thinking_delta.estimated_tokens during the redacted-thinking phase. estimated_tokens is the running total for the current thinking block; estimated_tokens_delta is the increment carried by this frame. Approximate progress for spinners, not the authoritative billed output_tokens.",
    fields: [
      "type",
      "subtype",
      "estimated_tokens",
      "estimated_tokens_delta",
      "user_message_uuid",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "session_state_changed",
    doc: "Mirrors notifySessionStateChanged. 'idle' fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal.",
    fields: ["type", "subtype", "state", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "worker_shutting_down",
    doc: "Emitted by the bridge on opt-in graceful worker teardown (only when the teardown caller supplied a reason), before the heartbeat stops, so remote clients can show why the worker went away. Absence is NOT a dead-host signal.",
    fields: ["type", "subtype", "reason", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "commands_changed",
    doc: "Fire-and-forget push of the full slash-command list after a mid-session change. Clients should REPLACE their cached command list with this payload; supportedCommands() tracks the latest push.",
    fields: ["type", "subtype", "commands", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "notification",
    doc: "Loop-side text notification. Mirrors the interactive REPL notification queue (key/priority/timeout). JSX notifications are not emitted on this channel.",
    fields: [
      "type",
      "subtype",
      "key",
      "text",
      "priority",
      "color",
      "timeout_ms",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "system",
    subtype: "files_persisted",
    doc: "(no type-level doc) Result of persisting files: `files` ({filename, file_id}[]), `failed` ({filename, error}[]), processed_at.",
    fields: ["type", "subtype", "files", "failed", "processed_at", "uuid", "session_id"],
  },
  {
    type: "tool_use_summary",
    doc: "(no type-level doc) A one-line `summary` covering the `preceding_tool_use_ids`.",
    fields: ["type", "summary", "preceding_tool_use_ids", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "memory_recall",
    doc: 'Emitted when the memory recall supervisor surfaces relevant memories into the turn. Mirrors the CLI relevant_memories attachment so SDK renderers can show "Recalled from memory" inline.',
    fields: ["type", "subtype", "mode", "memories", "uuid", "session_id"],
  },
  {
    type: "rate_limit_event",
    doc: "Rate limit event emitted when rate limit info changes.",
    fields: ["type", "rate_limit_info", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "elicitation_complete",
    doc: "Emitted when an MCP server confirms that a URL-mode elicitation is complete.",
    fields: ["type", "subtype", "mcp_server_name", "elicitation_id", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "permission_denied",
    doc: "Emitted when a tool call is auto-denied without an interactive permission prompt (e.g. auto-mode classifier, dontAsk mode, headless-agent auto-deny, or a deny rule). With a permission prompt surface, the 'ask' path surfaces via a can_use_tool control_request and this event covers the 'deny' short-circuit.",
    fields: [
      "type",
      "subtype",
      "tool_name",
      "tool_use_id",
      "agent_id",
      "decision_reason_type",
      "decision_reason",
      "message",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "prompt_suggestion",
    doc: "Predicted next user prompt, emitted after each turn when promptSuggestions is enabled.",
    fields: ["type", "suggestion", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "mirror_error",
    doc: "Emitted when SessionStore.append() rejects or times out for a transcript-mirror batch after bounded retry (3 attempts with short backoff; timeouts are not retried). The batch is then dropped; this surfaces the failure so consumers are not silent on data loss.",
    fields: ["type", "subtype", "error", "key", "uuid", "session_id"],
  },
  {
    type: "system",
    subtype: "informational",
    doc: "Generic text banner emitted by the loop — non-error status lines, hook feedback (e.g. a UserPromptSubmit hook's block reason), slash-command output. Hosts render `content` as plaintext at the given level.",
    fields: [
      "type",
      "subtype",
      "content",
      "level",
      "tool_use_id",
      "prevent_continuation",
      "uuid",
      "session_id",
    ],
  },
  {
    type: "conversation_reset",
    doc: "Emitted by /clear, plan-mode exit, and fresh-session flows. The surface should mount a fresh transcript under new_conversation_id and reset any cached session title.",
    fields: ["type", "new_conversation_id", "uuid", "session_id"],
  },
];

/** Literal members of the exported `PermissionMode` type. (The `Options.permissionMode` JSDoc lists only the first five; 'auto' is in the type.) */
export const PERMISSION_MODES: string[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

/** Literal members of `EffortLevel`, the type of `Options["effort"]`. */
export const EFFORT_VALUES: string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Environment variables the SDK sets (or removes) on the spawned child process, as found in sdk.mjs.
 * The base is `options.env` when given, else a copy of `process.env`.
 */
export const SPAWN_ENV: { key: string; value: string }[] = [
  { key: "CLAUDE_CODE_ENTRYPOINT", value: '"sdk-ts" (only if not already set)' },
  {
    key: "CLAUDE_AGENT_SDK_VERSION",
    value:
      '"0.3.272" (only if not already set; also assigned on the parent process.env at query() time)',
  },
  {
    key: "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    value: '"true" when options.enableFileCheckpointing is set',
  },
  {
    key: "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    value: "options.toolConfig.askUserQuestion.previewFormat when set",
  },
  {
    key: "CLAUDE_CODE_QUESTION_EXTENDED",
    value:
      '"1" when toolConfig.askUserQuestion.extendedQuestions is set; otherwise removed (case-insensitively) unless options.env was supplied',
  },
  {
    key: "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS",
    value:
      '"1" when toolConfig.askUserQuestion.optionalDescriptions is set; otherwise removed unless options.env was supplied',
  },
  {
    key: "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    value: '"1" when the (impl-only, undocumented) getOAuthToken callback is passed',
  },
  {
    key: "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    value: '"1" when the (impl-only, undocumented) getHostAuthToken callback is passed',
  },
  {
    key: "TRACEPARENT / TRACESTATE",
    value:
      "injected from the active OpenTelemetry context (carrier keys upper-cased) unless present in options.env; stale inherited values are removed first",
  },
  {
    key: "CLAUDE_CONFIG_DIR",
    value:
      "a temporary `claude-resume-<id>` directory, only on a sessionStore-backed resume/continue (transcript materialized from the store)",
  },
  {
    key: "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    value:
      'on win32 alongside the CLAUDE_CONFIG_DIR override above: the existing secure-storage dir, else the prior CLAUDE_CONFIG_DIR, else ""',
  },
  { key: "NODE_OPTIONS", value: "deleted from the child env" },
  { key: "DEBUG", value: '"1" when DEBUG_CLAUDE_AGENT_SDK is truthy; otherwise deleted' },
  {
    key: "NoDefaultCurrentDirectoryInExePath",
    value:
      '"1" — set on the parent process.env at module load, so it is inherited when options.env is omitted',
  },
];

/** CLI flags the SDK always passes, in the order it pushes them (before any option-derived flags). */
export const FIXED_ARGV: string[] = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
];

/**
 * `subtype` literals of control_request messages exchanged with the CLI.
 * The first 38 are the members of `SDKControlRequestInner` in sdk.d.ts (union order); the last three are
 * subtypes the SDK-side dispatcher in sdk.mjs handles but that are absent from sdk.d.ts.
 * Direction: "CLI → SDK" entries are the ones sdk.mjs's processControlRequest dispatches on; the rest are sent by the SDK to the CLI.
 */
export const CONTROL_REQUESTS: { subtype: string; doc: string }[] = [
  { subtype: "interrupt", doc: "SDK → CLI. Interrupts the currently running conversation turn." },
  {
    subtype: "can_use_tool",
    doc: "CLI → SDK. Requests permission to use a tool with the given input (answered via `canUseTool`).",
  },
  {
    subtype: "initialize",
    doc: "SDK → CLI. Initializes the SDK session with hooks, MCP servers, and agent configuration (also carries systemPrompt/appendSystemPrompt, planModeInstructions, systemPromptSnapshot, toolAliases, excludeDynamicSections, agents, title, skills, promptSuggestions, agentProgressSummaries, forwardSubagentText, supportedDialogKinds, perTaskStopAffordance, plugins).",
  },
  {
    subtype: "set_permission_mode",
    doc: "SDK → CLI. Sets the permission mode for tool execution handling.",
  },
  {
    subtype: "set_model",
    doc: "SDK → CLI. Sets the model to use for subsequent conversation turns.",
  },
  {
    subtype: "set_max_thinking_tokens",
    doc: "SDK → CLI. Sets the maximum number of thinking tokens for extended thinking; omitted or null resets thinking to the session default.",
  },
  {
    subtype: "rename_session",
    doc: "SDK → CLI. Sets the user-facing title for the current session.",
  },
  {
    subtype: "set_color",
    doc: 'SDK → CLI. Sets the session accent color. Accepts an agent color name or "default" to reset.',
  },
  {
    subtype: "mcp_status",
    doc: "SDK → CLI. Requests the current status of all MCP server connections.",
  },
  {
    subtype: "get_context_usage",
    doc: "SDK → CLI. Requests a breakdown of current context window usage by category.",
  },
  {
    subtype: "get_session_cost",
    doc: "SDK → CLI. Requests the formatted session cost summary (the same text /usage prints in non-interactive mode).",
  },
  { subtype: "list_models", doc: "SDK → CLI. Requests the worker's selectable model catalog." },
  {
    subtype: "get_usage",
    doc: "SDK → CLI. Requests the structured /usage data: session cost/usage totals plus claude.ai plan rate-limit utilization when available. Experimental.",
  },
  { subtype: "get_binary_version", doc: "SDK → CLI. Requests the responder's CLI binary version." },
  {
    subtype: "mcp_call",
    doc: "SDK → CLI. Invokes an MCP tool via the subprocess MCP client without a model turn. No permission check; SDK-type MCP servers are rejected.",
  },
  {
    subtype: "file_suggestions",
    doc: "SDK → CLI. Requests at-mention file autocomplete suggestions for a partial path prefix.",
  },
  {
    subtype: "hook_callback",
    doc: "CLI → SDK. Delivers a hook callback with its input data (dispatched to the matching `hooks` callback).",
  },
  {
    subtype: "mcp_message",
    doc: "Both directions. Carries one MCP JSON-RPC message for an SDK-hosted MCP server: the CLI sends it to reach the in-process server, and the client sends it to the CLI to deliver that server's reply.",
  },
  {
    subtype: "rewind_files",
    doc: "SDK → CLI. Rewinds file changes made since a specific user message.",
  },
  {
    subtype: "cancel_async_message",
    doc: "SDK → CLI. Drops a pending async user message from the command queue by uuid. No-op if already dequeued for execution.",
  },
  {
    subtype: "read_file",
    doc: "SDK → CLI. Read a file from the session filesystem for the remote sidebar viewer, gated by the same read-permission rules as the Read tool.",
  },
  {
    subtype: "seed_read_state",
    doc: "SDK → CLI. Seeds the readFileState cache with a path+mtime entry.",
  },
  {
    subtype: "mcp_set_servers",
    doc: "SDK → CLI. Replaces the set of dynamically managed MCP servers.",
  },
  {
    subtype: "register_repo_root",
    doc: "SDK → CLI. Add a directory as a working-directory root and optionally reload CLAUDE.md, skills, and plugins. The directory must resolve to a strict subdirectory of cwd or of an --add-dir directory.",
  },
  {
    subtype: "reload_plugins",
    doc: "SDK → CLI. Reloads plugins from disk and returns the refreshed session components.",
  },
  {
    subtype: "reload_skills",
    doc: "SDK → CLI. Reloads skills from disk and returns the refreshed skill list.",
  },
  {
    subtype: "reload_output_styles",
    doc: "SDK → CLI. Re-reads the output-style directories from disk and returns the refreshed style names.",
  },
  { subtype: "mcp_reconnect", doc: "SDK → CLI. Reconnects a disconnected or failed MCP server." },
  { subtype: "mcp_toggle", doc: "SDK → CLI. Enables or disables an MCP server." },
  { subtype: "stop_task", doc: "SDK → CLI. Stops a running task." },
  {
    subtype: "background_tasks",
    doc: "SDK → CLI. Backgrounds in-flight foreground tasks (Bash commands and subagents) — the control-request equivalent of pressing Ctrl+B in the terminal.",
  },
  {
    subtype: "apply_flag_settings",
    doc: "SDK → CLI. Merges the provided settings into the flag settings layer, updating the active configuration.",
  },
  {
    subtype: "get_settings",
    doc: "SDK → CLI. Returns the effective merged settings and the raw per-source settings.",
  },
  {
    subtype: "get_hooks_listing",
    doc: "SDK → CLI. Returns the hooks listing the CLI's read-only /hooks menu renders: settings-file, session, and plugin hooks grouped by event and matcher.",
  },
  {
    subtype: "update_settings",
    doc: "SDK → CLI. Merges the provided settings into a settings file through the CLI's own writer and live-applies them — the same path /config uses.",
  },
  {
    subtype: "elicitation",
    doc: "CLI → SDK. Requests the SDK consumer to handle an MCP elicitation (user input request); answered via `onElicitation`.",
  },
  {
    subtype: "request_user_dialog",
    doc: "CLI → SDK. Requests the SDK consumer to render a tool-driven blocking dialog and return the user choice; answered via `onUserDialog`.",
  },
  {
    subtype: "list_permission_rules",
    doc: "SDK → CLI. Requests the session's live permission rules and workspace directories — the same data /permissions lists in the terminal.",
  },
  {
    subtype: "oauth_token_refresh",
    doc: "CLI → SDK. Handled by sdk.mjs's dispatcher (paired with the undocumented getOAuthToken option); not present in sdk.d.ts.",
  },
  {
    subtype: "host_auth_token_refresh",
    doc: "CLI → SDK. Handled by sdk.mjs's dispatcher (paired with the undocumented getHostAuthToken option); not present in sdk.d.ts.",
  },
  {
    subtype: "remote_control_work_secret",
    doc: "CLI → SDK. Handled by sdk.mjs's dispatcher; not present in sdk.d.ts.",
  },
];
