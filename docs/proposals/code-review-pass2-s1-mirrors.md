# Code review, pass 2 — S1: mirror & twin contracts

**Status: decision document — awaiting markup.** Produced by the pass-2 catalog run
(24 finders/planners + adversarial verification of every delete/unexport and
importable/collapsible claim; full structured data in
`docs/proposals/review-pass2.local/catalog.json`). Nothing here has been changed yet;
mark the response blocks and the approved items become the implementation plan.

Every restated shape/logic/constant held in sync by comments, classified by what should
happen to it. Verification tried to refute each importable/collapsible claim (dependency
cycles, constraints still live); adjusted verdicts are annotated inline.

---

## importable-now (8)

### PageTabRecord ↔ TabRecord — the canonical tab record, restated field-for-field in the runtime (adjacent mirror: runtime ↔ lowering-pipeline, not channel, but same wire-shapes family)

- A: `packages/aiui-lowering-pipeline/src/types.ts:145-164 (TabRecord: url/title?/aiui?/sourceRoot?/chromeTabId?/windowId?/tabIndex?/targetId?/driverTab?)`
- B: `packages/aiui-intent-runtime/src/instrumentation.ts:31-41 (PageTabRecord — identical field set; comment at :26-29: 'structural mirror … kept import-free so pageTabRecord stays standalone; the types are asserted compatible where the client hands the record to the engine' — note NO explicit assertion actually exists; compatibility is only implicit structural typing at the intent-client call sites, e.g. ext/content.ts:401)`
- kind: type
- constraint: The stringification constraint binds the FUNCTION, not the type: pageTabRecord's body must reference nothing (it is injected via `pageTabRecord.toString()` — intent-client cdp/page-script.ts:663-668) — but a type-only import erases at compile time and leaves the stringified body untouched. The runtime already prod-depends on lowering-pipeline (wire.ts:19-23), so the import is legal today.
- **proposal:** Replace the interface with `import type { TabRecord } from "@habemus-papadum/aiui-lowering-pipeline"; export type PageTabRecord = TabRecord;` keeping the export name for consumers (intent-client transport.ts:15, page-script.ts:26). Keep the SELF-CONTAINED-BY-CONTRACT comment on the function and add one sentence noting the type alias is erased and does not endanger stringification. Also correct the stale 'asserted compatible' claim.

### Driver-liveness watchdog: session-change soft reset vs. silence hard clean, stall-skip round, check cadence — plus two hand-copied constants (DRIVER_TIMEOUT_MS 2500, DRIVER_CHECK_MS 833 = max(250, timeout/3))

