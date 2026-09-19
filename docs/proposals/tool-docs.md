# Tool docs: the tool surface as a document

Per-tool usage text and a per-kit brief that travel with the registration, one renderer
per consumer, a library-grade DuckDB query tool, and an on-page record of who called what.

Status: **DECIDED 2026-09-19; milestones 1–4 SHIPPED the same day** (`tool docs I`–`IV`
on main), **milestone 5 (live verification) PENDING** — it needs the session browser and
a person at the mic. The owner asked for a synthesis of five requests (tool instructions in
system prompts, a generic DuckDB query tool, result truncation and error return, an on-page
tool-call debugger, tool pass-through for the live oracle) and deferred every open decision
to "simplest, least churn". Every claim about existing code cites the file as it was before
the work. Milestones are in [§7](#7-milestones); non-goals in [§8](#8-non-goals).

## 0. In one screen

The five requests are one gap seen from five sides: **the tool surface is a schema, not a
document.** A tool crosses every wire as `{ name, description, inputSchema }` and nothing
else; the compiler lifts one JSDoc paragraph into `description` and discards every `@tag`;
no consumer carries per-tool usage text; no kit carries a brief; the only place tools are
rendered as prose is the Agent SDK delegator's `name — description` list. The DuckDB query
tool is one demo's hand-rolled `registerTool` with a hand-typed column list. Nothing on the
page records who called which tool.

The unifying feature is a **tool document**: `usage` per tool, `brief` per kit, a derived
`kind` (read or write), all riding the registration frame structured, plus **one pure
renderer** that each consumer calls with its own budget. This is the intent pipeline's own
rule applied to tools: structured travels; rendering is the consumer's decision.

The hypothesis the owner asked to have challenged ("state in the system prompt how each tool
is meant to be used, not just the definitions") holds, with two corrections, [§2](#2-the-hypothesis-checked).

## 1. What exists (verified 2026-09-19)

| Piece | Where | The fact the design leans on |
| --- | --- | --- |
| `AgentTool { name, description, params?, inputSchema?, run }` | `packages/aiui-viz/src/agent-tools.ts:37-49` | `params` is dropped and undescribed tools are filtered at the registry boundary (`agent-tools.ts:92-99`). |
| Wire shape `{ name, description, inputSchema? }` in three copies | `aiui-viz/src/aiui-global.ts:19`, `aiui-intent-client/src/page-tools.ts:29`, `aiui-claude-channel/src/page-tools.ts:44` | Unknown keys are dropped by the channel's mapping (`page-tools.ts:364-371`). |
| Registry `register(ns, tools)` / `list()` / `call(ns, name, args)` / `ledger()` / `onChange` | `aiui-global.ts:26-54` | `ledger()` is an inventory, not a call log. `call` has no caller argument. |
| Auto-created tools: one per `action()`, `set-<dim>` per `selectionDim`, four view verbs, `clear-selection`, plus `report`/`set`/`locate` | `standard-tools.ts:173-189, 214-307`, `mosaic-selection.ts:427-518`, `selection-views.tsx:191-238` | Controls and cells have no tool of their own; they ride `set` and `report`. |
| Compiler: `descriptionFromComments` takes the last comment, strips the gutter, **cuts at the first `@` line** | `packages/aiui-source-processor/src/source-locator.ts:202-234` | The discarded tag section is already computed. `FactorySpec.inject` is `"name" \| "loc" \| "description"` (`:85`). `scope()` is not a factory. |
| Oracle: `toolSchemas()` sends four fields; `weaveInstructions` has four slots and no tool text | `aiui-oracle/src/session.ts:581-589`, `prompt.ts:28-59` | The "persona stays GENERIC about which tools exist" rule (`prompt.ts:6-9`) is a defense against hand-written prompts drifting from the tool array. |
| Panel oracle gets descriptors over the page transport, not the channel | `aiui-intent-client/src/page-tools.ts:13-17`, `lanes/oracle.ts:133, 409-450` | The panel's `applyTools` is the one place to gather a brief. |
| Channel: `page_tools_list` returns bare JSON; the prompt context never mentions page tools | `aiui-claude-channel/src/tools.ts:121, 214-236`, `prompt-context.ts:110-152` | Claude learns page tools exist only from `skills/session-browser`. |
| Live: `DelegationRequest.tools: LiveTool[]`; Responses mode sends `backendToolFor`; the SDK delegator inlines `name — description` per tool and exposes `app_list`/`app_call` | `aiui-live/src/types.ts:21-48, 265-292`, `claude/index.ts:161-177, 338-344` | The voice model's `backendTools` list is hand-typed (`prompt.ts:31`, `demos/live/src/live/prompt.ts`). `demos/live` projects the local control surface, so a `registerTool` tool never reaches a delegator. |
| DuckDB: the library exports `instantiateDuckDB` + `fetchWithProgress` only; Mosaic coupling is structural | `aiui-viz/src/duckdb.ts`, `mosaic.tsx:55-58` | The app owns the DB and the coordinator. seismos holds a **second connection** for its own reads (`demos/seismos/src/store.ts:457-459, 506`). |
| seismos `query` tool: SELECT/WITH guard, single statement, wrapping `LIMIT` capped at 5000, BigInt/Date sanitizing | `demos/seismos/src/graph.ts:150-167`, `store.ts:576-586` | The column list in its description is hand-typed prose. No schema tool exists anywhere. |
| Errors already reach every consumer | `tools.ts:256` (MCP error result), `aiui-oracle/src/session.ts:1102-1115` (`{ error }` as the function output) | A thrown DuckDB error is enough; its message carries the position and candidate names. |
| `AsyncDuckDBConnection.cancelSent()` | `@duckdb/duckdb-wasm` `async_connection.d.ts:26` | Timeouts can cancel a wasm query. |

## 2. The hypothesis, checked

Vendor text (fetched 2026-09-19, the `.md` pages):

- OpenAI's Realtime prompting guide (`guides/voice-prompting`) prescribes a `# Tools`
  section with rules by **tool class**: call read-only tools when intent is clear, summarize
  and confirm before write tools, after a failure explain briefly and do not repeat the same
  call. It also warns, under "Keep tool availability synchronized", that a prompt naming a
  tool absent from the list makes the model invent or pretend.
- The GPT-Live guide (`guides/live-prompting`) gives the voice model a coarse capability
  list (`Backend tools:` then `- [capability]: [what the backend can do]`) and says "put the
  full task procedure in the backend instructions".
- Anthropic's guidance puts the most weight on the description itself.

So: **yes, with two corrections.**

1. **Two kinds of text, two homes.** Per-tool "what, when, and what the result means" travels
   with the tool (`description` plus `usage`) and reaches every consumer. Cross-tool
   workflow and the app's mental model live in a **kit brief** rendered into the prompt.
2. **Not for Claude Code per prompt.** We do not own its system prompt, and every channel
   push is a billed user turn (the channel-wakeups finding). There, the brief is delivered
   at discovery time inside `page_tools_list`, never in the lowered prompt.

And the oracle's sync rule stays, restated: *the prompt may name a tool only when the text is
derived from the same projection in the same call.* Derived text cannot drift; hand-written
tool prose in `app` or `extra` remains forbidden.

**Derive before you author.** Most instructions are structural: read versus write eagerness,
bounds and units, the table list, "counts refresh after a task boundary". They come from a
`kind` bit and metadata the surface already has. `@usage` prose is for the app-specific rest.

## 3. Decisions (all four deferred to "least churn")

| # | Question | Decision | Why it is the least churn |
| --- | --- | --- | --- |
| 1 | `usage` as a separate field or folded into `description` at the wire? | **Separate optional field**, additive on every existing shape. Never folded at the wire. | Descriptions keep their meaning for every consumer; the voice path can budget usage separately; old channels ignore an unknown key. Consumers whose tool array has only a description slot (Realtime, Responses) get usage through the prompt section instead. |
| 2 | Default SQL result format | **Columnar** `{ columns, types?, rows: unknown[][], truncated }`; `format: "markdown"` opt-in. | Arrays halve the tokens of row objects; Arrow gives types for free; markdown is what a voice model summarizes best. |
| 3 | A caller argument on `registry.call`? | **Yes, optional trailing `meta`**: `call(ns, name, args?, meta?: { caller: string; ref?: string })`. | Additive; every existing call site compiles; transports fill it in one line each. |
| 4 | A shared tool type across packages? | **No new module.** The same optional keys are added in place to `AgentTool`, `AiuiPageTool`, both `PageToolDescriptor`s, `OracleTool`, `LiveTool`/`LiveToolSpec`; one wire-shape test on each end pins the key set. | Five one-line additions beat a new dependency edge (the channel is node-side and does not depend on aiui-viz). |

Further decisions that follow the same rule:

- **Kit brief** is `agentToolkit(ns, { brief })` (a second, optional argument; re-calling on
  HMR updates it), stored by the registry as `register(ns, tools, { brief })`, returned by
  `list()` and shown by `ledger()`. Purely authored; derived facts (the table list) go into
  the relevant tool's `usage` instead, so nothing mutates the brief.
- **`kind?: "read" | "write"`** on `AgentTool`. Defaults: actions and `set`/`set-<dim>`/
  `save-view`/`load-view`/`delete-view`/`clear-*` are `write`; `report`, `locate`,
  `list-views`, `sql`, `schema` are `read`. A `registerTool` tool without `kind` is rendered
  in neither class list. An `ActionSpec` may set `kind: "read"` for a pure action.
- **Compiler** lifts `@usage` (contiguous lines up to the next tag) into `usage`, and
  appends an `@example` block as `Example: …`. `FactorySpec.inject` gains `"usage"`; explicit
  still wins; the directive filter is unchanged.
- **`params` stays as it is.** Not forwarded, not retired. Out of scope.

## 4. The document and its renderer

```ts
// aiui-viz/src/agent-tools.ts — additive
export interface AgentTool {
  name: string;
  description: string;
  /** When to call it, what the result means, one example. Lifted from `@usage`/`@example`. */
  usage?: string;
  /** Eagerness class for renderers; see §3. */
  kind?: "read" | "write";
  params?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  run: (args?: Record<string, unknown>) => unknown;
}

export function agentToolkit(ns: string, options?: { brief?: string }): AgentToolkit;
```

```ts
// aiui-viz/src/tool-brief.ts (new, on the core barrel) — pure, deterministic
export interface KitDoc { ns: string; brief?: string; tools: ToolDoc[] }
export interface ToolDoc { name: string; description: string; usage?: string; kind?: "read" | "write" }
export function renderToolBrief(kits: KitDoc[], options?: { maxChars?: number }): string;
```

The rendered text, fixed headings, one shape for every consumer:

```
Tools:
<kit brief, verbatim>
Read tools (call when the intent is clear; no confirmation needed):
- report: <description> <usage>
- sql: <description> <usage>
Write tools (they change the app; the result is the value actually applied):
- set-mag: <description> <usage>
Other tools:
- suggest-mc: <description>
If a tool fails, say what failed in a few words and do not repeat the same call.
```

`maxChars` drops usage lines (longest first), never names or descriptions.
`ledger()` gains `usage`/`kind` columns when present; the brief rides `list()`. Nothing else
about either changes.

## 5. Consumers

### 5.1 Oracle (`aiui-oracle`)

- `OracleTool` gains `usage?`, `kind?`; `toolsFromControlSurface` and `toolsFromAiuiRegistry`
  copy them. New `briefFromAiuiRegistry({ namespaces })` joins the briefs of the given
  namespaces (the projection already filters to active ones).
- `setTools(tools, options?: { brief?: string })` stores the brief, then calls
  `refreshPrompt()`, which already sends only when the text moved.
- `composeInstructions` appends `renderToolBrief` of the **current tool array** after the
  woven slots. The base persona keeps "only use tools that are currently available". The
  rule in `prompt.ts:6-9` is restated as in §2.
- Panel: `applyTools` in `lanes/oracle.ts` gathers `brief` from the tab's namespaces (the
  `pageTools` event grows `brief?` per namespace; the emitters are `cdp/page-script.ts` and
  `ext/content.ts`, which read `window.__AIUI__.tools.list()`).
- `OracleViewer` already shows the woven prompt; the new section appears there for free.

### 5.2 Channel and intent tool (`aiui-claude-channel`, `aiui-intent-client`)

- `tools-link.ts` sends `usage` per tool and `brief` per namespace in the `register` frame;
  the channel's mapping keeps both; `PageToolRegistration` and `PageToolTabEntry.namespaces[]`
  carry `brief?`. `page_tools_list` output therefore shows the brief above each namespace's
  tools. The registration hash includes the new keys, so a changed brief is a new hash.
- `promptContextSections` adds one static sentence when `aiui && hasTab`: *"This app may
  expose page tools: call page_tools_list for this tab and read the brief before driving
  it."* No per-tool text in the lowered prompt, ever.
- `skills/session-browser/SKILL.md` gains one line: read the brief first.
- The console's `/__aiui/tools` pane shows `brief` and `usage` (they arrive in
  `GET /debug/api/page-tools` with no route change).

