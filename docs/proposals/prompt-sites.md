# Where prompts are built today — the site map for a prompt toolkit

Status: SURVEY, 2026-10-09 (main at `bc104bac`), the input to the migration that
[structured-prompts.md](./structured-prompts.md) plans. It changes nothing; it says where to look.
Line numbers are as of that commit and will drift — the site identifiers (LP1, CH7, …) are the
stable handles.

Every place in this repo that constructs text an AI model reads: system prompts and
instructions, tool descriptions and briefs, capability lists, prompts rendered from captured user
context, delegation messages handed from one agent to another, and the conditional text that
depends on session state (first turn vs continuation, which backend, how many times a tool fired).
About sixty sites in nine packages plus the demos, fourteen construction patterns, and an
observability table that says which of those texts can be seen after the fact today.

## The consumers

| Consumer | How text reaches it | Sites | Observable today |
| --- | --- | --- | --- |
| The Claude Code session | channel notifications, the MCP server instructions, tool declarations and results | LP1–LP12, CH1–CH12, VZ (structured) | the lowered prompt: traced on disk with spans, the trace-ui, the client's `lowered-prompt` echo; everything else: nothing |
| The oracle (OpenAI Realtime) | `session.update` instructions, per-response instructions, tool declarations, injected text and images | OR1–OR12, IC1–IC5, DK1–DK3, VZ1 | the final instructions and the tool I/O in an in-memory ledger; the panel and dock folds; never the slot breakdown, the greeting text or the resolver branch |
| GPT-Live (aiui-live) | the seed config, appends (say/note/steer), the delegation request | LV1–LV8, DL1–DL6, VZ1 | the full config, seed and every append in the live ledger |
| The Responses and Claude Agent SDK delegators | instructions + a per-delegation message | LV9–LV13 | log lines only; the prompts themselves are recorded nowhere |
| The realtime linter (OpenAI Realtime or Gemini Live) | instructions, silent context injections, local-read tools | CH13–CH15 | injections and tool results traced; the persona not |
| The summarizer (gpt-4o-mini) | a system prompt + the rendered prompt re-parsed | CH6 | nothing |
| STT (Scribe, OpenAI) | vendor parameters only — no free-text prompt exists | CH16, LP12 | nothing |

## Sites by package

### aiui-lowering-pipeline — the Claude Code prompt compiler

The one site family whose output carries an offset map back to its parts (spans). Trace stages
land in `~/.cache/aiui/projects/<slug>/traces/`; the trace-ui shows them; `render-audit.mts`
was the documentation harness (broken — see Problems).

- **LP1 `composeIntent`** — `src/compose.ts:49-68`, passes at 102-366. A compiler over the
  append-only `IntentEvent` log, scoped from the last thread-open: StreamFacts → `ComposedItem[]`
  → interleave → render. `streaming` and the correction policy (`replace` / `note`) are
  conditionals. Traced as `composed (speculative)`, `composed intent`, `conditioned`.
- **LP2 interleave** — `src/interleave.ts:56-80`. Emits no text: splits transcript text at word
  or delta offsets so shots and selections land mid-sentence.
- **LP3 `renderPrompt`** — `src/render.ts:37-168`. Per-item render dispatch into a joiner that
  emits offset-annotated `PromptSpan`s; inline runs join with a space, blocks with a blank line.
  Under the `note` policy a correction renders as `(transcription fix: "…" → …)` (145-150).
- **LP4 `renderShot`** — `src/render.ts:442-467`. `[<subject> located at <path><at><note>]`,
  with the pasted-image, `MISSING`, `at +5.0s` (video frame) and full-viewport variants.
- **LP5 `renderShotMetadata`** — `src/render.ts:484-524` (exported). The `screenshot-metadata`
  XML sidecar with element and cell children; caps of 8 elements and 4 cells rendered as
  `*-omitted`; a `count` dedupe. The caller supplies the identity attribute. Reused by IC5.
- **LP6 `renderTabRecord`** — `src/render.ts:199-226` (exported). The `tab` record with a fixed
  attribute order and `escapeXml`. Used by the preamble, the boundary markers, selection
  metadata, and the panel oracle's `context` slot (IC1).