- A: `packages/aiui-intent-client/src/page/driver-watch.ts:47-93 (createDriverWatch; consumed by content.ts:312-324 with transport.ts:52's DRIVER_TIMEOUT_MS)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:429-479 (inline twin; constants hand-copied at :437-438 with 'aligned' comments; driver-watch.ts:27-29 points back)`
- kind: logic
- constraint: stringification — but driver-watch.ts is ALREADY import-free and self-contained, so the constraint is satisfied by the existing buildPageScript stringify-argument pattern today; only history keeps the inline copy
- **proposal:** buildPageScript imports createDriverWatch and DRIVER_TIMEOUT_MS (module scope of page-script.ts is a normal module — it already imports pageTabRecord at :25-28) and passes `(${createDriverWatch.toString()})` plus the numeric timeout as arguments to pageBootstrap, folding their source into the fingerprint. This deletes both hand-copied constants (if transport.ts:52 is ever retuned, page-script's 2500/833 currently drift silently — the exact failure the 7000→2500 tightening of 2026-07-17 risked). Bonus: it erases a latent twin divergence — the inline copy ignores empty-string sessions (page-script.ts:451) while createDriverWatch treats '' as a session (driver-watch.ts:58-63), and content.ts:329-343 can produce '' via String(...) — one implementation, one rule.

### The linter transcript-wait constant: LINTER_TRANSCRIPT_WAIT_MS = 2500 restating the sidecar's TRANSCRIPT_WAIT_MS = 2500

- A: `packages/aiui-intent-client/src/linter-pulse.ts:32-33 ('Mirrors the sidecar's TRANSCRIPT_WAIT_MS … keep aligned')`
- B: `packages/aiui-claude-channel/src/linter-sidecar.ts:50`
- kind: constant
- constraint: dependency direction: the intent client may not depend on the channel (client depends on runtime + lowering + viz; channel depends on lowering) — so a direct import is forbidden
- **proposal:** Both packages already depend on aiui-lowering-pipeline (linter-pulse.ts:29 imports IntentEvent from it), and the constant is part of the intent-protocol timing contract, not a sidecar implementation detail. Move TRANSCRIPT_WAIT_MS into aiui-lowering-pipeline next to the IntentEvent vocabulary; linter-sidecar.ts re-exports for its tests, linter-pulse.ts imports it. If relocation is judged wrong-altitude, fall back to guarded: a channel-package test (channel may take intent-client as a devDependency without a cycle) asserting the two exports are equal.

### ToolsRegistry structural type + the tools watch/report machinery (descriptor mapping, watch-once + 2000ms poll-until-registry-appears)

- A: `packages/aiui-intent-client/src/ext/content-main.ts:27-34 (interface ToolsRegistry), :43-83 (reportTools/watch/poll)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:300-352 (type ToolsRegistry restated, reportTools/watchTools/toolsPoll)`
- kind: type
- constraint: the type is restated only out of caution — type-only imports ERASE and are already used inside page-script.ts (PageTabRecord, :25-28), so nothing blocks sharing the type today; the runtime logic is fused with host-specific concerns (page-script's poll also runs the saidAiui late-instrumentation re-hello, :338-352, which content-main handles via aiuiInstrumented postMessage instead)
- **proposal:** Hoist ToolsRegistry (and the descriptor-mapping result shape) into one shared module — natural home: next to PageReport in cdp/page-script.ts or a small cdp/tools-types.ts — and type-import it in both files; delete the restatement. Leave the watch/poll runtime logic duplicated for now (the two polls carry different second jobs), or fold just the pure descriptor-mapping expression (page-script.ts:315-325 = content-main.ts:48-60) into a stringifiable helper later.

### Registry entry shape: ChannelEntry vs RegistryEntry (tag/pid/ppid/port/cwd/startedAt/name?/debug?)

- A: `packages/aiui-vscode/src/channels.ts:23-44 (ChannelEntry)`
- B: `packages/aiui-claude-channel/src/registry.ts:20-55 (RegistryEntry)`
- kind: type
- constraint: channels.ts:6-8 states it: the VSIX bundle must not drag the whole channel package in (channel prod-deps include express, ws, MCP SDK, and the entire intent-client subtree per packages/aiui-claude-channel/package.json)
- **proposal:** Hoist the registry READ side (entry type + readEntry + isProcessAlive + registryDir) into @habemus-papadum/aiui-util, which already owns the cache-path convention (cacheDir, packages/aiui-util/src) and is already a production dep of BOTH sides (vscode channels.ts:18; channel registry.ts:14). Channel re-exports from registry.ts for compat; vscode imports instead of mirroring. No new dependency edge anywhere. Fallback if aiui-util must not grow: guarded via a type-only devDep test (see next entries).

### Registry read logic: readEntry loose-validator and isProcessAlive (EPERM-means-alive) duplicated near-verbatim

- A: `packages/aiui-vscode/src/channels.ts:84-115 (readEntry), :118-128 (isProcessAlive), :79-81 (registryDir)`
- B: `packages/aiui-claude-channel/src/registry.ts:129-167 (readEntry), :95-105 (isProcessAlive), :78-80 (registryDir)`
- kind: logic
- constraint: same bundle constraint as the entry type; also vscode's read path is deliberately non-destructive (never prunes) while the channel's listMcpServers prunes — but readEntry/isProcessAlive themselves are behaviorally identical
- **proposal:** Same hoist as the entry shape: move readEntry/isProcessAlive/registryDir into aiui-util as the shared read-side module. The pruning-vs-skipping policy difference lives in the callers (vscode listChannels channels.ts:158-176 vs channel listMcpServers) and stays where it is — only the per-file validator and liveness probe collapse. Behavior-preserving: the two validators accept/reject identical inputs today.

### PageTabRecord — field-for-field identical restatement of the lowering pipeline's TabRecord (9 fields, same optionality, same docs)

- A: `packages/aiui-intent-runtime/src/instrumentation.ts:31-41 (PageTabRecord)`
- B: `packages/aiui-lowering-pipeline/src/types.ts:145-164 (TabRecord)`
- kind: type
- constraint: instrumentation.ts:27-28 claims 'kept import-free so pageTabRecord stays standalone' — but that conflates value and type imports: only the FUNCTION BODY is stringified (page-script.ts:668 stringifies the transpiled function, types already erased), and aiui-lowering-pipeline is intent-runtime's ONE existing production dependency (package.json)
- **proposal:** Replace the interface with `import type { TabRecord } from '@habemus-papadum/aiui-lowering-pipeline'; export type PageTabRecord = TabRecord;` (keep the export name for consumers like transport.ts:15). Behavior-preserving: shapes are character-identical today, the stringified pageTabRecord body is untouched, and the current implicit guard (lanes.ts:320 passing event.tabRecord into engine.navigation's `tab?: TabRecord` parameter) — which misses TabRecord gaining an optional field — becomes unnecessary.

### The __AIUI__.tools registry shape (list/call/onChange, descriptor rows) restated by both intent-client bridges — and a fourth statement of the descriptor row in the channel

- A: `packages/aiui-viz/src/aiui-global.ts:19-35 (AiuiPageTool, AiuiToolsRegistry — the owner)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:300-307 (local ToolsRegistry inside the stringified bootstrap); packages/aiui-intent-client/src/ext/content-main.ts:27-34 (ToolsRegistry); packages/aiui-claude-channel/src/page-tools.ts:31-37 (PageToolDescriptor)`
- kind: type
- constraint: the CDP bootstrap is stringified for injection and its BODY may import nothing — but the local `type ToolsRegistry` is erased before stringification, so the constraint does not actually bind the type; intent-client prod-deps aiui-viz already. The channel's PageToolDescriptor is different: channel has no viz edge and the sanctioned graph gives it none
- **proposal:** In both intent-client files, replace the local restatement with `import type { AiuiToolsRegistry } from '@habemus-papadum/aiui-viz'` (module-level type-only import; erased by transpilation before page-script.ts:668's .toString(), and content-main.ts already imports ../page/jump-mode so it is a normal bundled module). The read sites only narrow (they never send `run`), and AiuiToolsRegistry is assignable wherever the narrowed local type was used. The channel's PageToolDescriptor stays a restatement (no channel→viz edge) — guard it instead: intent-client's tools-link tests already speak to the channel devDep and can assert the descriptor mapping `{name, description, inputSchema?}` satisfies PageToolDescriptor.

**Response for this group:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## collapsible (7)

### The control-chunk grammar — the literal control name "linter" and its value vocabulary "off"|"openai"|"gemini", restated at the client send site, the server parse site, and the frame doc, while a canonical union already exists in the shared leaf

- A: `packages/aiui-claude-channel/src/intent-v1.ts:1202-1210 (onControlChunk: `decoded.control !== "linter"`, `value === "off" || value === "openai" || value === "gemini"`), restated again at intent-v1.ts:229 and :777, plus the doc at frame.ts:102-106`
- B: `packages/aiui-intent-runtime/src/wire.ts:85 and :258-266 (`sendControl(control: "linter", value: string)` — value UNTYPED string on the sending side)`
- kind: constant
- constraint: None that forces restatement — this one has a legal single source TODAY: aiui-lowering-pipeline/src/config.ts:136 already declares `linter?: "off" | "openai" | "gemini"`, and both the channel (intent-v1.ts:56-63) and the runtime (wire.ts:19-23) prod-import that package.
- **proposal:** Export `type LinterVendor = NonNullable<IntentPipelineConfig["linter"]>` from aiui-lowering-pipeline; use it for ResolvedIntent.linter (intent-v1.ts:229), buildLinter's parameter (:777), and tighten sendControl's `value: string` to LinterVendor (wire.ts:85). Keep onControlChunk's runtime literal checks (untrusted wire data must still be revalidated) but derive them from a `const LINTER_VENDORS = [...] satisfies readonly LinterVendor[]` so the compiler ties the check list to the union. Behavior-preserving; adding a vendor becomes a one-site change.

### ResolvedIntent's field vocabularies — transcriber/audioBack/linter/realtimeDelay unions restated verbatim from IntentPipelineConfig, which the hello's meta.intent carries over the wire

- A: `packages/aiui-claude-channel/src/intent-v1.ts:197-239 (ResolvedIntent: transcriber union at :212 ≡ config.ts:63; audioBack at :221 ≡ config.ts:96; linter at :229 ≡ config.ts:136; realtimeDelay WIDENED to `string | undefined` at :219 vs the 5-literal union at config.ts:83)`
- B: `packages/aiui-lowering-pipeline/src/config.ts:63, :83, :96, :136 (IntentPipelineConfig — the type the runtime client sends as meta.intent, OpenThreadOptions in intent-types.ts:29-36)`
- kind: type
- constraint: None — the channel already prod-imports aiui-lowering-pipeline (intent-v1.ts:56-63 pulls DEFAULT_INTENT_CONFIG, expandTier from it). ResolvedIntent is a deliberate re-validation of untrusted hello data, but its FIELD TYPES can be sourced without weakening that.
- **proposal:** Replace the copied literal unions with indexed-access types: `transcriber: IntentPipelineConfig["transcriber"]`, `audioBack: NonNullable<IntentPipelineConfig["audioBack"]>`, `linter: NonNullable<IntentPipelineConfig["linter"]>`. Leave realtimeDelay's widening to `string` alone only if it is deliberate (resolveIntent passes vendor strings through) — otherwise it is a fourth drift candidate; the decision doc should rule on it. Pure type refactor, zero runtime change.

### Ring indicator + flash wash visuals (four ring states, hollow hint bubble, breathe keyframes, exact CSS strings, ids `__aiui-intent-ring`/`-hint`, colors #dc2626/#7c3aed)

- A: `packages/aiui-intent-client/src/ext/content.ts:75-129 (assertRing, flash; header at content.ts:25-27 declares the mirror deliberate)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:109-163 (assertRing, flash inside the stringified pageBootstrap)`
- kind: logic
- constraint: page-script.ts is stringified for injection (buildPageScript, page-script.ts:666-670) and its pageBootstrap body may reference no imported runtime values; content.ts is a normal Vite-bundled module
- **proposal:** The constraint blocks free-variable imports, not sharing: the repo already ships a self-contained function INTO the stringified script as a toString'd argument (pageTabRecord, page-script.ts:662-670). Extract dependency-free factories — e.g. createRingSurface(): {assert}, createFlash(): (kind)=>void — into a new import-free module (say src/page/surfaces.ts, closing over nothing at module scope); content.ts imports them normally, buildPageScript stringifies them in as additional arguments and includes their source in the version fingerprint (which already busts stale installs). Today the two copies are line-for-line identical except content.ts's RING_ID constant, so the collapse is byte-preserving.

### Region rubber-band drag overlay (the `a` area shot): arm/disarm, pointer-capture band math, 4px click-vs-drag threshold, component locating, the no-private-Escape rule

- A: `packages/aiui-intent-client/src/ext/content.ts:160-231 (armRegion/disarmRegion; locate via imported locateComponents, content.ts:31,213)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:354-427 (armRegion/disarmRegion; locate via w.__aiuiIntentPage.locateComponents, page-script.ts:407-409)`
- kind: logic
- constraint: same stringification constraint as the ring; additionally the two sides source locateComponents differently (direct import in the isolated world vs. the bus-evaluated bundle's global in the page world) and report through different sinks
- **proposal:** Same stringify-argument pattern: extract createRegionSurface(deps: { report(r): void; locate?(rect): unknown[] }) as a self-contained factory. content.ts passes its imported locateComponents; pageBootstrap passes the global-reading thunk it already has. Everything else (overlay CSS, rectNow, thresholds, the escOrder comment at content.ts:225-228 / page-script.ts:421-424) is identical today and collapses without behavior change.

### Pencil `{op,…}` dispatch: size/engage/disengage/fade/clear/undo/rbegin/rpoint/rend/rcancel, including the size-is-a-window-fact rule and the strokes-survive-disengage rule

- A: `packages/aiui-intent-client/src/ext/content.ts:418-467 (relay `pencil` handler; mount imported from ../cdp/page-bundle, content.ts:33)`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:203-273 (handlePencil; mount read off w.__aiuiIntentPage.mountPencil delivered by ensureBundle)`
- kind: logic
- constraint: stringification (no imports in pageBootstrap) plus divergent mount acquisition; content.ts:425-426 explicitly points at the CDP twin's size rationale — 'keep the two aligned'
- **proposal:** Extract createPencilOps(getMount: () => (()=>PencilHandle) | undefined) as a self-contained factory returning the op dispatcher (op set, size answer from innerWidth/innerHeight, the ??= mount, the stray-op-after-disengage tolerance). content.ts imports it; buildPageScript stringifies it in. The PencilHandle shape (page-script.ts:206-216) is restated as a local type on the CDP side and imported on the MV3 side — fold it into a shared type-only import, which is safe in the stringified file (types erase; page-script.ts already type-imports PageTabRecord at :25-28).

### Prose capability inventories that disagree with the code: 'ring · flash · keylayer · selection · viewport · pencil · jump · locate' — `locate` is not a served capability anywhere, and the lists omit region, heartbeat, toolsCall (and MV3's driverGone)

- A: `packages/aiui-intent-client/src/cdp/page-script.ts:12 and packages/aiui-intent-client/src/ext/protocol.ts:13-15 (identical stale lists); also the softer list in transport.ts:5-8`
- B: `the code truth: transport.ts:18-41 PageCapability union (keylayer·flash·selection·viewport·region·jump·pencil·toolsCall·heartbeat), plus `ring` deliberately OUTSIDE the union (cdp-bus.ts:248,270 types `PageCapability | "ring"`; extension-bus.ts:128,272) and the MV3-only driverGone verdict (content.ts:350-361)`
- kind: prose-inventory
- constraint: none — prose simply predates the region/jump/tools/heartbeat work; ext/manifest.ts's header carries no inventory (only a reload note at :91), and content-main.ts's three-job list (:9-20) matches its code
- **proposal:** Stop restating the set in prose: both headers should point at `PageCapability` (transport.ts) as the single inventory and mention only their host-specific extras (`ring` rides beside the union as the broadcast-not-request path; `driverGone` is the MV3 worker verdict). While there, decide whether `ring`'s exclusion from the union is still wanted or should become a documented member — today the `PageCapability | "ring"` widening is repeated at two cdp-bus sites.

### TabInfo — the browser-tab correlation-hint record, restated between the runtime and the channel wire

- A: `packages/aiui-intent-runtime/src/instrumentation.ts:99-106 (TabInfo, documented as a 'local mirror of the channel package's TabInfo')`
- B: `packages/aiui-claude-channel/src/frame.ts:40-53 (TabInfo); also session-hub.ts:50 reuses it`
- kind: type
- constraint: runtime (browser) must not prod-depend on the channel (node server; also channel→intent-client→runtime would make prod cycles); but BOTH already prod-depend on aiui-lowering-pipeline, which owns the superset TabRecord
- **proposal:** Define once in aiui-lowering-pipeline next to TabRecord (types.ts:145): `export type TabInfo = Partial<Pick<TabRecord, 'url'|'title'|'chromeTabId'|'windowId'|'tabIndex'|'targetId'>>` — TabInfo is exactly that projection today. Channel frame.ts and runtime instrumentation.ts both import it (channel re-exports for its existing consumers). Both edges already exist (channel prompt-context.ts:17 and runtime package.json), so no new dependency, and the subset relationship to TabRecord becomes compiler-checked instead of prose.

**Response for this group:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## guarded (15)

### PROTOCOL_VERSION — the wire version constant, declared twice as the literal 1

- A: `packages/aiui-claude-channel/src/frame.ts:25 (`export const PROTOCOL_VERSION = 1`)`
- B: `packages/aiui-intent-runtime/src/protocol.ts:17-18 (`/** Must match the channel package's PROTOCOL_VERSION. */`)`
- kind: constant
- constraint: No legal prod import in either direction: the channel is a Node-side package and only a devDependency of the runtime (packages/aiui-intent-runtime/package.json), and the stated dependency graph has no runtime→channel or channel→runtime edge. protocol.ts:1-13 documents the whole client as a deliberate dependency-free reimplementation.
- **proposal:** Keep as two constants with the existing equality test. Nothing to add — a version number either matches or the test fails.
- drift guard: ALREADY EXISTS and is complete for a scalar: packages/aiui-intent-runtime/src/protocol.test.ts:18-20 imports the channel via the devDependency and asserts `expect(PROTOCOL_VERSION).toBe(SERVER_PROTOCOL_VERSION)`.

### ChunkDescriptor — the intent-v1 data-frame payload tag, restated as the JsonChunk/AttachmentChunk/AudioChunk/FrameChunk union

- A: `packages/aiui-claude-channel/src/frame.ts:108-112 (`export type ChunkDescriptor = {kind:"events"} | {kind:"control"} | {kind:"attachment"; id; mime} | {kind:"audio"; id; seq; mime}`)`
- B: `packages/aiui-intent-runtime/src/protocol.ts:41-44 (JsonChunk / AttachmentChunk / AudioChunk / FrameChunk), with the doc comment at :37-39: 'Mirrors ChunkDescriptor in the channel's frame.ts — the source of truth; change both together.'`
- kind: type
- constraint: Same no-prod-import constraint as PROTOCOL_VERSION. An import COULD legally land in a shared leaf: aiui-lowering-pipeline is a prod dependency of both sides (runtime: wire.ts:19-23; channel: intent-v1.ts:56-63) and already hosts shared wire vocabulary (IntentEvent, PromptSpan) — but ChunkDescriptor is framing, not lowering, so moving it there muddies the leaf's charter.
- **proposal:** Keep both declarations (the runtime's split into three named aliases is real API surface — IntentThread's sendChunk/sendAttachment/sendAudio signatures in intent-types.ts use them), and add the one-line type-equality assertion so 'change both together' is compiler-enforced.
- drift guard: Add to packages/aiui-intent-runtime/src/protocol.test.ts (channel types already importable via the devDependency): `expectTypeOf<FrameChunk>().toEqualTypeOf<ChunkDescriptor>()` (vitest's expectTypeOf; branded sub-unions checked by the whole-union equality). Today the existing tests (protocol.test.ts:77-115) only verify chunk envelopes survive the channel's decoder at runtime — value pass-through, not type lockstep.

### ChannelErrorMessage ↔ ErrorMessage — the generic server→client error push (kind/threadId/source/message/detail/data)

- A: `packages/aiui-claude-channel/src/channel.ts:54-79 (ChannelErrorMessage; comment at :51-52: 'its ErrorMessage in aiui-intent-runtime/src/protocol.ts mirrors this shape — change both together'), produced by pushError at :86-98`
- B: `packages/aiui-intent-runtime/src/protocol.ts:88-104 (ErrorMessage extends ServerMessage; comment at :78-79: 'Mirrors ChannelErrorMessage … the source of truth; change both together')`
- kind: type
- constraint: No legal prod import (see above). Additionally NOT literally identical by design: the runtime's ErrorMessage extends ServerMessage (protocol.ts:53-57) and so carries an index signature, because the client also SYNTHESIZES this message locally for transport faults (protocol.ts:261-267) — the type is a client-side narrowing, not just the wire echo.
- **proposal:** Keep both (the extends-ServerMessage difference is load-bearing for the client's synthetic-error path) and add the Pick-equality + keyof-completeness guard.
- drift guard: In protocol.test.ts: `expectTypeOf<Pick<ErrorMessage, "kind"|"threadId"|"source"|"message"|"detail"|"data">>().toEqualTypeOf<Pick<ChannelErrorMessage, "kind"|"threadId"|"source"|"message"|"detail"|"data">>()` plus a completeness check that the channel side grew no unmirrored field: `expectTypeOf<Exclude<keyof ChannelErrorMessage, "kind"|"threadId"|"source"|"message"|"detail"|"data">>().toEqualTypeOf<never>()`. The existing test at protocol.test.ts:134-159 exercises one error push at runtime but locks nothing at the type level.

### TabInfo — the hello's browser-tab record, declared twice under the same name

- A: `packages/aiui-claude-channel/src/frame.ts:40-53 (TabInfo: url/title/chromeTabId/windowId/tabIndex/targetId, all optional)`
- B: `packages/aiui-intent-runtime/src/instrumentation.ts:99-106 (TabInfo; comment at :95-97: 'local mirror of the channel package's TabInfo (this package stays dependency-free; protocol.test.ts cross-checks the shape against the channel's decoder)')`
- kind: type
- constraint: No legal prod import; instrumentation.ts additionally advertises itself as dependency-free (it is the './instrumentation' subpath the extension content script consumes standalone). NOTE: the comment at :96-97 overstates the existing guard — protocol.test.ts:57-66 only checks that one sample meta VALUE survives the channel decoder; no type-level cross-check exists.
- **proposal:** Keep both, add the equality assertion, and fix the instrumentation.ts:96-97 comment to name the actual guard once it exists.
- drift guard: In protocol.test.ts: `expectTypeOf<import("./instrumentation").TabInfo>().toEqualTypeOf<import("@habemus-papadum/aiui-claude-channel").TabInfo>()` (aliased imports; exact equality is correct here — the field sets are identical today).

### HelloMeta ↔ ClientMeta — the optional client context riding the hello envelope (tab/source/actor/intent)

- A: `packages/aiui-claude-channel/src/frame.ts:62-81 (HelloMeta: tab?, source?: SourceInfo, actor?, intent?: unknown; SourceInfo at :56-59)`
- B: `packages/aiui-intent-runtime/src/instrumentation.ts:108-126 (ClientMeta: tab?, source?: { root?: string } inline, intent?: Record<string, unknown>, actor?; comment at :108: 'mirror of HelloMeta')`
- kind: type
- constraint: No legal prod import. Deliberately NOT equal: ClientMeta narrows intent to Record<string,unknown> (the client always sends an object) where HelloMeta keeps it `unknown` (the server trusts nothing and revalidates — frame.ts:74-80). So the guard must be one-directional assignability, not equality.
- **proposal:** Keep both with the assignability guard. If the two ever need to converge exactly, the legal collapse is a shared decl in aiui-lowering-pipeline — but the unknown-vs-Record asymmetry is a feature (trust boundary), so guarded restatement fits better.
- drift guard: In protocol.test.ts: `expectTypeOf<ClientMeta>().toMatchTypeOf<HelloMeta>()` — every hello the runtime can construct satisfies the server's declared envelope. (Equality would be wrong; narrowing on the client side is by design.)

### LoweredPromptMessage twins — the fin-time push of the final composed prompt. DRIFT ALREADY PRESENT: the channel side carries `spans?: PromptSpan[]` (added for hover-preview rendering); the runtime twin lacks it, so a consumer narrowing to the runtime type loses the typed field the channel doc promises.

- A: `packages/aiui-claude-channel/src/intent-v1.ts:114-128 (kind/threadId/prompt/spans?/meta?; spans doc at :119-125), pushed at :1370-1375`
- B: `packages/aiui-intent-runtime/src/protocol.ts:67-72 (kind/threadId/prompt/meta? — no spans), consumed only for narrowing (wire.ts:352-356 deliberately ignores it; hosts observe via onSocket)`
- kind: type
- constraint: No prod import of the channel — but the missing piece is importable TODAY: PromptSpan is exported by aiui-lowering-pipeline (packages/aiui-lowering-pipeline/src/index.ts:34), which the runtime already prod-depends on (wire.ts:19-23). Only the message envelope itself has no legal shared home outside lowering.
- **proposal:** Behavior-preserving repair + guard: add `spans?: PromptSpan[]` (type-only import from @habemus-papadum/aiui-lowering-pipeline) to protocol.ts's LoweredPromptMessage, then add the Pick-equality + completeness assertions. This is the catalog's strongest evidence that comment-only mirrors drift: the spans field shipped on one side only.
- drift guard: After the fix, in protocol.test.ts: `expectTypeOf<Pick<ClientLoweredPromptMessage, "kind"|"threadId"|"prompt"|"spans"|"meta">>().toEqualTypeOf<Pick<ChannelLoweredPromptMessage, ...same>>()` plus the keyof-completeness check (`Exclude<keyof ChannelLoweredPromptMessage, ...> extends never`) so the next additive server field (this is how spans slipped) breaks the build instead of silently under-typing the client.

### Ack ↔ ChannelResponse — the per-frame server reply. Minor drift: the channel's `debug?: boolean` hello-ack flag (channel.ts:181-187) is absent from the runtime's Ack; currently benign (nothing in the runtime reads it — the intent client's debug badge comes from the registry, packages/aiui-intent-client/src/ext/channel.ts:85, not the ack) but the typed surface under-reports the wire.

- A: `packages/aiui-claude-channel/src/channel.ts:170-188 (ChannelResponse: ok/threadId?/closed?/error?/fatal?/debug?)`
- B: `packages/aiui-intent-runtime/src/protocol.ts:21-27 (Ack: ok/threadId?/closed?/error?/fatal?)`
- kind: type
- constraint: No legal prod import; the runtime also fabricates Acks locally for transport failures (protocol.ts:212, :275), so the type is not purely a wire echo.
- **proposal:** Add the missing optional field (pure type change, no behavior) and lock the pair with the completeness assertion.
- drift guard: Add `debug?: boolean` to Ack, then in protocol.test.ts: Pick-equality over all six keys plus the keyof-completeness check `expectTypeOf<Exclude<keyof ChannelResponse, keyof Ack>>().toEqualTypeOf<never>()` — the completeness half is the part that would have caught `debug`.

### SpeechMessage ↔ SpeechClip — the pushed audio clip. The runtime has no envelope twin; wire.ts hand-validates the push field-by-field (typeof checks) and maps it into SpeechClip, which restates the {id, mime, data, label?} payload subset.

- A: `packages/aiui-claude-channel/src/intent-v1.ts:137-149 (SpeechMessage: kind/threadId/id/mime/data/label?)`
- B: `packages/aiui-intent-runtime/src/speech.ts:16-24 (SpeechClip: id/mime/data/label?) + the structural revalidation and mapping at src/wire.ts:333-350`
- kind: type
- constraint: No legal prod import. The structural typeof-revalidation in wire.ts is deliberate wire hygiene (server pushes are untrusted at the type level), so a shared type would not remove that code — only pin the shape it checks against.
- **proposal:** Keep the hand-validation (it is the runtime's trust boundary) and add the Pick-equality assertion so a server-side field change surfaces at typecheck.
- drift guard: In protocol.test.ts (or a wire.test): `expectTypeOf<Pick<SpeechMessage, "id"|"mime"|"data"|"label">>().toEqualTypeOf<SpeechClip>()` — SpeechClip is exactly the payload subset today, so Pick-equality is the precise invariant.

### The 24 kHz PCM contract — the client's capture rate (and the `audio/pcm;rate=24000` mime it stamps on every audio chunk) vs. the channel's independently hard-coded 24 kHz constants; the server never parses the mime's rate, it assumes it

- A: `packages/aiui-intent-runtime/src/audio.ts:115-117 (REALTIME_PCM_RATE = 24000, REALTIME_PCM_MIME = `audio/pcm;rate=${REALTIME_PCM_RATE}`), sent on the wire at wire.ts:248`
- B: `packages/aiui-claude-channel/src/pcm.ts:11 (REALTIME_VOICE_RATE = 24000, exported from index.ts:139), intent-v1.ts:166-167 (REALTIME_PCM_BYTES_PER_MS = 48, i.e. 24000×2/1000), elevenlabs-realtime.ts:165-169 (ELEVENLABS_SAMPLE_RATE = 24000, BYTES_PER_MS), realtime.ts:645 (`rate: 24000` in the OpenAI session config), gemini-live.ts:25-27/72`
- kind: constant
- constraint: No legal prod import in either direction, and the value is genuinely load-bearing on both sides independently (client resampler target, server commit-floor math and upstream session configs). Changing the client rate today silently corrupts every server duration computation — nothing cross-checks.
- **proposal:** Guard rather than collapse: the rate has no natural shared home (lowering-pipeline has no audio charter), and a longer-term behavior-preserving hardening — the server deriving bytes/ms by parsing `rate=` off the audio chunk's mime with a 24000 fallback — changes the trust seam and belongs in a separate decision.
- drift guard: In packages/aiui-intent-runtime/src/protocol.test.ts (channel importable via devDependency, REALTIME_VOICE_RATE already exported): `expect(REALTIME_PCM_MIME).toBe(`audio/pcm;rate=${REALTIME_VOICE_RATE}`)` and `expect(REALTIME_PCM_RATE).toBe(REALTIME_VOICE_RATE)`. Channel-side, one local test tying its own copies together: REALTIME_PCM_BYTES_PER_MS === (REALTIME_VOICE_RATE*2)/1000 and ELEVENLABS_SAMPLE_RATE === REALTIME_VOICE_RATE.

### In-turn wholesale key layer: chord exemption (meta/ctrl/alt stay the browser's), capture-phase down/up forwarding as `key` reports

- A: `packages/aiui-intent-client/src/ext/content.ts:131-158 (window listeners, event.stopImmediatePropagation())`
- B: `packages/aiui-intent-client/src/cdp/page-script.ts:165-192 (document listeners, event.stopPropagation())`
- kind: logic
- constraint: stringification as above, PLUS a real semantic divergence: window-vs-document capture target and stopImmediatePropagation-vs-stopPropagation. The stronger swallow on the MV3 side plausibly exists because an isolated-world script must beat the page's own same-node capture listeners; nothing in either file documents this, so collapsing blind could change which keys the page still sees on one tier
- **proposal:** Do not collapse until the divergence is ruled deliberate or accidental by the owner. If deliberate, parameterize a shared factory by (target, stopFn) with a comment carrying the why; if accidental, converge on one behavior first (a behavior change, out of scope for this pass) and then collapse via the stringify-argument pattern.
- drift guard: A jsdom parity test: evaluate buildPageScript()'s output in jsdom with a stubbed __aiuiIntentReport, import content.ts's setKeyCapture path via its relay handler, drive identical KeyboardEvent sequences (plain key, repeat, meta-chord) through both, and assert identical report streams and identical defaultPrevented — the test pins today's shared surface while leaving the documented listener-target difference as an explicit exclusion.

### Session HTTP surface types: SessionPeer/PeersResponse/PublishResult vs SessionPeerInfo + the UNNAMED inline JSON the channel actually serves

- A: `packages/aiui-vscode/src/channels.ts:46-76 (SessionPeer, PeersResponse, PublishResult)`
- B: `packages/aiui-claude-channel/src/session-hub.ts:40-51 (SessionPeerInfo); packages/aiui-claude-channel/src/web.ts:286 and :292,:308,:311 (inline response literals — the channel never names these response shapes)`
- kind: type
- constraint: vscode bundle must not import the channel at runtime; additionally the contract's server side exists only as express handler literals, so today there is nothing importable even in principle
- **proposal:** Keep the mirror (the bundle constraint is real) but close the gap where the server side is anonymous: named response types in the channel + a compile-time assignability test in vscode. The existing channels.test.ts (fake HTTP server, packages/aiui-vscode/src/channels.test.ts) only tests vscode's own assumption, not the channel's behavior.
- drift guard: 1) Name and export PeersResponse/PublishResult in the channel next to SessionHub (pure type extraction from web.ts's literals, behavior-preserving). 2) Add aiui-claude-channel as a devDependency of aiui-vscode and a type-only drift test in channels.test.ts: `const _peer: import('@habemus-papadum/aiui-claude-channel').SessionPeerInfo = {} as SessionPeer` in both directions (modulo tab: TabInfo vs Record<string,unknown> — assert the channel type assignable to the vscode type), plus mutual assignability for the two response types. Type-only imports never reach the esbuild VSIX bundle.

### Session-bus contribution contract: SESSION_CONTRIBUTION_TOPIC constant + ContributedSelection (reader) vs SelectionContribution (writer, source of truth)

- A: `packages/aiui-intent-client/src/session.ts:78 (topic restated), :81-111 (ContributedSelection, asContributedSelection)`
- B: `packages/aiui-vscode/src/contribution.ts:19 (SESSION_CONTRIBUTION_TOPIC), :25-37 (SelectionContribution), :74-83 (selectionToContribution)`
- kind: constant
- constraint: session.ts:73-77 says it: restated so the client takes no dependency on the extension package; no shared prod-dep home exists on the sanctioned graph (client deps runtime+lowering+viz; vscode deps only aiui-util)
- **proposal:** Keep the restatement (dependency direction forbids the import; hoisting a two-party wire contract into aiui-util is possible — both sides prod-dep it — but scatters the bus vocabulary away from its owner). Add the cross-package round-trip drift test; today NOTHING checks the two files agree.
- drift guard: Add @habemus-papadum/aiui-vscode as a devDependency of aiui-intent-client (it publishes a host-free pure library — index.ts:14-16 exports contribution.ts, which is deliberately vscode-module-free per its header) and a round-trip test in session.test.ts: `asContributedSelection({ topic: VSCODE_TOPIC, payload: selectionToContribution(editorSel, url) })` must yield the selection with sourceLoc/url/lines intact, plus `expect(SESSION_CONTRIBUTION_TOPIC).toBe(VSCODE_TOPIC)`. That guards the constant, the payload shape, and the kind-discriminant in one behavioral test.

### Session-bus frame shapes: BusPeer/BusPublish/reduceBusMessage/asBusPublish restating the hub's SessionServerMessage/SessionPeerInfo

- A: `packages/aiui-intent-client/src/session.ts:15-17 (declared mirror), :20-70 (BusPeer, reduceBusMessage), :115-128 (asBusPublish)`
- B: `packages/aiui-claude-channel/src/session-hub.ts:61-77 (SessionClientMessage, SessionServerMessage), :40-51 (SessionPeerInfo)`
- kind: type
- constraint: cannot be a prod import: the channel production-depends on aiui-intent-client (package.json — the sidecar serving), so client→channel at runtime would be a cycle; the mirror is the cycle-breaker
- **proposal:** Keep the mirror (cycle-forced), add the typed-frame drift test using the devDep that already exists. Zero new edges, closes the currently unguarded gap the file's own comment ('mirrors the channel's session hub') admits to.
- drift guard: aiui-claude-channel is ALREADY a devDependency of aiui-intent-client (package.json), yet session.test.ts imports nothing from it. Add to session.test.ts: (1) type assertions `const _p: BusPeer = {} as SessionPeerInfo` and construct the snapshot/set/peers/publish frames as `SessionServerMessage` literals, then feed exactly those values through reduceBusMessage/asBusPublish and assert the reduced state — so a hub frame change fails the client's typecheck; (2) assert the client's hello/set/publish sends satisfy `SessionClientMessage`.

### ClientMeta vs HelloMeta — the hello-frame client context (tab/source/actor/intent)

- A: `packages/aiui-intent-runtime/src/instrumentation.ts:109-126 (ClientMeta, 'mirror of HelloMeta')`
- B: `packages/aiui-claude-channel/src/frame.ts:62-83 (HelloMeta, SourceInfo at :56-59)`
- kind: type
- constraint: same runtime↛channel prod-dependency bar as TabInfo; unlike TabInfo this shape is genuinely channel-wire vocabulary, not a lowering concept, so hoisting to the shared leaf is a worse fit
- **proposal:** Keep the mirror; make the comment true by adding the missing assignability assertion to the existing cross-check test file. If TabInfo is hoisted per the previous entry, both sides' `tab` field automatically share one definition, shrinking this mirror to three fields.
- drift guard: instrumentation.ts:96-97 claims 'protocol.test.ts cross-checks the shape against the channel's decoder' — but protocol.test.ts only round-trips frame ENCODING (lines 17-38) and sends one meta literal (line ~58-61); there is no type-level check. Add to packages/aiui-intent-runtime/src/protocol.test.ts (channel is already a devDep): `const _hm: HelloMeta = {} as ClientMeta;` plus a decode assertion that a collectClientMeta() result survives encodeFrame/decodeFrame with tab/source/actor intact.

### The window.__AIUI__ global's shape declared twice: PageInstrumentation (runtime, reader/seeder view) vs AiuiGlobal (viz, owner with tools + index signature)

- A: `packages/aiui-intent-runtime/src/instrumentation.ts:12-23 (PageInstrumentation + the global Window declaration)`
- B: `packages/aiui-viz/src/aiui-global.ts:39-44 (AiuiGlobal), :84-92 (ensureAiuiGlobal, the installer of record per its header)`
- kind: type
- constraint: runtime is deliberately Solid-free and viz-free (no runtime→viz edge on the sanctioned graph: both are peers under intent-client), so neither can import the other's declaration; two packages declaring the same window global is also a TS declaration-merging hazard if they ever disagree
- **proposal:** Keep both declarations (each package's honest view of the global) and add the assignability guard at the one point in the graph that legally sees both. Do not merge into a shared leaf: the global's owner story (viz installs, runtime reads/seeds, aiui-global.ts:2-6) is clearer with two typed views than one union type.
- drift guard: intent-client prod-deps BOTH packages — add a one-line compile-time check in any intent-client test (e.g. spec.test.ts): `const _g: import('@habemus-papadum/aiui-intent-runtime').PageInstrumentation = {} as import('@habemus-papadum/aiui-viz').AiuiGlobal;` — AiuiGlobal (v:1, sourceRoot?, index signature) must stay assignable to the runtime's reader view, so a v-bump or sourceRoot retype on either side fails the client's typecheck.

**Response for this group:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## keep-as-is (11)

### Frame encoding logic — encodeFrame (u32 BE header-length + UTF-8 JSON envelope + raw payload) and the JSON payload codec, reimplemented in the browser client

- A: `packages/aiui-claude-channel/src/frame.ts:152-159 (encodeFrame) and src/codec.ts:38-41 (jsonCodec.encode: `JSON.stringify(payload ?? null)`)`
- B: `packages/aiui-intent-runtime/src/protocol.ts:114-121 (encodeFrame) and :124-126 (encodeJsonPayload)`
- kind: logic
- constraint: Explicitly deliberate: protocol.ts:4-12 calls it 'the deliberate ~40-line reimplementation the wire format was designed to allow' — the point of the format (frame.ts:19-21, docs/websocket-protocol.md:442-472) is that any client re-implements it in ~20 lines. Importing the channel would drag a Node server package into the browser bundle.
- **proposal:** Keep. The byte-level drift guard already exists: packages/aiui-intent-runtime/src/protocol.test.ts:22-37 round-trips runtime-encoded frames through the channel's real decodeFrame + jsonCodec (via the devDependency). Any envelope/framing change that breaks compatibility fails this test. Extend the round-trip cases when the envelope gains fields.

### LoweredMessage — the `{kind:"lowered", threadId, events}` push has no runtime type twin at all; the client checks it structurally and casts to the SHARED IntentEvent[]

- A: `packages/aiui-claude-channel/src/intent-v1.ts:99-103 (LoweredMessage)`
- B: `packages/aiui-intent-runtime/src/wire.ts:331-332 (structural check `msg.kind === "lowered" && Array.isArray(msg.events)` then cast `msg.events as IntentEvent[]`)`
- kind: logic
- constraint: The payload type is already single-sourced: IntentEvent lives in aiui-lowering-pipeline (engine.ts / types.ts) and both sides import it — the only restated part is a two-field envelope checked inline.
- **proposal:** No action. This is the model the other pushes should converge toward: heavy vocabulary in the shared leaf (lowering-pipeline), a trivially small envelope restated at the seam. If a guard suite file is created for the entries above, optionally add a named runtime twin + Pick-equality there for uniformity — cosmetic, not required.

### The shot_/seg_ attachment-id grammar — identifier-shaped ordinal tokens generated on the client side and string-parsed on the channel side

- A: `Generators: packages/aiui-lowering-pipeline/src/engine.ts:550 (`shot_${++this.shotCounter}`; ordinal re-parse at :609) and packages/aiui-intent-runtime/src/wire.ts:248 (`seg_${segment}`)`
- B: `Parsers/doc: packages/aiui-claude-channel/src/intent-v1.ts:437 (trailing-ordinal parse), :1165 (`id.startsWith("shot_")`), live-resolve.ts:36 (the `[image shot_N]` label grammar); documented at frame.ts:92-94, protocol.ts:32-34, lowering types.ts:289`
- kind: constant
- constraint: A shared home is legal (lowering-pipeline, where the shot generator already lives), but the grammar is deliberately identifier-shaped prose contract (types.ts:289: 'identifier-shaped on purpose') spanning three packages and the archive docs; the string templates are idiomatic at each site.
- **proposal:** No refactor now — churn exceeds value while the grammar is stable and integration-tested (intent-v1.integration.test.ts exercises real shot_/seg_ ids end-to-end). Revisit only if a third id family appears; then export SHOT_PREFIX/SEG_PREFIX + the ordinal helper from lowering-pipeline and consume it in engine.ts, wire.ts, and intent-v1.ts.

### docs/websocket-protocol.md — the prose inventory of the entire wire: envelope fields, PROTOCOL_VERSION semantics, HelloMeta, ChunkDescriptor, ack shape and error taxonomy, the intent-v1 pushes, and a re-implementation guide

- A: `packages/aiui-claude-channel/docs/websocket-protocol.md:83-101 (envelope + version), :105-220 (hello/data/fin, responses, error taxonomy), :261-382 (intent-v1 chunks and pushes), :442-472 (client-in-another-language guide)`
- B: `The source declarations it restates: frame.ts, channel.ts, intent-v1.ts on the channel side and protocol.ts on the runtime side (the doc's own pointer at :645-649 names frame.ts as the source of truth)`
- kind: prose-inventory
- constraint: Docs must restate the shapes to serve their purpose (the format is designed to be reimplemented from this page alone); no mechanical link exists between prose and types.
- **proposal:** Keep, relying on the existing 'Source & API' pointer (:645-649). When the type-level guard assertions from this catalog land, add one line to that section naming protocol.test.ts as the executable mirror-lockstep — so a doc reader knows the prose has a machine-checked shadow.

### The linter lifecycle state machine itself: merge-on-resume, barge-in, transcript-wait timeout, tool overlay — client pulse re-deriving the sidecar's machine from the event stream

- A: `packages/aiui-intent-client/src/linter-pulse.ts:113-182 (feed switch; header :1-27 documents the mirror table)`
- B: `packages/aiui-claude-channel/src/linter-sidecar.ts (the authoritative machine, e.g. the wait at :290)`
- kind: logic
- constraint: deliberate architecture: the pulse exists precisely to avoid new wire traffic (linter-pulse.ts:2-6), runs on different inputs (engine events vs. server callbacks), and is declared advisory — 'drift costs a dot being briefly wrong, never a behavior' (:26-27)
- **proposal:** Leave the mirror; it is a projection, not a duplicate, and the tolerance for drift is documented. The only load-bearing shared value is the constant above — once that is single-sourced, remaining drift is cosmetic by design. Optionally cite linter-pulse.test.ts:7's note as the standing reminder.

### Late-subscriber replay of cached page facts (aiuiSupport, selectionPresent) via queueMicrotask — the 'twin fix, applied to both'

- A: `packages/aiui-intent-client/src/ext/extension-bus.ts:277-296 (replay from the pageFacts map)`
- B: `packages/aiui-intent-client/src/cdp/cdp-bus.ts:594-611 (replay from bySession pages; comment at :595-600 names the twin)`
- kind: logic
- constraint: the two buses cache facts in structurally different stores (per-tab facts map vs. per-CDP-session page records), so the shared part is the ~8-line contract (async replay, unsubscribe-before-microtask check), not the iteration
- **proposal:** Below the extraction threshold: a shared helper would take a handler set plus an iterate callback and save fewer lines than it adds. Instead, pin the CONTRACT once: a transport-level test run against both buses (the FakeBus harness already exists, fake-bus.ts) asserting a handler registered after hello still receives aiuiSupport/selectionPresent, and never synchronously inside its own registration.

### PageReport — the page→panel fact union, spoken by both hosts

- A: `packages/aiui-intent-client/src/cdp/page-script.ts:32-69 (the single definition)`
- B: `packages/aiui-intent-client/src/ext/protocol.ts:18 and ext/content.ts:34 (type-only imports of that definition)`
- kind: type
- constraint: none — already single-sourced despite the stringification constraint, because type imports erase
- **proposal:** No action; catalog it as the existence proof for the pattern the other entries lean on (type-only sharing into the stringified file is safe, and ext/protocol.ts:6-11 documents why one vocabulary matters). If the tools-types hoist (entry above) happens, PageReport is the natural neighbor.

### `claude agents --json --all` parsing: parseAgentNames (pid→name subset) vs parseClaudeAgents (full agent rows)

- A: `packages/aiui-vscode/src/agents.ts:15-36 (parseAgentNames)`
- B: `packages/aiui-claude-channel/src/agents.ts:50-87 (parseClaudeAgents, ClaudeAgent)`
- kind: logic
- constraint: same no-channel-in-bundle constraint; but the deeper point is that the source of truth is EXTERNAL (the claude CLI's JSON contract), not either package — vscode agents.ts:1-4 says so explicitly
- **proposal:** Keep. The two parsers are deliberate different projections of an external contract (vscode wants only pid+name, async, best-effort; channel wants all seven fields, sync). They cannot drift against each other in a way that breaks anything — a CLI contract change breaks both independently and identically. A shared fixture test would guard the wrong axis (the packages against each other) instead of the real one (the CLI).

### WireCap vs CapView — the bar's wire projection restating the modal kit's renderable cap

- A: `packages/aiui-remote-bar/src/protocol.ts:52-74 (WireCap; also BarState.rows at :85-90)`
- B: `packages/aiui-viz/src/modal/bar.ts:95-108 (CapView; KeyHint carries more than WireCap.hint)`
- kind: type
- constraint: protocol.ts:40-45: the relay is a node process that must not import Solid or the engine — though note aiui-remote-bar ALREADY production-depends on aiui-viz (package.json), so a type-only import would be erased and legal; the restatement is really a deliberate NARROWING (hint subset without iconSvg/active/tapKey; reveals dropped) — a wire schema, not a copy
- **proposal:** Keep — this is the model case the other mirrors should copy. The compile-time drift guard already exists and works: packages/aiui-remote-bar/src/protocol.test.ts:41-60 assigns a real CapView to a WireCap, so a dropped/retyped field on either side fails typecheck (viz is available to the test via the existing prod dep). Deriving WireCap from CapView with Pick/Omit would re-widen the deliberately narrowed hint and make the wire schema harder to read.

### Relay room-model plumbing (register/join/leave/sessions/hostGone, SessionInfo) restated from the pencil relay minus media

- A: `packages/aiui-remote-bar/src/protocol.ts:109-165 (SessionInfo, ClientToRelay, RelayToClient, HostToRelay, RelayToHost)`
- B: `packages/aiui-pencil/src/protocol.ts:208-235+ (SessionInfo, ClientToRelay, register)`
- kind: prose-inventory
- constraint: protocol.ts:26-28: restated so remote-bar takes no dependency on pencil (plan decision D5: the bar is its own channel); the two protocols are expected to evolve independently
- **proposal:** Keep as a documented pattern-mirror, not a contract-mirror: the shapes already differ on purpose (no ink/video/WebRTC planes, different message unions) and no code path ever crosses them. The prose pointer in each file header is the right artifact; a type guard would assert a sameness that is not intended.

### The __AIUI__ seed initializer `{ v: 1 }` duplicated as a generated inline-HTML string vs the runtime initializer

- A: `packages/aiui-source-processor/src/index.ts:82 (`(window.__AIUI__ ??= { v: 1 }).sourceRoot = …` — a generated string in injected HTML)`
- B: `packages/aiui-intent-runtime/src/instrumentation.ts:88-91 (getInstrumentation's `window.__AIUI__ ??= { v: 1 }`, with a keep-in-sync comment naming the plugin); also aiui-viz/src/aiui-global.ts:89 (`w.__AIUI__ ??= { v: 1 }`)`
- kind: constant
- constraint: the plugin emits a self-contained inline script string into the served HTML — it cannot import runtime code into that string, only into its own build
- **proposal:** Keep: the shared content is a single literal `{ v: 1 }` and an ??= idiom, already prose-linked in both directions (instrumentation.ts:88-89 names the plugin; index.ts:19-25 names the global's owner). The version literal only matters if `v` ever bumps — at that point the PageInstrumentation/AiuiGlobal guard above fails typecheck first, which is the tripwire that would prompt updating the seed string.

**Response for this group:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:
