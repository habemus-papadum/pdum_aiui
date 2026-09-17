# sdk-catalog.ts — provenance notes

Source package: `packages/aiui-live/node_modules/@anthropic-ai/claude-agent-sdk` (version `0.3.272`, bundles Claude Code `2.1.272`). Files read: `sdk.d.ts` (9232 lines), `sdk.mjs` (225 lines, ~1.5 MB minified), `package.json`, `README.md`.

## Counts

| Catalog | Count | Source |
| --- | --- | --- |
| `SDK_OPTIONS` | 67 | every key of `export declare type Options = { … }` at `sdk.d.ts:1410-2294`, declaration order |
| `QUERY_METHODS` | 29 | every method of `export declare interface Query` at `sdk.d.ts:2616-2977` |
| `SESSION_FUNCTIONS` | 11 | exported functions whose doc concerns sessions/transcripts |
| `SDK_MESSAGE_TYPES` | 40 | 39 members of `SDKMessage` (`sdk.d.ts:4956`); `SDKResultMessage` is itself `SDKResultSuccess \| SDKResultError` and is listed as two entries |
| `PERMISSION_MODES` | 6 | `sdk.d.ts:2332` |
| `EFFORT_VALUES` | 5 | `EffortLevel` at `sdk.d.ts:605` |
| `SPAWN_ENV` | 14 | env assignments in `i0()` (query setup) and `mR.initialize()` (ProcessTransport) in `sdk.mjs` |
| `FIXED_ARGV` | 5 | the literal array `W` in `mR.initialize()` |
| `CONTROL_REQUESTS` | 41 | 38 members of `SDKControlRequestInner` (`sdk.d.ts:4630`, a non-exported `declare type`) + 3 subtypes only `sdk.mjs` handles |

## How the argv builder was found

```sh
cd packages/aiui-live/node_modules/@anthropic-ai/claude-agent-sdk
grep -o -n '.\{0,60\}--output-format.\{0,60\}' sdk.mjs      # -> line 121, inside `class mR` (ProcessTransport), method `initialize()`
python3 -c "l=open('sdk.mjs').read().split('\n')[120]; i=l.find('[\"--output-format\"'); print(l[i-4000:i+14000].replace(';',';\n'))"
```

The public `Options` object is translated to transport options in function `i0(e,t)` (the `query()` setup); find it with:

```sh
python3 -c "s=open('sdk.mjs').read(); i=s.find(\"'argv' or 'initialize'.\\\")\"); print(s[i-7000:i+200])"
```

Helper functions referenced in the argv builder: `uR(argv, name, value)` pushes `--name value`, or `--name=value` when the value starts with `-`; `oG(extraArgs, sandbox)` merges `sandbox` into the `settings` JSON (throws if `settings` is a file path); `rG()` returns a default debug-file path.

The `initialize` control-request payload was found with `src.find('subtype:"initialize",hooks:this.initHooksPayload')`; the SDK-side dispatcher with `src.find('async processControlRequest(e,t){')`.

## Ambiguities and caveats

- **`flag` reflects the transport layer.** Several options never touch argv: they ride the `initialize` control request (`systemPrompt`, `agents`, `toolAliases`, `title`, `planModeInstructions`, `promptSuggestions`, `agentProgressSummaries`, `forwardSubagentText`, `supportedDialogKinds`, `perTaskStopAffordance`, `plugins` under `pluginDelivery: 'initialize'`) or env vars (`enableFileCheckpointing`, `toolConfig`). Those say `(control channel: …)` / `(env: …)` in `flag`; purely in-process options (`abortController`, `cwd`, `env`, `executable`, `executableArgs`, `pathToClaudeCodeExecutable`, `stderr`, `spawnClaudeCodeProcess`, `sessionStoreFlush`, `loadTimeoutMs`) omit `flag`.
- **Defaults that are pushed even when the option is omitted** (not in `FIXED_ARGV` because they are option-derived): `--permission-mode default` (the SDK defaults `permissionMode` to `'default'` unless an undocumented `resolvePermissionModeInCli` is set), and `--debug-file <path>` when the SDK's own debug-log setting (`rG()`) yields a path and neither `debugFile` nor `spawnClaudeCodeProcess` is given.
- **`skills` is folded into `--allowedTools`**: `'all'` adds `Skill`; an array adds `Skill(<name>)` per entry (names validated: no `*`, no `:*`/` *` suffix, no leading `/`, no `\\`). The array also rides `initialize.skills`.
- **`mcpServers`**: entries with `type: 'sdk'` and an `instance` are removed from `--mcp-config` and bridged over `initialize.sdkMcpServers` + `mcp_message`; everything else goes in `--mcp-config <json>`.
- **`maxThinkingTokens`** is mapped to the same `thinkingConfig` as `thinking`: `0` → `--thinking disabled`, otherwise `--max-thinking-tokens <n>`.
- **`continue` with `sessionStore`** is NOT passed as `--continue`; the SDK resolves the latest session from the store and materializes it, then passes `--resume=<id>` with `CLAUDE_CONFIG_DIR` pointed at a temp dir.
- **`PermissionMode`** has 6 literals including `'auto'`, but the `Options.permissionMode` JSDoc only lists 5.
- **Options destructured in `sdk.mjs` but absent from the public `Options` type** (checked with `grep -n "^    <name>?:" sdk.d.ts`, no hits): `rapidFollowupPreempt`, `workspaceTrust`, `getOAuthToken`, `getHostAuthToken`, `workload`, `resolvePermissionModeInCli`, `channels`, `appendSubagentSystemPrompt`, `webSearchIsolationExemptMcpServers`. They are not in `SDK_OPTIONS`; the two auth callbacks are mentioned in `SPAWN_ENV` because they set env vars.
- **`SDKMessage` members with no type-level JSDoc** (`SDKUserMessageReplay`, `SDKCompactBoundaryMessage`, `SDKStatusMessage`, the three hook messages, `SDKToolProgressMessage`, `SDKAuthStatusMessage`, the four `task_*` messages, `SDKFilesPersistedEvent`, `SDKToolUseSummaryMessage`) carry a `doc` prefixed `(no type-level doc)` followed by a description condensed from their field names / field-level comments only.
- **`SESSION_FUNCTIONS`** excludes `query`, `startup`, `tool`, `createSdkMcpServer`, `resolveSettings`, `filterEscalatingDefaultMode` (exported functions, but not about sessions/transcripts).
- `sdk-tools.d.ts`, `bridge.d.ts`, `browser-sdk.d.ts` were not catalogued.