- **LP7 `selectionMetadata`** — `src/render.ts:236-264`. The `selection-metadata` sidecar
  (`source`, `tex`, `cell` and `tab` children); `undefined` when it has nothing to say.
- **LP8 `renderCodeSelection`** — `src/render.ts:286-310`. ``[code selection at <loc>: `…`]``;
  past 240 characters a `(N lines)` header plus a fence, elided past 50 lines.
- **LP9 `renderAppSelection`** — `src/render.ts:382-396`. `[selected text: "…"]` or the long
  form, followed by LP7.
- **LP10 `renderNavigation` / `renderTabSwitch`** — `src/render.ts:357-380`. `[current page
  changed: …]` and `[current tab changed: …]` with a bare page-label fallback. Exported from
  render.ts, not from the package index.
- **LP11 trace-stage vocabulary** — `src/trace-stages.ts:48-233`, the `stageLabel.*` builders:
  today's IR-exposure contract.
- **LP12 STT slots** — `src/config.ts:66-73, 118-123`: `keywords` and `priming`. Nothing in the
  UI writes `keywords`; the `"Keywords: …"` prompt its comment mentions exists nowhere.

### aiui-claude-channel — what the session receives

- **CH1 `promptContextSections`** — `src/prompt-context.ts:116-163`. An ordered `sections[]`
  with conditional pushes: an opening line that branches on `source.root` (the aiui-app signal),
  the `[current tab: …]` record, the `relative to <root>` line, `PAGE_TOOLS_NOTE` when the page is
  an aiui app, and a CDP alignment note with per-state constants and a co-driver pluralisation
  branch (36-93, silent when the state is unknown). Traced as `prompt preamble`.
- **CH2 `finishTurn`** — `src/intent-fin.ts:157-197`. The final string is
  `[...sections, "---", text].join("\n\n")` (186); the static sections are pre-warmed at
  thread-open (`intent-v1.ts:319`); `TRANSCRIPTION_NOTE` is added only when some transcript
  final is not a contribution (165-170) — the code calls this the seam for future
  event-dependent preamble sections. A cancelled or empty turn sends nothing. A preamble span is
  prepended and the body spans shifted. Traced as `lowered prompt spans`; echoed to the client
  as `lowered-prompt`.
- **CH3 speculative compose cache** — `src/intent-turn.ts:212-233`, `src/intent-fin.ts:133-139`:
  reused when `composedSeq === mutationSeq`; traced as `fin compose {reused}`.
- **CH4 text-concat processor** — `src/processors.ts:53-76`: `parts.join("")` wrapped by
  `augmentTextPrompt` (`prompt-context.ts:206`); no transcription note; a `user text` stage only
  when the wrap changed the text.
- **CH5 send tracer** — `src/tracing.ts:59-65`: records the exact text as the `lowered prompt`
  output stage — the canonical "what the agent got".
- **CH6 summarizer** — `src/summarize.ts:43-115`. System prompt "Summarize this request to a
  coding agent in one line, ≤ 12 words, no quotes."; the user message is the rendered prompt
  re-parsed with regexes (strips `screenshot-metadata`, collapses shots to `[screenshot]`, caps at
  1000 chars). Untraced. The one consumer that reverse-engineers rendered text instead of using
  the spans or the IR.
- **CH7 MCP `INSTRUCTIONS`** — `src/server.ts:24-69`, wired at 90. Static string fragments,
  `join(" ")` within a paragraph, `join("\n\n")` between. Teaches LP4–LP10 and CH1 in prose, the
  `tab` attributes and the list_pages workflow. `render-audit.mts` imports it — the only check.
