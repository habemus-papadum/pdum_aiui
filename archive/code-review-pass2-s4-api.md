# Code review, pass 2 — S4: published-API surface pruning

**Status: decision document — awaiting markup.** Produced by the pass-2 catalog run
(24 finders/planners + adversarial verification of every delete/unexport and
importable/collapsible claim; full structured data in
`docs/proposals/review-pass2.local/catalog.json`). Nothing here has been changed yet;
mark the response blocks and the approved items become the implementation plan.

773 exports audited across the workspace. Per package: the acting lists (delete /
unexport / internal-subpath) in full — every delete/unexport claim was adversarially
verified (210 confirmed, 35 adjusted, 0 refuted; adjusted ones annotated) — and the
keep set as a count. "unexport" = remove from the barrel, symbol stays module-local;
"internal-subpath" = move behind a non-public subpath for sibling-package use.

---

## @habemus-papadum/aiui-claude-channel

keep: 88 · unexport: 105 · internal-subpath: 9 · delete: 0

**internal-subpath:**
- `agentsByPid` (packages/aiui-claude-channel/src/agents.ts; workspace-internal; used by packages/aiui/src/commands/pencil-url.ts:24)
- `ClaudeAgent` (packages/aiui-claude-channel/src/agents.ts:13; workspace-internal; used by packages/aiui/src/commands/pencil-url.ts:25 (type))
- `listClaudeAgents` (packages/aiui-claude-channel/src/agents.ts; workspace-internal; used by packages/aiui/src/commands/pencil-url.ts:26)
- `ListOptions` (packages/aiui-claude-channel/src/list.ts:18; workspace-internal; used by type-required: param of listMcpServers (src/list.ts:81); moves with it)
- `listMcpServers` (packages/aiui-claude-channel/src/list.ts:81; workspace-internal; used by packages/aiui/src/commands/clean.ts:25, packages/aiui/src/commands/debug.ts:13, packages/aiui/src/commands/native-host.ts:18, packages/aiui/src/commands/pencil-url.ts:27)
- `RegistryEntry` (packages/aiui-claude-channel/src/registry.ts; workspace-internal; used by type-required: RunningServer extends RegistryEntry (src/registry.ts:58); moves with RunningServer)
- `RunningServer` (packages/aiui-claude-channel/src/registry.ts:58; workspace-internal; used by packages/aiui/src/commands/pencil-url.ts:28 (type), packages/aiui/src/util/channel-target.ts:14 (type), packages/aiui/src/util/channel-target.test.ts:1)
- `selectMcpServer` (packages/aiui-claude-channel/src/select.ts:33; workspace-internal; used by packages/aiui/src/commands/debug.ts:13, packages/aiui/src/commands/pencil-url.ts:29, packages/aiui-intent-client/scripts/dev.ts:24)
- `projectCacheDir` (packages/aiui-claude-channel/src/trace.ts; workspace-internal; used by packages/aiui/src/commands/clean.ts:25, packages/aiui/src/util/chrome.ts:43, packages/aiui/src/util/config.ts:25)