### 5.3 Live (`aiui-live`)

- `LiveTool`/`LiveToolSpec` gain `usage?`, `kind?`; `toolSpec` copies them.
  `DelegationRequest` gains `brief?: string`; `LiveSession.setTools(tools, { brief? })`.
  The relay's `delegate` frame gains `brief?`.
- SDK delegator: the inlined list at `claude/index.ts:338-344` becomes
  `renderToolBrief([{ ns: "app", brief, tools }])`; `app_list` returns `usage`/`kind` too.
- Responses delegator: `instructions = backendPrompt({ app }) + "\n\n" + renderToolBrief(…)`.
  Hosted mode: the same appended to `delegation.responses.instructions` at session start.
- `livePrompt`: when `slots.backendTools` is undefined and a brief exists, derive
  `- App: <first sentence of the brief>` plus the standing analysis line. The bench's
  hand-copied list goes away.
- `demos/live` projects the page registry (`toolsFromAiuiRegistry` + `briefFromAiuiRegistry`,
  both from aiui-oracle, already the demo's dependency) instead of the control surface.
- The `claude-channel` leaf needs nothing: by design (live-delegation §1) the interactive
  Claude drives the app through `page_tools_*`, which 5.2 covers.

## 6. The two new library features

### 6.1 DuckDB tools (`@habemus-papadum/aiui-viz/duckdb`)

```ts
export interface SqlResult { columns: string[]; types?: string[]; rows: unknown[][] }
export interface SqlRunner {
  query(sql: string, options?: { signal?: AbortSignal }): Promise<SqlResult>;
  /** Best-effort cancel of the in-flight statement (wasm: `cancelSent()`). */
  cancel?(): Promise<void>;
}
export function duckdbRunner(connection: AsyncDuckDBConnection): SqlRunner;   // Arrow → columnar, with types
export function connectorRunner(connector: { query(req: { type: "json"; sql: string }): Promise<unknown> }): SqlRunner; // Mosaic Connector (the Quack path); no types

export interface SqlToolsOptions {
  runner: SqlRunner | Promise<SqlRunner>;
  scope?: Scope;
  /** Skip introspection; state the tables. */
  tables?: string[];
  rowCap?: number;      // default 200, hard max 5000
  byteCap?: number;     // default 32 KB (the panel's read_file precedent)
  timeoutMs?: number;   // default 10 s
}
export function registerSqlTools(kit: AgentToolkit, options: SqlToolsOptions): void;
export function runSql(runner: SqlRunner, sql: string, options: RunSqlOptions): Promise<SqlToolResult>; // unit-testable core
```

Two tools:

- `sql { sql, limit?, format?: "table" | "markdown" }`. Guards, promoted from seismos:
  `SELECT`/`WITH` only, no `;` inside, wrapped as `SELECT * FROM (<q>) AS _q LIMIT cap+1` so
  truncation is detected rather than guessed. Serialization stops at `byteCap`; long strings
  clip at 256 chars with a marker; BigInt to number (string when unsafe), Date to ISO,
  binary to `<n bytes>`, nested values to JSON. Result:
  `{ columns, types?, rows, truncated: { rows: boolean, bytes: boolean, rowCap, byteCap } }`
  or the markdown table with the same footer line. Errors are thrown with DuckDB's message
  untouched.
- `schema { table?, summarize?: boolean }`: tables and columns from `information_schema`;
  `SUMMARIZE` only on request (expensive over a remote runner).

`usage` for `sql` is composed at registration: the table list (introspected once the runner
resolves, then re-registered, which is replace-by-name and HMR-safe; or `tables` verbatim),
the caps, "aggregate in SQL rather than fetching rows", "the error carries the position; fix
and retry". The wasm adapter is used on a **dedicated connection**, seismos' pattern, so
agent reads never contend with Mosaic's.

Migration: seismos deletes `runQuery` and its hand-written tool and calls
`registerSqlTools(kit, { runner: duckdbRunner(queryCon), scope: seismosScope })`; wine adds
the same line. Mosaic remains optional throughout: the library still owns no connection.

### 6.2 The on-page tool-call log

- Registry: `call(ns, name, args?, meta?)` records
  `{ seq, t, ns, tool, args, caller, ref?, ok, result | error, ms }` into a ring of 200, with
  `result` clipped to 4 KB. New `calls()` and `onCall(handler)`. `ledger()` unchanged in
  meaning.
- Callers, one line each: `tools-link.ts` passes `{ caller: "channel" }`; the page script and
  content script, answering the panel's call, pass `{ caller: "oracle" }`; `toolsFromAiuiRegistry`'s
  `execute` passes `{ caller: "oracle" }`; the live relay's `tool` frame handler passes
  `{ caller: "live:<delegator>", ref: delegationId }`; `window.__<ns>.call` passes
  `{ caller: "page" }`. Missing meta records `caller: "unknown"`.
- Component: `ToolLog` on a new subpath `@habemus-papadum/aiui-viz/site/tool-log`
  (its own subpath like `./site/lens`, so pages that never open it pay nothing). Hidden by
  default; opens on `location.hash === "#aiui-tools"` or `toggleToolLog()`. Three views:
  **calls** (the ring, live), **inventory** (`ledger()`), **as rendered** (the
  `renderToolBrief` text and the `page_tools_list`-shaped JSON), so a developer sees exactly
  what each consumer sees. Styling is the consumer's (`.aiui-toollog-*`), the CellView seam.

## 7. Milestones

Each is one commit, shippable alone, tests included, docs touched in the same commit.

1. **Tool docs on the surface** (F1). `usage`/`kind`/`brief` on `AgentTool`, the registry,
   `ledger()`; `renderToolBrief`; `kind` defaults in `standard-tools.ts`, `mosaic-selection.ts`,
   `selection-views.tsx`; compiler `@usage`/`@example`; the wire copies (intent-client
   descriptor and namespace, page script and content script emitters, `tools-link` frame;
   channel registration and `PageToolTabEntry`); `OracleTool` and `LiveTool` keys.
   Tests: `source-locator.test.ts` (two cases: usage lifted, example appended),
   `aiui-global.test.ts` (brief stored, key set pinned), `standard-tools.test.ts` (kinds),
   `tool-brief.test.ts` (golden string), channel `page-tools.test.ts` (usage and brief
   survive), intent-client `page-tools` test. Docs: `frontend-user-guide.md` gains
   "Documenting a tool" (the JSDoc convention with `@usage`).
2. **The call log** (F4). Registry `meta`/`calls`/`onCall`; callers set in the five places;
   `ToolLog` and its subpath; `publishConfig` in step. Tests: `aiui-global.test.ts` (records,
   ring cap, clipping, meta), a dom test for the component. Docs: `attribution.md` gains the
   log; the `cellFactories` doc bug there is fixed in passing.
3. **Renderers** (F2 and F5). Oracle: `setTools(tools, { brief })`, the `Tools:` section in
   `composeInstructions`, `briefFromAiuiRegistry`, the panel's `applyTools`, the rule
   restated. Channel: the prompt-context sentence and the skill line. Live: the three
   delegator paths, derived `backendTools`, the demo's registry projection.
   Tests: oracle `prompt.test.ts` (golden), `session.test.ts` (a `setTools` with the same
   text sends no update), live `prompt.test.ts`, the Claude delegator's message test,
   channel `prompt-context.test.ts`. Docs: `oracle.md` "Shaping the prompt".
4. **DuckDB tools** (F3). The module, `runSql` tests with a fake runner (guards, both caps,
   truncation flags, sanitizing, markdown, schema, timeout cancel), seismos migrated, wine
   added. Docs: `duckdb-mosaic.md` gains "The agent's SQL tools".
5. **Live verification and the skills.** In the session browser: seismos through the oracle
   lab (does the model call `schema` before `sql`?), the intent panel (`page_tools_list`
   shows the brief; the log attributes the call to `channel`), `demos/live` (the delegation
   message carries the brief; a `sql` tool reaches the SDK delegator). Record the measured
   prompt sizes per consumer in this document. `aiui-architecture` skill: one paragraph on
   documenting tools.

Order rationale: 1 unblocks everything; 2 is the instrument for judging 3; 3 is where the
hypothesis pays (voice first, vendor guidance is explicit there); 4 is self-contained and the
best test case for the docs (a tool that needs a table list and a retry rule); 5 closes.

## 8. Non-goals

- No shared `ToolDoc` package or module across package boundaries (decision 4).
- No per-tool text in lowered prompts or channel pushes; no page-tools push of any kind
  (the channel-wakeups rule stands).
- No write access in the SQL tool (`INSERT`, `CREATE`, temp views) until a use appears.
- No connection owned by the library; no Mosaic dependency added to aiui-viz.
- No `claude-channel` live leaf; that is live-delegation milestone 4.
- No change to `params`; no compiler recognition of `scope()`.

## 9. Open questions

- Realtime prompt cost with the section in place: measure the instruction token count on
  seismos (about 20 tools) in milestone 5 and set `maxChars` from the measurement.
- Whether the voice model calls `schema` unprompted or needs the table list in `usage`
  (both are provided; milestone 5 says which one carries the weight).
- The live relay executes page tools in the browser; the caller tag for the hosted Responses
  path (vendor-run backend) is `live:responses` set by the session's function-call handler.
  Verify that path attributes correctly.