- **CH8 `pushToSession`** — `commands/mcp.ts:91-99`: the `notifications/claude/channel`
  envelope `{content, meta:{kind,…}}`; meta keys become attributes on the channel block. Four
  kinds: `prompt` (traced for intent and text-concat threads only), `startup` ("aiui channel
  connected", 247), `channel-error` (a template literal, 145-150), `channel-stale`
  (`STALE_NOTICE`, `hot.ts:124-127`, on first fire, then a shorter "changed again" literal chosen
  by a `notified` flag — an invocation-count conditional).
- **CH9 raw `POST /prompt`** — `src/web-routes.ts:65-77`: text to the session verbatim and
  untraced. Producers: the `quick` CLI (`commands/quick.ts:57-69`) and the intent-client
  sidecar's CDP-endpoint-moved notice (`aiui-intent-client/src/sidecar.ts:119-131`), which uses
  an `[aiui intent] …` prefix that CH7 never defines, once per change (`warnedUrl`).
- **CH10 MCP tool declarations** — `src/tools.ts:49-101, 146-201`: `+`-concatenated constants;
  `TAB_ARG_PROPERTIES` is shared schema text cross-referencing the `tab` attributes;
  `page_tools_*` and `channel_reload` are declared only when their handles are wired; the
  routing rules and the 15 s timeout are prose here and code in `page-tools.ts:617-721, 216`.
- **CH11 tool results and errors** — `src/tools.ts:120-260`, `src/page-tools.ts:586-721`:
  results are `JSON.stringify(value, null, 2)`; errors are templated from directory state ("no
  connected page matches … — connected: …", "ambiguous tool … Candidates: …"). The page-authored
  `brief` and `usage` reach the session as JSON string values inside `page_tools_list`, never
  rendered as text. Untraced.
- **CH12 `serve` debug mode** — `commands/serve.ts:347-356`: prints `--- lowered prompt ---`
  plus meta to stdout — the only path that shows the session's text together with its meta.
- **CH13 `LINTER_INSTRUCTIONS`** — `src/live-session.ts:36-55`: a string-concat persona that
  documents its own label grammar; overridable per hello (`linterInstructions`, via
  `intent-resolve.ts` → `intent-v1.ts:353` → `linter-sidecar.ts:65, 259, 271`). Vendor setup:
  `openai-live.ts:288-310` (`session.update`), `gemini-live.ts:299-316` (`systemInstruction`).
  The trace records vendor and model, never the text.
- **CH14 silent context injections** — `[transcript seg_N: "…"]` (`linter-sidecar.ts:331`);
  `selectionInjectionLabel` / `selectionRetractionLabel` (`live-resolve.ts:69-97`: conditional
  id, `updated` phase from a per-turn marker registry, `(clipped)` at 160 chars); `[image
  label]` paired with image bytes (`openai-live.ts:355-371`, `gemini-live.ts:359-366`). All
  traced.
- **CH15 local-read tools** — `src/linter-tools.ts`: description constants (44-47, 157-164)
  hand-duplicated into OpenAI and Gemini schema shapes (50-80, 167-208); result text carries
  model-addressed markers (`[…truncated at 32 KB of N KB]`, `[…stopped at 40 matches — narrow…]`,
  "no matches for /re/ … (N files searched)") beside a separate human `summary`. Shared by the
  linter (read_file) and the panel oracle (all three).
- **CH16 STT** — `src/intent-stt.ts:155-166`, `src/elevenlabs-realtime.ts:268-296`: vocabulary
  bias only as Scribe `keyterms` and `language_code` URL params; OpenAI realtime-whisper gets no
  prompt. The aiui-stt twins: `scribe.ts:168-233`, `openai.ts:168-194`. aiui-oracle's
  `InputTranscription.prompt` (`types.ts:186-194`) is declared and never set.
- **CH17 TTS ack** — `src/speak.ts:95-117`: a fixed phrase, no instructions.

### aiui-oracle — the voice oracle

- **OR1 `ORACLE_BASE_PERSONA`** — `src/prompt.ts:17`: fixed prose; the whole quiet-apply
  behaviour ("say only done", speak the divergence). Rule: the persona never names a tool.
- **OR2 `weaveInstructions`** — `src/prompt.ts:33-65`: named slots in a fixed order with
  weaver-owned headings, joined by blank lines — `app` "About this app:", `context` "Right
  now:", `stance` "For this conversation:", `extra` bare.
- **OR3 `composeInstructions` / `toolBriefSection`** — `src/session.ts:435-473`: the recipe is
  `Resolved<string | PromptSlots>`; a resolver receives `PromptContext { reason: start |
  reconnect | refresh, turns, starts, usage }`; the woven slots get `renderToolBrief([{ ns:
  "app", brief, tools }])` appended. A plain string skips the Tools section — which is how the
  lab silently has none (`lab/src/ui/App.tsx:49`).
- **OR4 session-state conditionals** — `src/session.ts`: `reason` from `startCount` (225-233);
  `refreshPrompt` (404-414) and `applyInstructions`, which sends only when the text changed
  (419-427); `recompose: "each-turn"` after each completed turn but not after tool calls
  (1096-1098); `setInstructions` freezes the recipe (382-385); `setTools` re-sends and
  recomposes (365-372).
- **OR5 greeting** — `src/session.ts:761-769`: `Open the conversation by saying exactly: "…".
  Say nothing else.`, or a verbatim object, sent as per-response instructions. The ledger records
  that it was sent, not the text.
- **OR6 `toolSchemas`** — `src/session.ts:615-623`: name, description, parameters; `usage`
  deliberately goes only into the Tools section.
- **OR7 mint** — `src/keys.ts:42-56`, `src/mint-backend.ts:52-60`: the composed prompt is baked
  page-side into the client-secret mint; the server only relays it.
- **OR8 `sendText` / `sendImage`** — `src/session.ts:554-605`: user or system `input_text`; a
  caption plus image.
- **OR9 tool results** — `src/session.ts:1102-1151`: `JSON.stringify`; in-band errors
  `{"error":"unknown tool: …"}`, `{"error":"invalid arguments: …"}`.
- **OR10 `toolsFromControlSurface`** — `src/aiui-tools.ts:89-248`: synthesized `set_*` tools
  described as "Set `<desc>` — range lo–hi unit. Returns the value actually applied (snapped
  and clamped).", schema from metadata (enum, min/max, multipleOf), a fixed `report`
  description; calls logged to the page call log as caller "oracle".
- **OR11 `toolsFromAiuiRegistry` / `briefFromAiuiRegistry`** — `src/aiui-tools.ts:269-344`:
  filters namespaces, groups and parked state; `ns_` prefix when more than one namespace;
  briefs joined by blank lines. Used by the dock and demos/live.
- **OR12 lab** — `lab/src/ui/App.tsx:34-178`: a hard-coded blurb, a live instructions textarea,
  tool toggles; the OracleViewer's JSON expand is the only place the prompt text shows.

### aiui-intent-client — the panel's oracle lane and the page relays

Observability: the panel prompt fold, `promptWeaves` (`src/ui/oracle-prompt-fold.ts:50-82`,
`src/ui/oracle-prompt.tsx:40-85`) — "startup prompt · N chars" and "re-woven" rows, final strings
only, never the parts.

- **IC1 recipe** — `src/lanes/oracle.ts`: `PANEL_BLURB` (56-60) fills `app`; `context` is LP6
  over `{url, title}`, raced against a 750 ms timeout and omitted on timeout (285-310), backfilled
  by `refreshPrompt` after connect (413-415); greeting at 359.
- **IC2 `oracleToolsForTab` / `oracleBriefForTab`** — `src/lanes/oracle.ts:127-177`: a second
  projection of the page registry into oracle tools (the first is OR11). It dropped `group`
  until this survey; fixed the same day.
- **IC3 `applyTools`** — `src/lanes/oracle.ts:427-472`: three toggleable groups (page, panel,
  file); `setTools` gated on a `${tab}|${names}|${brief}` signature.
- **IC4 file and panel tools** — `src/lanes/oracle-tools.ts:40-224`: fixed descriptions with no
  kind or group (so they render under "Other tools:"); refusal strings such as
  `"<cmd>" is not a control the oracle may press`.
- **IC5 contributions** — `src/lanes/oracle-contributions.ts:61-93`: its own shot bracket
  `[screenshot of the area I selected — W×H]` followed by LP5 with `attached="true"`; selections
  via LP9; both with `respond: false`. `composeIntent` is deliberately not reused.
- **IC6 page relays** — `src/cdp/page-script.ts:212-490`, `src/ext/content-main.ts:36-136`,
  `src/tools-link.ts:156-225`, `src/page-tools.ts:29-210`: forward `{ns, brief, tools[{name,
  description, usage, kind, group, inputSchema}]}` unchanged, adding only error strings; the
  brief is part of `toolsHash`.
- **IC7 region descriptions** — `src/spec.ts:257-274`: mode regions with `agent:` become
  `control()`s (`aiui-viz/src/mode-solid.ts:100-120`), so these strings are model-visible.

### aiui-live and demos/live — GPT-Live and its delegations

The live ledger records the full config, the seed and every append. The Responses and Claude
delegators record log lines only.

- **LV1 constants** — `src/prompt.ts:19-40`: `LIVE_BASE_PERSONA`, the backchannel and
  interruption policies, the default backend-tools / delegate-when / closing bullets.
- **LV2 `livePrompt`** — `src/prompt.ts:81-110`: a slot weave in vendor template order
  ("About this app:", "Delegation policy:", "Backend tools:", "Delegate to the backend when:"),
  blank-line joined, empty slots dropped.
- **LV3 `backendToolsFromTools`** — `src/prompt.ts:58-77`: the capability-list slot — the
  brief's first sentence plus `- name: firstSentence(description)`; truncation exists because
  seismos' descriptions reached 5.9 KB.
- **LV4 `composeWire`** — `src/session.ts:497-551`: an authored `backendTools` slot is a preface
  the derived list is appended to; a plain-string `instructions` bypasses `livePrompt`; **branch
  on the delegation backend** — type `responses` with no explicit tools appends
  `renderToolBrief` to `responses.instructions` and maps tools with `backendToolFor`.
- **LV5 `reseedInput`** — `src/session.ts:455-494`: the first-start vs continuation branch;
  the transcript trimmed from the end to ~6000 tokens; a fixed developer message "The
  conversation below happened moments ago … do not greet again." (487).
- **LV6 appends** — `src/session.ts:372-382, 1033-1085`, `src/protocol.ts:125-162`:
  say/note/steer become commentary, thinking and instructions, chunked at 500 tokens.
  Recorded finding: commentary gets paraphrased, so exact wording must travel as instructions.
- **LV7 generated speech** — `src/session.ts:117-119, 926-1021`: "Still working on it." every
  quiet interval (default 9 s); "I couldn't finish that one." on a delegator throw; the
  delegator's return spoken only if the task has not spoken yet — all invocation- and
  timing-dependent.
- **LV8 `backendPrompt`** — `src/prompt.ts:123-140`: markdown `##` sections ("Voice
  conversation context", "Task instructions", "Return the result"); the app interpolated
  conditionally.
- **LV9 `responsesDelegator`** — `src/delegators/responses.ts:52-138`: instructions
  `[backendPrompt, renderToolBrief].join("\n\n")`; stateless, `store: false`, at most 6 rounds; a
  fallback line is spoken.
- **LV10 `requestMessage`** — `src/delegators/responses.ts:141-158`: "Recent conversation
  (transcribed speech, may contain errors):" with `role: text` lines, then `Request (delegation
  id): …`, with a fallback when the text is empty.
- **LV11 `claudeDelegator`** — `src/claude/index.ts`: the Agent SDK `claude_code` preset plus an
  append of `CLAUDE_LIVE_BRIEF` and an optional caller `systemPrompt` (64-73, 257-264); an
  in-process MCP server `live` with literal instructions and descriptions for
  say/note/steer/app_list/app_call, all `alwaysLoad` (133-214); the per-delegation message
  (356-373) is a `delegation` XML element wrapping LV10, then "App tools available through
  app_call:" with `renderToolBrief`, then `- name(a, b?)` argument lines (84-91, added after a
  guessed argument cost a turn); one long `query()` serves every delegation, so later ones are
  continuations; `settingSources: []`, so no CLAUDE.md loads.
- **LV12 types** — `src/types.ts:58-103`: `backendToolFor` and `toolSpec` strip usage, kind and
  group; `runTool` produces error objects.
- **LV13 relay** — `src/delegators/remote.ts`, `src/relay-protocol.ts`,
  `src/node/backend.ts:196-300`: ships text, transcript, tools and brief to the server-side LV9
  or LV11, adding timeout and unknown-tool errors; `fake.ts` canned replies; `node/speech.ts`
  TTS passthrough.
- **DL1 authored slot sets** — `demos/live/src/live/prompt.ts:9-43`: `LIVE_SLOTS`, `WIRE_SLOTS`,
  `BACKENDS_SLOTS` (the last omits `backendTools`, so only the derived list appears).
- **DL2 `sessionConfigFor` / `makeDelegator`** — `demos/live/src/live/setup.ts:90-143`: the
  hosted backend adds `backendPrompt({ app })`.
- **DL3 App.tsx** (11-66): re-projects through OR11 on every registry change.
- **DL4 headless.mts** (48-107): templated stand-in tool descriptions.
- **DL5 tools-bench.mts** (30-151): builds a real `DelegationRequest` from the channel's
  `/debug/api/page-tools` registrations and runs LV9 or LV11; prints say/note/steer and the page
  call log.
- **DL6 tour pages**: `SessionBuilder.tsx:103-162` is a live slot editor with a "full prompt"
  preview — the nearest existing prompt visualiser; the other pages are display-only or run
  against a fake vendor; `Claude.tsx` shows a placeholder for `CLAUDE_LIVE_BRIEF`.

### aiui-viz and aiui-dock — the text an app authors

Authored page-side, read three ways: the Claude Code session gets it structured
(`page_tools_list`), the oracle and GPT-Live get it rendered (`renderToolBrief`), all three read
the results.

- **VZ1 `renderToolBrief`** — `src/tool-brief.ts:57-133`: a "Tools:" header, the kit briefs,
  fixed Read / Write / Other headings with `group` sub-headings inside each, `- name: description
  usage` items, a failure-line footer only when tools exist; over `maxChars` the usage lines are
  dropped longest-first; an optional `ns/` qualify that nothing uses. Pure and deterministic. All
  four production callers flatten to one kit `{ ns: "app" }`: `aiui-oracle/src/session.ts:454`,
  `aiui-live/src/session.ts:519`, `delegators/responses.ts:69`, `claude/index.ts:360`.
  **Migrated 2026-10-09 (stage 1):** `tool-brief.ts` is now a layer over the prompt toolkit —
  `toolSnapshot` takes the toolkit's `ToolSnapshot` (`sha256:` fingerprint), `toolBrief` is its
  `ToolBrief` node, `renderToolBrief` the node's compiled text (byte-identical to the corpus), and
  `instructionsWithToolBrief` + `renderPrompt` give the oracle and the live delegators one compiled
  prompt whose semantic record rides the `config` / `prompt` ledger entries beside the text.
- **VZ2 `AgentTool` / `forwardToRegistry`** — `src/agent-tools.ts:38-151`: the
  description/usage/kind/group/params contract; pushes a synthetic `report`; errors "no tool … —
  registered tools: …".
- **VZ3 compile-time lifting** — `aiui-source-processor/src/source-locator.ts:111-122, 196-277,
  454-461`: the JSDoc summary becomes `description`; `@usage` and `@example` ("Example: …")
  become `usage`. No demo or template uses `@usage` today.
- **VZ4 control and action metadata** — `src/control.ts:72-117, 251-263, 355-385`:
  `controlSurface()` snapshots and validation errors.
- **VZ5 `registerStandardTools`** — `src/standard-tools.ts:247-553`: fixed description and
  usage for report, set, locate, read-page, selection, sources, source, with defaults
  interpolated from constants; structured "nothing" answers (`{ selected: false, note }`,
  `{ available: false, reason, suggestions }`); action tools via `toolOfAction` with a fallback
  description, re-synced on every surface change.
- **VZ6 result renderers** — `src/page-text.ts` (DOM → markdown, skips `data-aiui-chrome`),
  `src/page-selection.ts` (structured selections), `src/source-reader.ts` (numbered lines, fixed
  reason strings).
- **VZ7 `registerCrossfilterTools`** — `src/crossfilter.ts:537-703`: usage rebuilt from the
  declared dimensions (`Dimensions: leaf (interval lo–hi unit; usage); …` or "(none declared
  yet)"), a typed schema per dimension, re-registered when the dims change; errors and
  provenance `describe()` objects; `mosaic-selection.ts:354-390, 620-646` errors reach the model.
- **VZ8 `registerSqlTools`** — `src/duckdb.ts:897-1069`: `sql` usage assembled from introspected
  tables and view names with limits interpolated, re-registered on introspection, on view-name
  change and on base-table change (so the text depends on database history); markdown result
  format and guard errors; the `schema` result carries view provenance.
- **VZ9 saved-view tools** — `src/selection-views.tsx:190-245`: fixed text and errors.
- **VZ10 `window.__AIUI__.tools`** — `src/aiui-global.ts:29-330`: `list()` is what every bridge
  serialises; `ledger()` is a console table, not a prompt.
- **VZ11 on-page tool log** — `src/site/tool-log.tsx:48-358`: the main existing "what the model
  sees" visualiser; its "as rendered" tab renders one kit per namespace, includes parked ones and
  has no `maxChars`, so it can differ from what the oracle or live session received.
- **DK1 `projectSurface`** — `aiui-dock/src/project.ts:25-43`: OR11 behind a signature gate.
- **DK2 recipes** — `aiui-dock/src/dock.tsx:92-188`: the oracle `context` is the sentence
  `The user is looking at "<title>" (<href>).` — not the panel's `tab` record; the live
  `{ app }`, and `backendPrompt` for hosted; `setTools` re-pushed by an effect.
- **DK3 viewers** — `aiui-dock/src/dock.tsx:192-342`: the oracle "prompt (as sent)" fold and
  `LiveConfigFold`.

### Elsewhere

- **Skills** (`skills/*/SKILL.md`): static markdown; the frontmatter `description` is the
  trigger text; they restate rendering contracts by hand (session-browser 21-32, 86-101;
  aiui-architecture 229-249). `skills:check` guards links only.
- **create-aiui template**: `CLAUDE.md` static; `graph.ts:56` calls `agentToolkit` with no brief.
- **Demo tool text**: authored brief paragraphs only in seismos `graph.ts:143-152` and wine
  `graph.ts:56-66`; seismos `suggest-mc` (169-177) has an explicit description;
  `completeView.describe()` (116-138) interpolates live Mc state; motherduck-lab
  `graph.ts:198-207` conditions the `sql`/`schema` catalog list on the picked table; the rest use
  JSDoc-lifted action descriptions.
- **No model-facing text**: aiui-pencil, aiui-remote-bar, aiui-console (ink reaches a model only
  as screenshot pixels); aiui-intent-runtime captures structured inputs only; the aiui CLI
  (`commands/claude.ts:236-263`) passes argv and adds no system-prompt text — no
  `--append-system-prompt` exists anywhere; the only `systemPrompt` key is LV11's.

## The patterns

1. **Named slots with weaver-owned headings, blank-line joined** — OR2/OR3, LV2, DL1, IC1, DK2;
   DL6 edits one.
2. **A resolver over session state, recomposed and deduped before send** — inputs reason
   (start / reconnect / refresh), turns, starts, usage — OR3/OR4, IC1, DK2.
3. **Ordered `sections[]` with conditional pushes**, split into a hello-static part pre-warmed
   at thread-open and an event-dependent part decided at fin — CH1, CH2, CH4.
4. **Compiler passes over an explicit IR with a span-emitting joiner** — LP1–LP3, CH2. The only
   family whose output maps back to its parts.
5. **Bracket marker plus XML sidecar** — the Claude Code vocabulary (LP4–LP10, IC5); a sibling
   XML-free grammar for the linter (CH14); ad-hoc brackets nothing defines (CH15's
   `[…truncated…]`, CH9's `[aiui intent]`).
6. **One structured tool document, rendered per consumer** — name, description, usage, kind,
   group, schema, kit brief: JSON for Claude Code (CH11, IC6), markdown for the oracle and live
   (VZ1 via OR3, LV4, LV9, LV11), a first-sentence capability list (LV3), a human log (VZ11).
   Vendor tool arrays always strip `usage` (OR6, LV12).
7. **Tool text assembled from runtime state, refreshed by re-registering by name** — VZ5
   actions, VZ7, VZ8, motherduck-lab's catalogs, seismos `describe()`.
8. **Compile-time doc-comment lifting into option objects** — VZ3, VZ4.
9. **Hard-coded prose constants mirrored by hand into docs or instructions, unchecked** — OR1 ↔
   aiui-oracle `docs/oracle.md:231-250`; CH13 ↔ `docs/guide/intent-panel.md`; CH7 ↔ the
   lowering renderers; CH10 prose ↔ the router code; the skills ↔ the code.
10. **Conditionals on session, invocation or backend state** — invocation and timing: OR4,
    OR5 (greeting frozen per start), LV5, LV7, CH8 (first vs later stale notice), CH9
    (`warnedUrl`); turn and environment: CH2 (`hasSpeech`), CH1 (aiui detection, CDP state),
    CH3 (cache reuse), CH14 (selection phase); tool selection: IC3 toggles, last-app tab,
    `ns_` prefix when several; backend and wiring: LV4 `delegation.type`, LV11's continuing
    query, CH10's wiring-dependent tool list.
11. **String / object polymorphism that changes framing silently** — OR3 drops the Tools section
    for a string recipe; LV4 bypasses `livePrompt` for one; OR5 treats a string greeting as "say
    exactly" and an object as verbatim.
12. **XML-wrapped per-turn delegation messages and transcript rendering under a token budget**
    — LV10, LV11, LV5.
13. **Caps, elision and budget rules inside renderers** — LP5, LP8, LP9, VZ1 `maxChars`, LV3,
    LV5, LV6, CH6, CH14, CH15.
14. **Vendor parameters instead of prose, and vendor-duplicated declarations** — Scribe
    `keyterms` (CH16); the OpenAI and Gemini `read_file` twins (CH15).

Model-readable result and error text is everywhere, either `JSON.stringify` of live structures or
"no X — known: a, b" templates: OR9, OR10, IC4, CH11, CH15, LV9, LV11, LV13, VZ2, VZ4, VZ5, VZ7,
VZ8, VZ9.

## Problems found on the way

- **`render-audit.mts` cannot run.** `aiui-claude-channel/render-audit.mts:28-33` imports
  `selectionSections`, which a code-review cleanup removed from `prompt-context.ts`; the committed
  `docs/prompt-rendering.md` is therefore stale and `audit.local/` does not exist. Its
  hand-pasted tool description (line 703, `tools[] (name/description/inputSchema)`) has drifted
  from `tools.ts:55` (`name/description/kind/group/inputSchema`).
- **Two projections of the page registry into oracle tools disagreed** — IC2 dropped `group`
  while OR11 kept it, so the panel oracle never saw group sub-headings. Fixed 2026-10-09 with this
  survey; the duplication remains.
- **The marker vocabulary is written twice** (CH7 prose vs the LP renderers; "elided past 50
  lines" is a literal in both), as are the linter persona (CH13 ↔ intent-panel.md) and the
  oracle persona (OR1 ↔ oracle.md). Nothing checks the pairs.
- **Most delegation prompts are recorded nowhere** — LV9, LV11, CH6's input, and the startup /
  stale / channel-error notices. Only the oracle and GPT-Live instructions land whole in a
  ledger, and only the Claude Code lowered prompt has a persisted trace.
- **No session-level prompt seam on the Claude Code launch**: text reaches the session only
  through skills, CH7, tool declarations and channel events.

## What the aiui-prompts spike covers, and the gaps

The root package exports nothing yet (`src/index.ts` is `export {}`). The authoring spike owns a
JSX runtime with an immutable node IR (prompt, group, section, paragraph, text, math, image, xml,
choice, join), `compilePrompt` (definitions vs occurrences, heading depth from placement,
text/image parts, an exact UTF-16 output map), `explainRange`, `renderTurn` and `prepareRequest`
to a neutral, never-sent envelope; seven checked examples and a playground. The inspector spike is
a DOM viewer over fixtures with preview, ranges, folds, before/after comparison and a
turn-versus-history panel. The proposal keeps prompt, turn and history separate (D3), takes no
aiui dependency (D1), derives tool briefs from one tool snapshot, and targets a Responses-style
adapter first.

Against the sites above it lacks: session-state conditionals beyond a static `Choice`
(patterns 2, 3, 10); tool rendering with read/write/group structure and usage lifting
(pattern 6); the bracket-and-sidecar vocabulary (pattern 5); realtime `session.update` and append
channels (OR4, LV6); an STT parameter path; and a byte-identical migration target for any existing
site.

## Where to start

The three site families that already expose their structure or a ledger are the natural first
targets: the lowering renderer with its fin-time preamble (LP3 + CH2, the only spans producer),
the oracle's slot weaver and resolver (OR2–OR4), and the live composer (LV2 + LV4). The one shared
renderer, `renderToolBrief` (VZ1), is the obvious first common component — its four callers
already flatten to the same shape, and pattern 6 says every consumer wants a different projection
of the same tool document.