**unexport:**
- `EnrichedServer` (packages/aiui-claude-channel/src/agents.ts; dead)
- `enrichServers` (packages/aiui-claude-channel/src/agents.ts; dead)
- `parseClaudeAgents` (packages/aiui-claude-channel/src/agents.ts; dead)
- `SessionInfo` (packages/aiui-claude-channel/src/agents.ts:31; dead)
- `buildElevenLabsUrl` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `convertWords` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `DEFAULT_ELEVENLABS_MODEL` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `ELEVENLABS_COMMIT_FLOOR_MS` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `ELEVENLABS_ERROR_TYPES` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `ELEVENLABS_KEEPALIVE_MS` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `ELEVENLABS_REALTIME_URL` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `ElevenLabsRealtimeSessionOptions` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `elevenLabsSocketFactory` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `isErrorType` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `openElevenLabsRealtimeSession` (packages/aiui-claude-channel/src/elevenlabs-realtime.ts; dead)
- `createFrameLog` (packages/aiui-claude-channel/src/frame-log.ts; dead)
- `FRAME_LOG_LIMIT` (packages/aiui-claude-channel/src/frame-log.ts; dead)
- `FrameLog` (packages/aiui-claude-channel/src/frame-log.ts; dead)
- `FrameLogOptions` (packages/aiui-claude-channel/src/frame-log.ts; dead)
- `DEFAULT_GEMINI_LIVE_MODEL` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `GEMINI_LIVE_URL` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `GeminiLiveSessionOptions` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `geminiLiveSocketFactory` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `LiveFrameKind` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `openGeminiLiveSession` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `parseTimeLeftMs` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `WindowOrderingGuard` (packages/aiui-claude-channel/src/gemini-live.ts; dead)
- `channelSourceDir` (packages/aiui-claude-channel/src/hot.ts; dead)
- `isSourceRun` (packages/aiui-claude-channel/src/hot.ts; dead)
- `loadModuleFresh` (packages/aiui-claude-channel/src/hot.ts; dead)
- `WatchFn` (packages/aiui-claude-channel/src/hot.ts; dead)
- `WatchOptions` (packages/aiui-claude-channel/src/hot.ts; dead)
- `watchChannelSource` (packages/aiui-claude-channel/src/hot.ts; dead)
- `createIntentV1Format` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `IntentV1Options` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `intentV1Format` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `LoweredMessage` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `LoweredPromptMessage` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `SpeechMessage` (packages/aiui-claude-channel/src/intent-v1.ts; dead)
- `parseLaunchInfo` (packages/aiui-claude-channel/src/launch-info.ts; dead)
- `dirRank` (packages/aiui-claude-channel/src/list.ts; dead)
- `sortServers` (packages/aiui-claude-channel/src/list.ts; dead)
- `SELECTION_EXCERPT_CHARS` (packages/aiui-claude-channel/src/live-resolve.ts; dead)
- `SelectionEntry` (packages/aiui-claude-channel/src/live-resolve.ts; dead)
- `selectionInjectionLabel` (packages/aiui-claude-channel/src/live-resolve.ts; dead)
- `selectionRetractionLabel` (packages/aiui-claude-channel/src/live-resolve.ts; dead)
- `LINTER_INSTRUCTIONS` (packages/aiui-claude-channel/src/live-session.ts; dead)
- `LinterToolCall` (packages/aiui-claude-channel/src/live-session.ts; dead)
- `LiveCapabilities` (packages/aiui-claude-channel/src/live-session.ts; dead)
- `LiveSession` (packages/aiui-claude-channel/src/live-session.ts; dead)
- `LiveSessionCallbacks` (packages/aiui-claude-channel/src/live-session.ts; dead)
- `DEFAULT_OPENAI_LIVE_MODEL` (packages/aiui-claude-channel/src/openai-live.ts; dead)
- `OpenAiLiveSessionOptions` (packages/aiui-claude-channel/src/openai-live.ts; dead)
- `openOpenAiLiveSession` (packages/aiui-claude-channel/src/openai-live.ts; dead)
- `formatPageToolsChanged` (packages/aiui-claude-channel/src/page-tools.ts; dead)
- `OPENAI_REALTIME_VOICE_URL` (packages/aiui-claude-channel/src/pcm.ts; dead)
- `pcm16ToWav` (packages/aiui-claude-channel/src/pcm.ts; dead)
- `REALTIME_VOICE_RATE` (packages/aiui-claude-channel/src/pcm.ts; dead)
- `DEFAULT_REALTIME_MODEL` (packages/aiui-claude-channel/src/realtime.ts; dead)
- `OPENAI_REALTIME_URL` (packages/aiui-claude-channel/src/realtime.ts; dead)
- `openaiRealtimeSocketFactory` (packages/aiui-claude-channel/src/realtime.ts; dead)
- `createJsonlRecorder` (packages/aiui-claude-channel/src/recording.ts; dead)
- `JsonlRecorder` (packages/aiui-claude-channel/src/recording.ts; dead)
- `isProcessAlive` (packages/aiui-claude-channel/src/registry.ts; dead)
- `RegisteredServer` (packages/aiui-claude-channel/src/registry.ts; dead)
- `readEntry` (packages/aiui-claude-channel/src/registry.ts; dead)
- `registerServer` (packages/aiui-claude-channel/src/registry.ts; dead)
- `registryDir` (packages/aiui-claude-channel/src/registry.ts; dead)
- `registryFileFor` (packages/aiui-claude-channel/src/registry.ts; dead)
- `removeEntryFile` (packages/aiui-claude-channel/src/registry.ts; dead)
- `serverLabel` (packages/aiui-claude-channel/src/select.ts; dead)
- `sendPrompt` (packages/aiui-claude-channel/src/send.ts:18; dead)
- `sendPromptWs` (packages/aiui-claude-channel/src/send-ws.ts:36; dead)
- `mockSpeaker` (packages/aiui-claude-channel/src/speak.ts; dead)
- `createTransportStats` (packages/aiui-claude-channel/src/stats.ts; dead)
- `FrameStat` (packages/aiui-claude-channel/src/stats.ts; dead)
- `TransportSnapshot` (packages/aiui-claude-channel/src/stats.ts; dead)
- `TransportStats` (packages/aiui-claude-channel/src/stats.ts; dead)
- `DEFAULT_SUMMARY_MODEL` (packages/aiui-claude-channel/src/summarize.ts; dead)
- `OpenAiSummarizerOptions` (packages/aiui-claude-channel/src/summarize.ts; dead)
- `openaiSummarizer` (packages/aiui-claude-channel/src/summarize.ts; dead)
- `SUMMARY_SYSTEM_PROMPT` (packages/aiui-claude-channel/src/summarize.ts:51; dead)
- `Summarizer` (packages/aiui-claude-channel/src/summarize.ts; dead)
- `summaryPromptInput` (packages/aiui-claude-channel/src/summarize.ts; dead)
- `ChannelInfo` (packages/aiui-claude-channel/src/tools.ts; dead)
- `ChannelToolHandles` (packages/aiui-claude-channel/src/tools.ts; dead)
- `collectChannelInfo` (packages/aiui-claude-channel/src/tools.ts; dead)
- `registerChannelTools` (packages/aiui-claude-channel/src/tools.ts; dead)
- `selfChannelInfo` (packages/aiui-claude-channel/src/tools.ts; dead)
- `UnregisteredInfo` (packages/aiui-claude-channel/src/tools.ts; dead)
- `createTraceStore` (packages/aiui-claude-channel/src/trace.ts; dead)
- `listTraces` (packages/aiui-claude-channel/src/trace.ts; dead)
- `PROJECT_CACHE_DIRNAME` (packages/aiui-claude-channel/src/trace.ts; dead)
- `readTrace` (packages/aiui-claude-channel/src/trace.ts; dead)
- `sessionLabel` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TraceHandle` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TraceManifest` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TraceStage` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TraceStageKind` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TraceStore` (packages/aiui-claude-channel/src/trace.ts; dead)
- `traceBlobPath` (packages/aiui-claude-channel/src/trace.ts; dead)
- `TracingThreadContext` (packages/aiui-claude-channel/src/tracing.ts; dead)
- `traceOf` (packages/aiui-claude-channel/src/tracing.ts; dead)
- `withTracing` (packages/aiui-claude-channel/src/tracing.ts; dead)
- `audioExtensionForMime` (packages/aiui-claude-channel/src/transcribe.ts; dead)

**Notes:** Scope: all 202 named exports of packages/aiui-claude-channel/src/index.ts (verified programmatically against the barrel; my walk and the extracted list differ by zero names). package.json has exactly one subpath export ("." -> ./src/index.ts, publishConfig dist swap present with a "default" condition) plus the bin "aiui-claude-channel" -> ./dist/cli.js; there are no other subpaths to audit. Method: (1) exhaustive git grep for the package specifier to find every real import site outside the package; (2) git grep -lw per export name across tracked ts/tsx/mts/mjs to find internal (relative-import) usage and to catch mirrors; (3) doc evidence from README.md and docs/websocket-protocol.md; (4) in-file use counts to separate unexport from delete. Tally: 67 contract/keep, 9 workspace-internal/internal-subpath, 22 test-only (21 keep, 1 counted under contract: channelCliPath), 105 dead-as-export/unexport, 0 delete (every dead export is still used inside the package via relative imports or its own module — "unexport" means remove the barrel line only; module-level exports stay, so the change is behavior-preserving for all in-repo consumers, which import either via relative paths or the kept names).

Key structural finding: many word-grep "consumers" are deliberate same-named MIRRORS, not imports, per the dependency-direction rules — aiui-intent-runtime/src/protocol.ts re-implements the frame protocol (its protocol.test.ts imports decodeFrame/jsonCodec/PROTOCOL_VERSION from the channel purely as a parity guard — keep those exports for that test), aiui-remote-bar and aiui-pencil mirror SessionInfo/PROTOCOL_VERSION, aiui-console/app mirrors LaunchInfo/ChannelInfo (it reads /debug/api JSON), aiui-vscode/src/channels.ts re-implements registry reading (vscode imports nothing in-workspace), aiui-lowering-pipeline has its own LINTER_INSTRUCTIONS, aiui-trace-ui its own LiveCapabilities/sendPrompt. None of these constrain the barrel.

Internal-subpath proposal: the channel-discovery/CLI plumbing consumed only by the aiui launcher and the intent-client dev script (listMcpServers, ListOptions, selectMcpServer, agentsByPid, listClaudeAgents, ClaudeAgent, RunningServer, RegistryEntry, projectCacheDir) would move to e.g. "@habemus-papadum/aiui-claude-channel/discovery". Since aiui is a *published* consumer, the subpath must exist in both the dev exports and publishConfig.exports, and the publishConfig conditional object MUST end with a "default" condition (the ERR_PACKAGE_PATH_NOT_EXPORTED trap CLAUDE.md documents; source-first dev masks it — run pnpm test:packaging).

Bugs/drift found during the audit (worth fixing regardless): (1) packages/aiui/test/openai-pipeline.e2e.ts:25 imports SYSTEM_PROMPT from the channel — no such export exists (only SUMMARY_SYSTEM_PROMPT, summarize.ts:51); the file escapes typecheck because packages/aiui/tsconfig.test.json includes only "src", so test/*.e2e.ts is never typechecked. (2) README.md:30 documents importing CHANNEL_CONFIG, which exists nowhere in src/ — doc drift. (3) Barrel gap: TraceStageSink (trace.ts:80) and its TraceStageEvent are referenced by the exported WebServerOptions.traceSink but are NOT exported from the barrel — an installed consumer cannot name the type; if WebServerOptions stays contract, these should be ADDED to the barrel. (4) SessionClientMessage (session-hub.ts:61) has zero code references anywhere (definition only) — kept as the documented /session upstream wire shape, but flagging it for the human decision. (5) Unexporting sessionLabel/projectCacheDir would break {@link} doc references inside kept web.ts doc comments (cosmetic only; projectCacheDir survives on the proposed subpath).

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## @habemus-papadum/aiui-intent-client

keep: 23 · unexport: 33 · internal-subpath: 0 · delete: 0

**unexport:**
- `activationGesture` (packages/aiui-intent-client/src/activation.ts (barrel src/index.ts:18); dead)
- `configBar` (packages/aiui-intent-client/src/caps.ts (barrel src/index.ts:19); dead)
- `intentBar` (packages/aiui-intent-client/src/caps.ts (barrel src/index.ts:19); dead)
- `intentClaims` (packages/aiui-intent-client/src/claims.ts (barrel src/index.ts:20); dead)
- `intentConfig (namespace re-export of ./config)` (packages/aiui-intent-client/src/index.ts:27; dead)
- `installConfigAutoSave` (packages/aiui-intent-client/src/config-store.ts (barrel src/index.ts:28); dead)
- `loadConfigBase` (packages/aiui-intent-client/src/config-store.ts (barrel src/index.ts:28); dead)
- `hintsFor` (packages/aiui-intent-client/src/keys.ts:201 (barrel src/index.ts:30); dead)
- `KeyVerdict (type)` (packages/aiui-intent-client/src/keys.ts:171 (barrel src/index.ts:30); dead)
- `keyStack` (packages/aiui-intent-client/src/keys.ts:168 (barrel src/index.ts:30); dead)
- `keyVerdict` (packages/aiui-intent-client/src/keys.ts:184 (barrel src/index.ts:30); dead)
- `turnLayer` (packages/aiui-intent-client/src/keys.ts:45 (barrel src/index.ts:30); dead)
- `ChannelLanes (type)` (packages/aiui-intent-client/src/lanes.ts:151 (barrel src/index.ts:31); dead)
- `ChannelLanesConfig (type)` (packages/aiui-intent-client/src/lanes.ts (barrel src/index.ts:31); dead)
- `createChannelLanes` (packages/aiui-intent-client/src/lanes.ts:190 (barrel src/index.ts:31); dead)
- `currentThreadEvents` (packages/aiui-intent-client/src/lanes.ts:78 (barrel src/index.ts:31); dead)
- `OpenThread (type)` (packages/aiui-intent-client/src/lanes.ts:88 (barrel src/index.ts:31); dead)
- `panelIntentConfig` (packages/aiui-intent-client/src/lanes.ts:54 (barrel src/index.ts:31); dead)
- `sessionStorageMirror` (packages/aiui-intent-client/src/lanes.ts:103 (barrel src/index.ts:31); dead)
- `TurnMirror (type)` (packages/aiui-intent-client/src/lanes.ts:96 (barrel src/index.ts:31); dead)
- `BusPeer (type)` (packages/aiui-intent-client/src/session.ts:20 (barrel src/index.ts:41); dead)
- `BusPhase (type)` (packages/aiui-intent-client/src/session.ts:27 (barrel src/index.ts:41); dead)
- `BusState (type)` (packages/aiui-intent-client/src/session.ts (barrel src/index.ts:41); dead)
- `ChannelHealth (type)` (packages/aiui-intent-client/src/session.ts:173 (barrel src/index.ts:41); dead)
- `connectSessionBus` (packages/aiui-intent-client/src/session.ts (barrel src/index.ts:41); dead)
- `INITIAL_BUS_STATE` (packages/aiui-intent-client/src/session.ts:45 (barrel src/index.ts:41); dead)
- `probeChannel` (packages/aiui-intent-client/src/session.ts:182 (barrel src/index.ts:41); dead)
- `reduceBusMessage` (packages/aiui-intent-client/src/session.ts:48 (barrel src/index.ts:41); dead)
- `resolveChannelPort` (packages/aiui-intent-client/src/session.ts (barrel src/index.ts:41); dead)
- `SessionBusClient (type)` (packages/aiui-intent-client/src/session.ts (barrel src/index.ts:41); dead)
- `initialContext` (packages/aiui-intent-client/src/spec.ts (barrel src/index.ts:53); dead)
- `intentSpec` (packages/aiui-intent-client/src/spec.ts (barrel src/index.ts:53); dead)
- `INTENT_PREFIX (./sidecar)` (packages/aiui-intent-client/src/sidecar.ts:32; dead)

**Notes:** Structural facts driving every classification: (1) NOTHING imports the package's root barrel — `git grep 'from "@habemus-papadum/aiui-intent-client"'` has zero code hits anywhere in tracked files (the only textual hit is the stale skeleton doc packages/aiui-intent-client/docs/getting-started.md:19, which imports a `greet` that does not exist). All in-package consumption is via relative module paths; `git grep 'from "./index"'` inside src/ has zero hits, so removing barrel entries is provably behavior-preserving for the panel, the extension, and all tests. (2) The only cross-package import is the ./sidecar subpath (aiui-claude-channel/src/standard-sidecars.ts:27) — that subpath and its type closure must stay in both dev exports and publishConfig (with the trailing "default" condition per the CLAUDE.md guardrail), because the channel is itself a published package. (3) The aiui CLI's dependence on this package (packages/aiui/src/util/chrome.ts:262) resolves via packageRoot() (packages/aiui-util/src/provenance.ts:30), a node_modules filesystem walk that deliberately bypasses the exports map — so shrinking the barrel cannot break dist-ext discovery. (4) The root "." entry itself must remain: main/module/types point at it, vite.config.ts:44 builds it as the `index` lib entry, and dropping it would break plain require.resolve on the installed package. Recommended contract core = createIntentClient + IntentClient/IntentClientConfig/IntentLanes + their full type closure (ClaimLaneOptions, IntentContext, and the nine transport-seam types — README.md "The seam" row documents these as "the only things a host must provide") + fakeBus/FakeBus (the documented third host, src/index.ts:8). The 32 unexport recommendations are wiring the package's own two shipped hosts compose internally (lanes, session bus, keys internals, caps, config store); none has any importer through the barrel. Judgment call flagged for the human decision doc: if the external-embedding story is affirmed (a non-workspace panel host dialing a real channel), promote createChannelLanes + ChannelLanes + ChannelLanesConfig + OpenThread + TurnMirror and connectSessionBus + SessionBusClient + probeChannel + resolveChannelPort to contract — they are the only real IntentLanes implementation and channel-dialing code; today's evidence (zero consumers) says unexport, and packages/aiui-remote-bar/src/solid.ts:12 shows sibling packages deliberately treating IntentClient (not the lanes/session internals) as the exposed surface. Two staleness bugs found in passing: README.md:7 still says "Never published (--no-publish)" while package.json declares publishConfig.access "public" (and the name was npm-reserved 2026-07-15 per project memory); docs/getting-started.md is unedited skeleton boilerplate. Count: 49 root-barrel exports (walked exhaustively: activation 1, caps 2, claims 2, client 4, config-namespace 1, config-store 2, fake-bus 2, keys 5, lanes 8, session 10, spec 3, transport 9) + 5 ./sidecar module exports + 2 package.json subpaths = 56 entries. Verdict totals: 18 contract-keep (root) + 2 subpath-keep + 2 workspace-internal-keep + 2 test-only-keep + 33 dead-unexport (32 root + INTENT_PREFIX). No delete recommendations: every "dead" export's underlying symbol is live via in-module or relative-import use, so only the re-export/export keyword is removable.

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## @habemus-papadum/aiui-viz

keep: 151 · unexport: 13 · internal-subpath: 0 · delete: 0

**unexport:**
- `cellByName` (packages/aiui-viz/src/index.ts:29-35 (def packages/aiui-viz/src/cell.ts:170); dead)
- `ProgressStripe` (packages/aiui-viz/src/index.ts:37; dead)
- `Spinner` (packages/aiui-viz/src/index.ts:37; dead)
- `SCOPE_SEPARATOR` (packages/aiui-viz/src/index.ts:69 (def packages/aiui-viz/src/scope.ts:48); dead)
- `PLOT_STYLE` (packages/aiui-viz/src/plot.tsx:30; dead)
- `isDark` (packages/aiui-viz/src/site/index.ts:17; dead)
- `DEFAULT_DIFF_CLASSES` (packages/aiui-viz/src/modal/index.ts:78 (def modal/flash.ts:42); dead)
- `isExtension` (packages/aiui-viz/src/modal/index.ts:80 (def modal/flash.ts:52); dead)
- `LIVE_FLASH_MS` (packages/aiui-viz/src/modal/index.ts:81 (def modal/flash.ts:29); dead)
- `renderRuns` (packages/aiui-viz/src/modal/index.ts:84 (def modal/flash.ts:57); dead)
- `runsFragment` (packages/aiui-viz/src/modal/index.ts:85 (def modal/flash.ts:74); dead)
- `SETTLE_FLASH_MS` (packages/aiui-viz/src/modal/index.ts:86 (def modal/flash.ts:33); dead)
- `isTypingTarget` (packages/aiui-viz/src/modal/index.ts:92; dead)

**Notes:** Method: walked packages/aiui-viz/src/index.ts (64 exports), all six package.json subpath exports (./plot ./mosaic ./duckdb ./site ./modal ./testing, packages/aiui-viz/package.json:14-21), and every symbol on each subpath barrel (modal 67, site 8, testing 9, plot 2, mosaic 3, duckdb 2). Evidence is a repo-wide extraction of every `import/export ... from "@habemus-papadum/aiui-viz[/*]"` statement (tracked files only) cross-checked with per-symbol `git grep -w` including tests, docs/guide, the frontend-design skill, and the create-aiui app template.

Classification policy applied: (1) aiui-viz is published-public and is THE documented frontend-for-agents library; anything used by the create-aiui app template (scaffolded OUTSIDE the workspace — its imports resolve against the published package) or named in docs/guide / the frontend-design SKILL.md is contract. (2) "workspace-internal" here almost never permits internal-subpath/unexport, because the sibling consumers (aiui-intent-client, aiui-pencil, aiui-lowering-pipeline, aiui-remote-bar) are themselves PUBLISHED and import via the package specifier — their installed artifacts resolve against installed aiui-viz dist, so every symbol they use must stay on the published surface (e.g. `throttled` ← packages/aiui-pencil/src/reactive.ts:30; `wordDiff`/`DiffRun` ← packages/aiui-lowering-pipeline/src/patch.ts). (3) Types referenced by kept exports' signatures are kept even with zero direct importers. (4) "dead" required zero imports anywhere including tests, zero docs/skill mentions, and no signature reference.

13 unexport candidates (all behavior-preserving in-repo; all internal helpers or retired-overlay leftovers): root barrel cellByName, ProgressStripe, Spinner, SCOPE_SEPARATOR; /plot PLOT_STYLE (demos/gallery/src/site/theme.ts:121 explicitly replaced it); /site isDark; /modal DEFAULT_DIFF_CLASSES, isExtension, renderRuns, runsFragment, LIVE_FLASH_MS, SETTLE_FLASH_MS, isTypingTarget. Caveat: aiui-viz is published (0.6.0+dev line), so even these are technically observable API removals — batch them into a deliberate minor/major, not a drive-by.

Design-input flags for the decision doc: (a) Dependency-direction tension: the target says aiui-lowering-pipeline is a leaf, but it currently depends on aiui-viz solely for wordDiff/DiffRun (modal/diff.ts, a Solid-free, DOM-free module per modal/index.ts:24-29 realm rules); relocating wordDiff (into lowering-pipeline or a shared leaf) would sever viz←lowering and is the only edge blocking that goal. (b) The modal kit's à-la-carte modules mode.ts (runTransition/escTarget/blurExitTarget), reconcile.ts (createReconciler), focus.ts (createFocusTracker), effect.ts (guardedEffect), and createClaims/createModeEngine have zero non-test in-repo importers since both intent clients moved onto solidModeEngine — kept as contract because the modal/index.ts docblock and handoff/modal-interaction-lessons.md document them as the kit's offering, but they are the right place for a deliberate deprecation review. (c) Dropdown is consumed only by aiui-intent-client's channel header and is undocumented — a candidate to relocate into the intent client in a later (non-behavior-preserving-surface) pass. (d) The __aiui protocol exports (ensureAiuiGlobal, AiuiGlobal, AiuiPageTool, AiuiToolsRegistry) have zero importers by design: the CDP page-script (packages/aiui-intent-client/src/cdp/page-script.ts) is stringified and may import nothing, so consumption is structural; these types are the protocol's only typed record — keep. (e) aiui-test-app is private/in-repo, so its consumption (cellGraph, cellRegistry) is workspace-internal evidence only. Counts: 155 export rows total; 13 unexport, 0 delete, 0 internal-subpath, 142 keep.

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## @habemus-papadum/aiui-lowering-pipeline + @habemus-papadum/aiui-source-processor (S4 export-surface audit)

keep: 37 · unexport: 5 · internal-subpath: 0 · delete: 0

**unexport:**
- `IntentTier (type)` (packages/aiui-lowering-pipeline/src/config.ts:206 via src/index.ts:17; dead)
- `TIER_PRESETS` (packages/aiui-lowering-pipeline/src/config.ts:221 via src/index.ts:18; dead)
- `applyCorrectionToLines` (packages/aiui-lowering-pipeline/src/patch.ts:114 via src/index.ts:22; dead)
- `cellFactory` (packages/aiui-source-processor/src/source-locator.ts:101 via src/index.ts:39-48; dead)
- `optionsFactory` (packages/aiui-source-processor/src/source-locator.ts:112 via src/index.ts:39-48; dead)

**Notes:** Scope: both packages export exactly one subpath ("."), in both the dev form and the publishConfig form (each publishConfig conditional-exports object correctly ends with "default"). The barrel is therefore the whole surface; every barrel export above was walked in order, none sampled.

aiui-lowering-pipeline (published, public). The barrel (src/index.ts) has 29 exports. The contract core — Engine/composeIntent/IntentEvent + config (IntentPipelineConfig, DEFAULT_INTENT_CONFIG, expandTier) + the composed/prompt types — is exactly the package's documented purpose (index.ts:1-14: "shared by the intent client and the channel's lowering processor") and is consumed by four sibling published packages (channel, intent-client, intent-runtime, trace-ui), all importing through the package name, so unexporting anything they touch would break the published artifacts. Eight type exports have no direct importers but are constituents of the IntentEvent union or of kept signatures (AppSelection, CodeSelection, Mode, ShotShare, VideoCaptureMode, EngineListener, DiffRun, plus Rect/LocatedCell/LocatedComponent which also have a direct consumer in intent-runtime/src/locator.ts:21) — these stay under the "types referenced by kept exports" rule. Three genuine unexport candidates: TIER_PRESETS and IntentTier (zero importers anywhere; expandTier — which IS consumed — uses them internally, so unexport is behavior-preserving; they must go or stay together since TIER_PRESETS's type is Record<IntentTier, ...>), and applyCorrectionToLines (engine.ts consumes it via relative import; barrel export unused). applyPatch is honestly test-only (sole importer: packages/aiui/test/openai-pipeline.e2e.ts:30) but is the documented V4A machinery and unexporting would break that e2e — recommend keep. wordDiff/DiffRun are pure re-exports from @habemus-papadum/aiui-viz/modal (patch.ts:18, rationale comment at patch.ts:13-17, "one import site"); the only consumer is aiui-trace-ui/src/trace-view.ts:32. An alternative to keeping them is repointing trace-ui to aiui-viz/modal directly (as intent-client already does, src/edit/retime.ts:25) — but that ADDS an aiui-viz dependency to trace-ui (its package.json currently depends only on lowering-pipeline), so keep is the conservative call and consistent with lowering-pipeline being a leaf that already depends on aiui-viz. Hygiene finding, out of audit scope but worth the decision doc: the package's README.md:14 and docs/getting-started.md:19 still show the skeleton's `import { greet }` — an export that does not exist.

aiui-source-processor (published, public). The barrel has 11 exports (default + 10 named). The plugin entry points are firm contract: the default/named aiui() is imported by the create-aiui app template (packages/create-aiui/templates/app/vite.config.ts:1, vitest.config.ts:1), which per the constraints is scaffolded OUTSIDE the workspace and can only reach this package via its published surface; sourceLocatorVite is documented for external library authors (docs/guide/frontend-user-guide.md:660, frontend-design SKILL.md:258) and used by demos/oscillator. sourceLocatorBabel has zero importers but is the package's headline per its own description ("the compile-time Babel pass ... plus its Vite plugin") — the non-Vite integration point; classified contract on the documented-purpose clause, flagged so the decision doc can consciously demote it if that story is abandoned. The three factory helpers split: cellFactory/optionsFactory are dead as barrel exports (all users — defaultFactories, the test — import relatively) and can be unexported behavior-preservingly; defaultFactories is likewise dead by grep but is the only supported way for a custom-factories config to extend rather than replace the defaults ([...defaultFactories(), mine]) and is referenced by the barrel's own aiui() — recommend keep (if the decision doc prefers strict evidence, it can fall to unexport together with the other two; FactorySpec must stay regardless). The barrel comment "Configs import factory helpers from this one subpath" (index.ts:38) is currently aspirational — no config imports any factory helper — and should be updated to match whatever is decided.

Neither package needs an internal-subpath: lowering-pipeline's siblings are published packages that must use the public entry, and source-processor's only workspace-internal-ish consumers (demos, test-app, pencil lab) use the same contract entry points external apps do. No export met the bar for delete — every dead barrel export has live in-package (relative-import) users, so unexport-from-barrel is the correct maximal action.

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## @habemus-papadum/aiui-pencil + @habemus-papadum/aiui-remote-bar (S4 export-surface audit)

keep: 120 · unexport: 32 · internal-subpath: 0 · delete: 1

**delete:**
- `boundsOf` (packages/aiui-pencil/src/geom.ts:29; dead)

**unexport:**
- `turnAt` (packages/aiui-pencil/src/corners.ts:52; test-only; used by packages/aiui-pencil/src/corners.test.ts (relative import, unaffected by unexport))
- `effectivePressure` (packages/aiui-pencil/src/dabs.ts; test-only; used by packages/aiui-pencil/src/dabs.test.ts (relative import))
- `ramp` (packages/aiui-pencil/src/dabs.ts; test-only; used by packages/aiui-pencil/src/dabs.test.ts, src/filter.test.ts (relative); internal use in src/fade.ts)
- `speedsOf` (packages/aiui-pencil/src/dabs.ts; test-only; used by packages/aiui-pencil/src/dabs.test.ts (relative import))
- `CHARGE_GLOW` (packages/aiui-pencil/src/fade.ts:29; dead)
- `crossfadeStyle` (packages/aiui-pencil/src/fade.ts; dead)
- `FadeStyle` (packages/aiui-pencil/src/fade.ts; dead)
- `FULL_STYLE` (packages/aiui-pencil/src/fade.ts; dead)
- `fadeStyle` (packages/aiui-pencil/src/fade.ts; dead)
- `heat` (packages/aiui-pencil/src/fade.ts; dead)
- `INK_CHARGE` (packages/aiui-pencil/src/fade.ts:24; dead)
- `INK_HOLD` (packages/aiui-pencil/src/fade.ts; dead)
- `isFullStyle` (packages/aiui-pencil/src/fade.ts; dead)
- `OneEuro` (packages/aiui-pencil/src/filter.ts; test-only; used by packages/aiui-pencil/src/filter.test.ts (relative import only))
- `PointFilter` (packages/aiui-pencil/src/filter.ts; dead)
- `smoothingAlpha` (packages/aiui-pencil/src/filter.ts; test-only; used by packages/aiui-pencil/src/filter.test.ts (relative import))
- `dist` (packages/aiui-pencil/src/geom.ts; dead)
- `lerp` (packages/aiui-pencil/src/geom.ts; dead)
- `lerpAngle` (packages/aiui-pencil/src/geom.ts; dead)
- `normalizeAngle` (packages/aiui-pencil/src/geom.ts; dead)
- `GrainCache` (packages/aiui-pencil/src/grain.ts; dead)
- `grainTexture` (packages/aiui-pencil/src/grain.ts:124; dead)
- `noiseField` (packages/aiui-pencil/src/grain.ts; test-only; used by packages/aiui-pencil/src/grain.test.ts (relative import))
- `DEFAULT_LIVE_HZ` (packages/aiui-pencil/src/reactive.ts; dead)
- `blendSample` (packages/aiui-pencil/src/spline.ts; dead)
- `catmullRom` (packages/aiui-pencil/src/spline.ts:62; test-only; used by packages/aiui-pencil/src/spline.test.ts (relative); used internally by densify)
- `IDLE_GAP_MS` (packages/aiui-pencil/src/telemetry.ts:307; dead)
- `median` (packages/aiui-pencil/src/telemetry.ts:337; dead)
- `penKind` (packages/aiui-pencil/src/telemetry.ts:119; dead)
- `sphericalFromTilt` (packages/aiui-pencil/src/telemetry.ts; test-only; used by packages/aiui-pencil/src/telemetry.test.ts (relative import))
- `tiltFromSpherical` (packages/aiui-pencil/src/telemetry.ts; test-only; used by packages/aiui-pencil/src/telemetry.test.ts (relative import))
- `varied` (packages/aiui-pencil/src/telemetry.ts; test-only; used by packages/aiui-pencil/src/telemetry.test.ts (relative import))

**Notes:** Method: complete walk of both barrels (aiui-pencil src/index.ts = 115 named exports incl. `name`; aiui-remote-bar src/index.ts = 33 named exports) plus every package.json subpath (`./client`,`./server`,`./sidecar` for pencil; `./server`,`./sidecar` for remote-bar; subpaths reported as units with their member exports enumerated — all members keep). Consumer evidence from exhaustive per-name `git grep -lw` batches plus full import-statement capture of every `from "@habemus-papadum/aiui-pencil"` / `aiui-remote-bar` site in the repo.

Key facts for the decision doc: (1) Both packages are published `--public` but npm currently holds only 0.0.0-reserve.0 placeholders (trust pending), so NO external consumer can exist yet — barrel trims are cheap now and expensive after the first real release. (2) All in-package tests import their modules RELATIVELY (e.g. corners.test.ts -> ./corners; index.test.ts is the one barrel test and touches only kept names), so every proposed unexport is test-safe and behavior-preserving; only `boundsOf` (geom.ts:29) is fully unused code eligible for deletion. (3) The pencil Lab (packages/aiui-pencil/lab, in-package dev rig) imports ~15 names via the package name; those are classified workspace-internal/kept — the packageDoc's tuning-rig story (planStroke keeps every intermediate stage) plausibly makes them intentional surface, so keep rather than internal-subpath. (4) Proposed unexport batch for pencil (30 names): all 9 fade.ts exports, filter internals (OneEuro, PointFilter, smoothingAlpha), geom internals (dist, lerp, lerpAngle, normalizeAngle, boundsOf=delete), all 3 grain exports, spline internals (blendSample, catmullRom), dabs test helpers (effectivePressure, ramp, speedsOf), corners turnAt, reactive DEFAULT_LIVE_HZ, telemetry internals (IDLE_GAP_MS, median, penKind, sphericalFromTilt, tiltFromSpherical, varied) — shrinks the pencil barrel from 115 to 85 names with zero behavior change. (5) remote-bar's surface is tight: every export is contract or referenced by one; no changes proposed. (6) Two hygiene findings: packages/aiui-pencil/lab/vite.config.ts:9 imports remote-bar's backend via a relative cross-package source path ("../../aiui-remote-bar/src/backend") instead of "@habemus-papadum/aiui-remote-bar/server"; and packages/aiui-pencil/docs/getting-started.md:19 is stale scaffold prose importing a nonexistent `greet` export. (7) Retained-type closure was verified: OneEuroConfig (PencilParams.filter, pencil.ts:49), Ramp (pencil.ts:68-86), StrokeContext/NEW_STROKE (resolveParams default, pencil.ts:184), PenKind (PenSample.kind, telemetry.ts:93), Rect/Vec (surface + pipeline signatures), StrokeEnd (surface.ts:414-416), InkEvent/InkState/InkStroke (reactive.ts:39-50), CaptureState (protocol.ts:154), LinkStats (client-session.ts:161), defaultBarUrl/websocketTransport ({@link} defaults in RemoteBarClientOptions, ui/client.ts:84-86).

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## @habemus-papadum/aiui-intent-runtime + @habemus-papadum/aiui-util

keep: 76 · unexport: 4 · internal-subpath: 0 · delete: 7

**delete:**
- `AddErrorOptions` (packages/aiui-intent-runtime/src/index.ts:30 (def errors.ts:64); test-only; used by only packages/aiui-intent-runtime/src/errors.test.ts; intent-client rolled its own toast (src/ui/main.tsx:46-60))
- `IntentError` (packages/aiui-intent-runtime/src/index.ts:30 (def errors.ts:52); test-only; used by only errors.test.ts; no production importer anywhere (git grep '\bIntentError\b' outside pkg → none except archive/))
- `addError` (packages/aiui-intent-runtime/src/index.ts:31 (def errors.ts:78); test-only; used by only errors.test.ts (git grep '\baddError\b' outside pkg → archive/extension-spikes only, retired))
- `dismissError` (packages/aiui-intent-runtime/src/index.ts:31 (def errors.ts:139); test-only; used by only errors.test.ts (git grep '\bdismissError\b' → no non-test hits))
- `ERROR_TOAST_CAP` (packages/aiui-intent-runtime/src/index.ts:31 (def errors.ts:62); test-only; used by only errors.test.ts (git grep '\bERROR_TOAST_CAP\b' → no non-test hits))
- `formatErrorData` (packages/aiui-intent-runtime/src/index.ts:31 (def errors.ts:122); test-only; used by only errors.test.ts (git grep '\bformatErrorData\b' → no non-test hits))
- `FrameChunk` (packages/aiui-intent-runtime/src/index.ts:51 (def protocol.ts:44); dead)

**unexport:**
- `packageFromSource` (packages/aiui-util/src/provenance.ts:54; test-only; used by only packages/aiui-util/src/provenance.test.ts:5; docstring xref provenance.ts:11, none elsewhere: git grep '\bpackageFromSource\b' → provenance.ts + provenance.test.ts only)
- `encodeFrame` (packages/aiui-intent-runtime/src/index.ts:61 (def protocol.ts:114); test-only; used by only protocol.test.ts:9 (cross-check vs channel's decodeFrame); in-module use protocol.ts:287-300; test imports from ./protocol directly, so barrel unexport is safe)
- `encodeJsonPayload` (packages/aiui-intent-runtime/src/index.ts:62 (def protocol.ts:124); test-only; used by only protocol.test.ts:10; in-module use protocol.ts:301)
- `AudioCapture (subpath ./talk)` (packages/aiui-intent-runtime/src/talk.ts:15 (def audio.ts:17); workspace-internal; used by in-package only: talk-lanes.ts:27 (direct module import, not via the ./talk export); not in talk.ts's documented surface (docstring lists createTalk/WorkletPcmSource/SpeechPlayer/mockTranscriber))

**Notes:** Method: enumerated every symbol of both barrels (aiui-intent-runtime/src/index.ts lines 30-65 = 34 symbols; aiui-util/src/index.ts = 5 star-re-exported modules + cacheDir/CacheDirOptions = 22 symbols) and every package.json subpath (intent-runtime: ./locator ./talk ./video ./selection ./instrumentation ./wire ./thread; util: ./web-surface), then git-grepped each name workspace-wide. Convention used: "workspace-internal" lists sibling-package consumers; where the only use is in-package (import of the module directly, never through the export), that is stated in consumers and drives unexport candidacy. Both packages are published --public, and their sibling consumers (aiui CLI, channel, console, pencil, intent-client) are themselves published and resolve the published artifact when installed — so sibling-consumed exports are effectively published contract and get action=keep, not internal-subpath.

Key findings for the decision doc: (1) intent-runtime's errors module is dev-overlay residue — the intent client rolled its own one-line toast (aiui-intent-client/src/ui/main.tsx:46-60); everything except IntentErrorInput (load-bearing for WireDeps/TalkDeps.reportError) is deletable with its test. (2) FrameChunk is the one outright dead export. (3) encodeFrame/encodeJsonPayload are barrel-unexportable (protocol.test.ts imports ./protocol directly); PROTOCOL_VERSION stays — it is cross-checked against the channel's copy, the channel deliberately mirrors the wire types without depending on intent-runtime (channel.ts:51). (4) collectClientMeta/ACTOR_STORAGE_KEY/getInstrumentation are import-dead outside tests but policy-bearing and documented; notably lanes.ts:245 hand-builds the hello meta instead of calling collectClientMeta — an adopt-or-trim decision, not a mechanical one. (5) pageTabRecord has a hard constraint: page-script.ts:668 stringifies it (pageTabRecord.toString()) into the CDP injection, so it must remain self-contained with zero imports; likewise ./locator is bundled into the evaluated page bundle (page-bundle.ts:17) and its types come from the leaf dep aiui-lowering-pipeline. (6) Root-barrel docstring (index.ts:24) advertises "./protocol" as if it were a subpath; protocol symbols actually ride only the root — fix the doc or add the subpath. (7) Dependency-direction conflict with the stated target: aiui-vscode depends on aiui-util today (package.json:91) solely for cacheDir (src/channels.ts:18) — making vscode depend on nothing in-workspace means inlining ~20 lines of cacheDir. (8) intent-client/src/page/jump-mode.ts duplicates intent-runtime's non-exported src/vscode.ts helpers (elementChain/cellChain/jumpTargets/cellSourceLoc) — pre-existing copy, out of this surface but relevant to S4. (9) Minor gap: SpeechPlayerOptions/SpeechAudioElement/SpeechAudioFactory (speech.ts:27-36) are ctor/param types of the kept SpeechPlayer but are NOT re-exported from ./talk — consumers can't name them. (10) aiui-util's ./web-surface subpath split is deliberate (express-typed sidecar plumbing kept out of the node-generic barrel) — keep the split.

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## aiui + aiui-console + aiui-trace-ui + aiui-vscode (S4 export-surface audit)

keep: 39 · unexport: 30 · internal-subpath: 0 · delete: 0

**unexport:**
- `loadAiuiConfig` (packages/aiui/src/index.ts:16 (impl src/util/config.ts); dead)
- `AiuiConfig (type)` (packages/aiui/src/index.ts:16 (impl src/util/config.ts); dead)
- `defaultPreviewUrl` (packages/aiui-trace-ui/src/index.ts:36 (impl src/paths.ts:23); dead)
- `DEBUG_UI_CSS` (packages/aiui-trace-ui/src/index.ts:39 (impl src/styles.ts); dead)
- `injectDebugUiStyles` (packages/aiui-trace-ui/src/index.ts:39 (impl src/styles.ts); dead)
- `inSession` (packages/aiui-trace-ui/src/index.ts:70 (impl src/traces-pane.ts:93); test-only; used by src/traces-pane.test.ts:3 (relative import — the barrel entry itself has zero importers); its own docstring says 'exported for tests')
- `traceRowParts` (packages/aiui-trace-ui/src/index.ts:70 (impl src/traces-pane.ts:59); test-only; used by src/traces-pane.test.ts:3 (relative import); docstring: 'exported for tests')
- `buildCards` (packages/aiui-trace-ui/src/index.ts:53 (impl src/trace-cards.ts); dead)
- `cardVisible` (packages/aiui-trace-ui/src/index.ts:54; dead)
- `classifyStage` (packages/aiui-trace-ui/src/index.ts:55; test-only; used by src/trace-cards.test.ts:7 and ~40 assertion sites (relative import); internal self-use src/trace-cards.ts:458; NOT imported by trace-view; mentioned only in a proposal doc (docs/proposals/sent-prompt-spans-trace-recording.md))
- `correctionLines` (packages/aiui-trace-ui/src/index.ts:56; dead)
- `eventTypesSummary` (packages/aiui-trace-ui/src/index.ts:57; dead)
- `heroPrompt` (packages/aiui-trace-ui/src/index.ts:58; dead)
- `liveOpenLine` (packages/aiui-trace-ui/src/index.ts:59; dead)
- `liveResolvedSummary` (packages/aiui-trace-ui/src/index.ts:60; dead)
- `liveToolSegments` (packages/aiui-trace-ui/src/index.ts:61; dead)
- `loweredPromptText` (packages/aiui-trace-ui/src/index.ts:62; test-only; used by src/trace-cards.test.ts:22,400-404 (relative import); internal self-use src/trace-cards.ts:541,665; NOT imported by trace-view)
- `parsePatchLines` (packages/aiui-trace-ui/src/index.ts:63; dead)
- `savedFrameFiles` (packages/aiui-trace-ui/src/index.ts:64; dead)
- `traceOutcome` (packages/aiui-trace-ui/src/index.ts:65; dead)
- `CardCategory (type)` (packages/aiui-trace-ui/src/index.ts:41; dead)
- `CardDirection (type)` (packages/aiui-trace-ui/src/index.ts:42; dead)
- `HeroPrompt (type)` (packages/aiui-trace-ui/src/index.ts:43; dead)
- `LiveSegment (type)` (packages/aiui-trace-ui/src/index.ts:44; dead)
- `PatchLine (type)` (packages/aiui-trace-ui/src/index.ts:45; dead)
- `PatchLineKind (type)` (packages/aiui-trace-ui/src/index.ts:46; dead)
- `StageClass (type)` (packages/aiui-trace-ui/src/index.ts:47; dead)
- `TraceCard (type)` (packages/aiui-trace-ui/src/index.ts:48; dead)
- `TraceOutcome (type)` (packages/aiui-trace-ui/src/index.ts:49; dead)
- `TraceState (type)` (packages/aiui-trace-ui/src/index.ts:50; dead)

**Notes:** Scope: every named export of the four barrels plus every package.json subpath export, each verified by git grep over tracked files. Subpath inventory: aiui exports only "." (its real contract is the bin — "aiui": "./dist/cli.js", packages/aiui/package.json:21-23 — which is not an export-map entry and is untouched by any proposal here); aiui-console exports "." and "./sidecar" (both mirrored in publishConfig with a default condition); aiui-trace-ui and aiui-vscode export only ".".

Headline findings. (1) packages/aiui's library surface is vestigial: loadAiuiConfig/AiuiConfig were exported for the retired workbench supervisor (git log -S shows commit ff7ab5d as the only ever external importer); today zero files import 'from "@habemus-papadum/aiui"'. Unexporting them shrinks the published surface to the `name` smoke-test constant, which matches reality: the package is a CLI, consumed via its bin (create-aiui template depends on it as a devDependency solely for the bin). The barrel docstring's "sibling supervisors" rationale is stale and should be rewritten or the export dropped. Behavior-preserving: all CLI code reaches config via relative ../util/config imports. (2) aiui-trace-ui's barrel is the big cleanup: 42 entries, of which 25 are unexport candidates — the entire trace-cards.ts re-export block (13 functions + 10 types, all consumed only via in-package relative imports by trace-view.ts and trace-cards.test.ts; the barrel doc itself describes trace-cards as "the pure classification/coalescing under" TraceView), plus inSession/traceRowParts (docstring: "exported for tests"; the tests import relatively, so even they don't need the barrel), defaultPreviewUrl, DEBUG_UI_CSS, and injectDebugUiStyles (every kept component self-injects styles). The kept core is exactly the documented purpose: TraceView, TracesPane, mountDebugPage + option types, plus the companion data layer (LiveTrace/TraceStageLike/PreviewUrl, createTracePoll+types, renderJsonTree+options) without which a standalone TraceView embedding is impossible. Note trace-ui's real consumers are siblings via the bare specifier (aiui-console/app/main.tsx:13, aiui-intent-client/src/ui/trace-pane.tsx:24), so the runtime `dependencies` edge from aiui-console (flagged "nothing imports it" in archive/code-review-pass1 B7) IS exercised — by the app build, dev-mode Vite middleware, and typechecking, though not by dist/sidecar.js; the archive note is about the sidecar entry only. (3) aiui-console's root barrel "." has zero importers — the one consumer (the channel, standard-sidecars.ts:26) uses the "./sidecar" subpath, which is genuine installed-artifact contract (the very subpath whose missing "default" condition PR #1 caught, and which scripts/packaging-test.mjs:186-194 guards). Recommend keeping the root re-export as the package's documented face (zero cost) rather than churning it; CONSOLE_PREFIX has no importers anywhere (the console app deliberately duplicates the string, app/routes.ts:6-12) but is a one-line mount-point-documenting constant — keep. (4) aiui-vscode's whole `export *` surface stays: it has no in-workspace consumers by design (matches the stated dependency constraint that vscode depends on nothing in-workspace beyond aiui-util), but the npm artifact's documented purpose is external consumption — README "The npm package" section ships a code sample using listChannels/fetchPeers/publishSelection/selectionToContribution, and docs/proposals/macos_intent_app_design.md:249-253 plans to import channels.ts/agents.ts/contribution.ts. Test-only/dead-but-doc-referenced helpers (parseAgentNames, channelLabel, registryDir, isProcessAlive, selectionLoc, selectionLineCount) are kept as the injectable defaults and pure cores of that library; channelLabel is the weakest keep. If any are unexported, the three `export *` lines (src/index.ts:14-16) must first become named export lists — flagging that as the mechanical prerequisite. Caveats for the decision doc: all four packages are published (0.6.0, lockstep versioning), so every "unexport" is a semver-visible surface reduction even though no runtime behavior changes and no current importer breaks — grep evidence above shows zero breakage in-repo. Stale-doc finding: CLAUDE.md:112 still cites packages/aiui-trace-ui/src/vite.ts as the subpath-exports example, but that file and the ./vite subpath no longer exist (git ls-files packages/aiui-trace-ui confirms) — the doc needs a new example (aiui-console's ./sidecar fits).

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:
