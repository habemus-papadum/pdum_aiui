# Code review, pass 1 — stale references & legacy code

**Status: IMPLEMENTED (2026-07-18).** Every decision marked below was executed the same day:
Part B structural changes first (serially, per-package, gated on that package's tests), then
the A0–A5 comment/string sweep (10 parallel agents over per-package briefs generated from the
verified findings). Final state: 223 files changed, +1,005/−5,903 lines; workspace-wide
typecheck, all 18 test suites (1,727+ tests), biome, `pnpm test:packaging`, and
`pnpm version:check` all pass; a repo-wide grep for the retired vocabulary
(dev-overlay/paint/ink/webext/devtools-extension/aiuiDevOverlay) over tracked source finds
**zero** remaining hits outside `.md` files (the deferred docs pass). Deliberate deviations
and leftovers are recorded in **Implementation notes** at the end of each part below; the
sweep agents' full reports live beside the evidence in `docs/proposals/review-pass1.local/`.

- **Date:** 2026-07-18
- **Method:** 15 area finders + 15 adversarial verifiers (two-agent chain per area; every claim
  re-checked against the tracked tree with `git grep` / `git ls-files`). ~3.0M tokens, 1,010
  tool calls, 15 minutes.
- **Scope:** all 16 tracked packages, 5 demos, `scripts/`, root configs. Excluded by
  instruction: all `.md` documentation, skill content, and anything untracked (the ghost dirs
  `aiui-dev-overlay`, `aiui-extension`, `aiui-devtools-extension`, `aiui-webext`, `aiui-ink`,
  `aiui-paint`, `aiui-oscillator` on disk are gitignored leftovers of deleted packages, not part
  of the repo).
- **Raw numbers:** 342 stale-reference sites found → **287 confirmed**, 37 confirmed-with-
  corrections, 16 refuted (excluded — mostly deliberate tombstones and references to tracked
  `archive/` docs), 2 unverified. 68 legacy-code candidates → **41 confirmed unused**, 18
  partially used (only by test/diagnostic surfaces), 9 refuted as live.

**TL;DR of the big-ticket items:** (1) a large, mostly mechanical comment sweep across four
retired vocabularies (paint/ink, the dev overlay, the old extensions, dead doc pointers), with
~20 of those sites being *user-facing strings* that actively lie; (2) about 2,500 lines of
confirmed-dead code, the largest chunks being the flagship voice session (~880 lines), the
overlay keymap in the lowering package (~620 lines), the trace-ui Vite plugin + EventPanes
stack, and the dead wire-compat lanes (`context`/`video` chunks); (3) a set of judgment calls
you named or the team surfaced — `text-concat`, the frozen-extension coexistence guard,
`paintClients`, aiui-vscode — each written up individually below.

**How to respond** — under each recommendation:

```
- [ ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:
```

---

## Part A — Stale references

The full site lists (file:line, every confirmed instance) are in **Appendix D**. Part A groups
them into decisions; you're agreeing to a *treatment*, not re-litigating each line.

### A0. Policy: what happens to "useful history" comments

This decision drives the majority of the ~300 sites. The comments fall on a spectrum:

1. **Actively misleading** — present tense about deleted code ("the overlay renders…", "the
   DevTools panel reads this"), dangling `{@link}`s, wrong file paths, self-contradictory
   status docs.
2. **Useful history with a dead referent** — provenance notes ("salvaged from the overlay's
   preview.tsx", "earned on a real iPad in paint v1") that explain *why* code is shaped the way
   it is, but cite files readable only in git history.
3. **Deliberate tombstones** — past-tense, often owner-dated records ("the `aiui demo` command
   is gone", "retired with the DevTools extension"). The verifiers refuted flagging these; they
   are accurate and load-bearing.

**Recommendation (Moderate policy):**
- Category 1: rewrite now — name the live successor (the intent client, the console, the pencil
  sidecar, `aiui-intent-runtime`) or delete the claim.
- Category 2: compress to explicit past tense, keep the load-bearing rationale, and where a
  successor exists *name it* ("now `aiui-intent-runtime/src/speech.ts`") instead of pointing
  into git history. Drop pure archaeology (dates, plan-phase codes like B2.4/D5/P4, salvage
  lists) unless the rationale depends on it.
- Category 3: keep untouched.

Alternatives: *Aggressive* (delete every mention of a deleted package, rationale included —
loses real design knowledge) or *Minimal* (fix only category 1 — leaves several hundred
misleading-adjacent comments for the next reader).

- [ X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:
Defer to your judgment

### A1. User-facing strings that lie (fix first, regardless of A0)

These render in `--help`, first-run prompts, error messages, scaffold output, and on-page copy
— they instruct users to use things that don't exist:

- `packages/aiui/src/util/first-run.ts:31` — first-run prompt advertises "the iPad paint page
  (`aiui paint url` prints its URL)"; the command is `aiui pencil url`.
- `packages/aiui/src/commands/claude.ts:284,287` — `aiui claude --help` lists the paint sidecar
  (real set: intent, bar, pencil, console).
- `packages/aiui/src/util/config-schema.ts:152,156` — `aiui config show` doc strings name the
  paint page.
- `packages/aiui/src/util/openai-preflight.ts:122,126` — missing-API-key warning says "the
  overlay says so when you try to dictate" and points at a guide page
  (`docs/guide/intent-overlay.md`) that doesn't exist.
- `packages/aiui-claude-channel/src/debug.ts:181` — the GET /debug JSON hint names the old
  dev-server-hosted debug page; it's the console's `/__aiui/debug` now.
- `packages/aiui-source-processor/src/source-locator.ts:63` — missing-@babel/core error message
  tells users to configure `aiuiDevOverlay()`, an API that no longer exists.
- `packages/aiui-viz/src/control.ts:161` — the MISSING_NAME runtime error (thrown at app
  developers) explains the failure in terms of the deleted dev overlay's Vite plugin.
- `packages/aiui-vscode/src/extension.ts:198` — QuickPick help text instructs mounting the
  deleted dev overlay; `packages/aiui-vscode/package.json:4` names it in the npm description.
- `packages/create-aiui/src/cli.ts:94` (post-scaffold epilogue),
  `templates/app/src/ui/Banner.tsx:15` (rendered on the starter page),
  `templates/app/src/main.tsx:10` ("START HERE" comment), `scripts/new-demo.ts:178,225`
  (written into every new demo's README/CLAUDE.md) — all describe the retired overlay arming
  UX; scaffolded apps ship this today.
- `packages/aiui-test-app/src/ui/App.tsx:19` + `package.json:4` — on-page copy and description
  say "intent overlay".
- `package.json:25` (root) — `paint:demo` script targets the deleted `aiui-paint` package and
  fails in a fresh clone (also listed as B17).

**Recommendation:** fix all of these in the first cleanup batch; they are cheap, high-blast-
radius, and independent of every other decision.

- [X  ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### A2. Wrong or self-contradictory in-code documentation

Docs that disagree with the code *in the same file or package* — worse than stale, they teach
the wrong architecture:

- The standard sidecar set is mis-enumerated four ways: "paint, intent, bar, pencil"
  (`aiui-claude-channel/src/commands/mcp.ts:28`, `commands/serve.ts:22`,
  `packages/aiui/src/commands/mcp.ts:27`), "three sidecars"
  (`standard-sidecars.ts:33` — the array below it has four), and `sidecar.ts:11` claims the
  channel takes no dependency on concrete sidecars while `standard-sidecars.ts` imports all
  four.
- `aiui-pencil/src/index.ts:14` narrates phases as not-yet-built; the same file exports the
  shipped results. Same at `lab/src/model/pad-renderer.ts:10` (future-tense `PencilSurface`).
- `aiui-lowering-pipeline/src/types.ts:288` still documents the retired Option-C `{shot_n}`
  scheme that `types.ts:618` says was replaced (also `index.ts:6`, `fixtures.test.ts:12`).
- `aiui-claude-channel/src/live-session.ts:120` documents `LiveSession.drainToolCall` — a
  method the class 100 lines below doesn't have. `openai-live.ts:1-41` and `gemini-live.ts:1-46`
  headers describe the retired composer design (`tools: [submit_intent]`, "the model composes
  the prompt itself") that the code below no longer implements.
- `aiui-claude-channel/src/agents.ts:7` names a `list_channels` MCP tool that doesn't exist.
- `aiui-intent-client/src/ext/content-main.ts:10` promises jump-to-editor "one day"; the same
  file implements it. `src/config.ts:88` contradicts the comment seven lines above it.
  `ext/manifest.ts:116` calls content-main.ts a five-line script (it's 123 lines).
- `aiui-claude-channel/src/debug.ts:10-15` enumerates three debug frontends that no longer
  exist in that form.
- `packages/aiui/src/util/chrome.ts:260` — "realpath for the same reason as above" where the
  "above" was deleted; the reason is now stated nowhere.
- `aiui-pencil/src/client-static.ts:7` cites a build config file that doesn't exist (the client
  is built by `client/vite.config.ts`); `aiui-intent-runtime/src/instrumentation.ts:171` points
  at a cross-check test in a file that doesn't exist (it lives in `protocol.test.ts`).
- Terminology lag from the managed-browser generalization: `commands/debug.ts:10,53`,
  `commands/vite.ts:207`, `commands/browser.ts:163` still say "Chrome for Testing" where the
  sync is now flavor-generic (Chromium default).

**Recommendation:** rewrite all to match the tree. These are individually small; the plan pass
can treat them as one batch.

- [ X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### A3. The paint/ink → pencil/console vocabulary sweep (81 sites)

The largest mechanical group. `aiui-paint` and `aiui-ink` are deleted (superseded by
`aiui-pencil`); no tracked code serves `/paint/`. The vocabulary survives across:
`packages/aiui` (help/config plumbing), `aiui-claude-channel` (web.ts, sidecar.ts), the intent
client (`ink` capability comments, `cdp-bus` "ink bundle" naming, spec/sidecar comments),
`aiui-remote-bar` (whose backend/sidecar docs still compare to paint in present tense), and
`aiui-pencil` itself (20+ "paint v1"/"aiui-ink" citations, including a section header at
`surface.ts:507` anchoring a parity contract to the deleted `InkSurface` class, and
`protocol.ts:8` describing a JPEG wire design the D1/D3 sections below contradict).

Three sites in this group are *code*, not comments, and are cross-referenced to Part B:
the dead `ink` slot in the extension bus sticky map (B8), the `paintClients` context field
(B9), and the root `paint:demo` script (B17).

**Recommendation:** sweep per policy A0 — rewrite misleading present tense to pencil/console
vocabulary, compress lineage notes to past tense. In `aiui-pencil`, keep the genuinely
load-bearing performance rationale (e.g. `surface.ts:51` raster-vs-vector, `remote.ts:49`
fade-constant provenance) in compressed past-tense form.

- [ X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### A4. The dev-overlay / old-extension narration sweep (~170 sites)

The two biggest themes, same treatment. "The overlay" (deleted `aiui-dev-overlay`) and the old
extensions (`aiui-extension`, `aiui-devtools-extension`, `aiui-webext`) are cited across
every package — sometimes as honest lineage, often in present tense as if they were live
consumers. Notable sub-cases the sweep must handle with care:

- **Normative constants justified only by parity with deleted code** — e.g.
  `aiui-intent-client/src/lanes.ts:375` (`thumbMaxPx: 1024` "parity with the overlay"). The
  value needs a real justification or a decision to re-derive.
- **Concepts that survive under new names** — the verifiers mapped successors for ~35 sites
  (e.g. "dev-overlay speech.ts" → `aiui-intent-runtime/src/speech.ts`; "the overlay's shared
  shell" → `aiui-intent-runtime`; "mm-diff palette" → the modal kit's `DEFAULT_DIFF_CLASSES` +
  `turn-preview.tsx`; "the lab dock + DevTools panel" → the intent panel + console
  `/__aiui/debug`). Rewrites should name the successor, not just delete the old name.
- **`aiui-trace-ui`** is the densest cluster (index, styles, trace-view, sources, paths,
  debug-page all narrate the lab/DevTools era; `debug-page.ts:9,66` also asserts a
  loopback-only bind that `channel.bind: host` made false).
- **Comments that document deliberate compat for out-of-repo artifacts** (the frozen-extension
  coexistence block in `ext/content.ts`, `cdp/page-script.ts:630-649`, `ext/channel.ts:25`
  storage-namespace note) — these stand or fall with decision B8, not with this sweep.

**Recommendation:** sweep per A0. Where the verifier recorded a successor, use it.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### A5. Dead documentation pointers in code comments

Comments cite design docs that are not in the tracked tree, so their load-bearing claims are
unverifiable from a checkout:

- **`streaming-turns.md`** (cited ~8×: intent-v1.ts, prompt-context.ts, speak.ts, realtime.ts,
  frame.ts, lowering config.ts:57) and **`model-tiers.md`** (cited ~5×, including e2e test
  headers) — nowhere in the tree, not even `archive/`.
- **`transcription-and-realtime-submodes.md`** (intent-v1.ts:208, openai-live.ts:8,
  trace-cards.ts:388) — same.
- **`multimodal-intent-graduation`** handoff (openai-preflight.ts:7, openai-pipeline.e2e.ts:27)
  — same.
- Docs that exist but **only under `archive/`**, cited by bare name or old path:
  `openai-audio-stack.md`, `realtime_prompt_linter_design.md` (lowering config.ts:125,139),
  `realtime_pivot_plan.md` (live-session.ts:24 cites `docs/proposals/`),
  `solid-cell-attribution.md` (viz graph-trace.ts:8), one `cell-view.tsx:5` path.
- One citation of a gitignored machine-local file (`elevenlabs-realtime.ts:13` →
  `.aiui-cache/scribe-findings.md`).
- `marketplace.json:16,21` describes skills by their drafting-era state.

**Recommendation:** (a) for archived docs — fix the paths to `archive/…`; (b) for
`streaming-turns.md` / `model-tiers.md` / `transcription-and-realtime-submodes.md` — these are
cited enough to matter: recover them from git history into `archive/` and re-point, *or*
strip the citations and inline the one-sentence claim each site actually needs (your call —
recovery is cheap if the docs existed in an earlier commit; the finders could not see git
history to confirm); (c) strip the `.aiui-cache` and graduation-handoff citations.

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### A6. What the verifiers cleared (no action)

For the record, 16 flagged sites were **refuted** and are excluded from the sweep — deliberate
tombstones (`program.ts:127` "There is no `aiui demo`", `commands/extension.ts:114`,
`config.ts:122` DEPRECATED_FIELDS rationale, vite.ts:19 owner-dated note), accurate past-tense
provenance whose referents are tracked in `archive/` (workbench citations in
`transcribe.ts`/`audio.ts`/`wire.ts`/`talk-lanes.ts`), and negative-space documentation that is
still true (`demos/july09/vite.config.ts:11`). Full list in Appendix D.4. No response needed.

### Implementation notes — Part A (2026-07-18)

- ~248 sites rewritten/compressed by the sweep; ~70 brief sites had already vanished with the
  Part B deletions; ~13 kept as deliberate tombstones per the verifier verdicts (owner-dated
  notes, archive-tracked workbench citations, in-file iteration history).
- A5: `streaming-turns.md`, `model-tiers.md`, and `transcription-and-realtime-submodes.md`
  were **recovered from git history into `archive/`** (they existed under the deleted
  overlay's handoff/ dir), and all citations re-pointed there; graduation-handoff and
  `.aiui-cache` citations stripped as agreed.
- `biome.json`'s ignore entry for the deleted extension's worklet was **kept**: it still
  suppresses the untracked ghost dir on this machine, so removing it would break local lint
  until the ghost dirs are cleaned. Flag: delete the entry when you delete the ghost dirs.
- `.md` files (READMEs, guides) still carry the old vocabulary by design — that's the docs
  pass.

---

## Part B — Legacy code candidates

Each item names its verifier verdict. "Confirmed" = nothing outside its own tests uses it;
"partially used" = only test/diagnostic/legacy surfaces use it.

### B1. `text-concat` — the feature you named (verdict: partially used)

**What it is:** the original, pre-intent-v1 stream format of the channel's `/ws` endpoint:
JSON `{text}` chunks concatenated per thread until `fin`, then pushed as one prompt.
Implemented in `aiui-claude-channel/src/processors.ts` (`textConcatProcessor`/
`textConcatFormat`), registered in `defaultFormats()` and hot-reload, barrel-exported, and the
default format of `sendPromptWs` / the `quick --ws` CLI path.

**Reality check (verified):** no production client speaks it — the intent client sends only
`intent-v1`. Its live users are exactly: `quick --ws` (a registered debug/smoke CLI command),
`packages/aiui/test/claude.e2e.ts` (deliberate transport coverage), ~12 unit-test files across
the channel and intent-runtime that use it as the *minimal* format for exercising transport/
tracing machinery, and trace-ui's no-event-log fallback. The multi-chunk concatenation
behavior itself is exercised **only by its own tests** — every live sender sends the whole
prompt in one `fin` frame. The channel's own code already labels it legacy in two places.

**Recommendation — keep, but demote explicitly:** it earns its keep as the minimal reference
implementation of the `/ws` protocol (killing it would force every transport test and
`quick --ws` onto the heavyweight intent-v1 pipeline). Reposition it as the protocol's
reference/diagnostic format rather than a peer modality: keep registration, stop presenting it
as a client option, and consider un-exporting `textConcatProcessor` from the public barrel.
Remove its truly dead appendages separately: the per-frame selection payload (B2) and the
chunkless non-final `IntentThread.send()` verb in the runtime (zero production callers;
`finish()` covers the live path).

*Alternative:* full removal — heavier than it looks (e2e + ~12 test files + quick --ws all
migrate); only worth it if you want exactly one format on the wire.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B2. The submit-time selection path (verdict: partially used, feeders dead)

`asSelection` + `selectionSections` + `TextConcatPayload.selection`
(`aiui-claude-channel/src/prompt-context.ts`, `processors.ts`): renders an on-screen selection
into the context preamble. Both feeders are dead — intent-v1's `onContextChunk` decodes and
*discards* the payload (selections now ride the stream as positional events rendered inline by
`composeIntent`, per the settled render-audit decisions), and no live text-concat sender ever
constructs a selection. Only `processors.test.ts` and the render-audit script exercise it. It
remains documented protocol surface an out-of-tree ws client could theoretically use.

**Recommendation:** remove the selection field from the text-concat payload, `asSelection`, and
`selectionSections`; update `websocket-protocol.md` and the prompt-rendering guide's LEGACY §30
when the docs pass happens. Keeping a second, unreachable rendering of selections invites
divergence from the decided inline form.

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B3. Dead wire-compat lanes: the `context` and `video` chunks (verdict: confirmed, both ends)

Two accepted-and-ignored (or accepted-and-dead-ended) chunk kinds kept "for older
overlays/pre-greenfield clients" — all of which are deleted packages:

- **`context` chunk:** runtime declares it (`protocol.ts:41`) but never sends it; the channel's
  `onContextChunk` (intent-v1.ts:1332) decodes and discards. Only its own test exercises it.
- **`video` chunk:** the whole lane — runtime `sendVideo` (self-marked LEGACY), channel
  `onVideoChunk` → `LinterSidecar.onVideoFrame` → `session.appendVideoFrame` in both live
  engines — has zero non-test callers. The current client uploads sampled frames as `shot_N`
  attachments.

Releases are version-lockstep and pre-1.0, so the compatibility window these protect is empty.

**Recommendation:** remove both lanes end-to-end (wire kind declarations, handlers, sidecar
hook, `appendVideoFrame` plumbing, runtime verbs, and their tests), plus the corresponding
`websocket-protocol.md` rows in the docs pass.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B4. The flagship voice session — `realtime-voice.ts` (verdict: partially used; ~880 lines)

The 603-line gpt-realtime speech-to-speech engine built for the retired `flagship` tier, plus
its 280-line test. Production-dead: the hello that asks for it (`transcriber:"openai-voice"`)
is coerced away at intent-v1.ts:425 before any session opens; `audioBack:"voice"` is
enum-accepted but inert. Its only consumers are the barrel export, its own test, and a keyed
micro-e2e. **But** three utility exports are live in both live engines
(`pcm16ToWav`, `REALTIME_VOICE_RATE`, `OPENAI_REALTIME_VOICE_URL`), and the related config
knob `realtimeVoice` is *live* (feeds the linter's voice) — only `realtimeVoiceModel`,
`realtimeTools`, and `realtimeReasoning` are resolved-and-ignored.

**Recommendation:** extract the three utilities to a new home (realtime.ts or a pcm util),
then retire `realtime-voice.ts`, its test, and `packages/aiui/test/openai-voice.e2e.ts`; drop
the three dead knobs from resolve/trace echo. Keep `realtimeVoice`.

*Alternative:* keep as a published-API capability against OpenAI voice-UX improving — but the
tier that reached it was deliberately retired, and re-adding later would be a redesign anyway.

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B5. Composer-era residue in the channel (verdicts: mixed — itemized)

- **`SelectionEntry.retracted`** (live-resolve.ts:34): write-never, read-never; its documented
  consumer (`resolveSegments`) was deleted. **Remove** (confirmed).
- **The resolveIntent coercion shims** (intent-v1.ts:421-450: openai-voice→openai-realtime,
  submode realtime→transcription, legacy tier aliases): live and still fed by
  `LEGACY_TIER_EXPANSIONS` for persisted configs. **Keep, schedule a sunset** once persisted
  configs roll over; resolveIntent is half coercion table already (partially used).
- **The REST transcription tier** ('standard' default for tier-less hellos; the announced
  "REST retirement will flip this to rapid" has not happened). **Decision needed:** execute
  the announced flip now or leave the tracked TODO (partially used).
- **Retired realtime-submode trace-card support** (~150 lines in trace-ui rendering `live-*`
  stages only historical gitignored traces can contain). **Keep for now** is defensible (the
  classifier degrades gracefully without it); flag for pruning once old trace caches age out
  (confirmed-no-producer).

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B6. The lowering package's overlay-era API surface (verdict: confirmed, largest cluster)

`aiui-lowering-pipeline` still ships the retired overlay's UI layer as published API, none of
it imported by any workspace consumer:

- **`keymap.ts` — 621 lines** (installKeymap, keyCommand, intentKeyHints, keymapHelp,
  ENGINE_DIGITS, KeyState/KeyCommand): the intent client rebuilt its own keymap on the shared
  modal kit (`keys.ts`, "The displayed keymap IS the working keymap") and never imports this.
- **`talkMode`** — a required config field whose own doc says RETIRED; no binding reads it
  anywhere.
- **Config-strip exports** — `engineOf`, `TRANSCRIPTION_ENGINES`, `TIER_CONTROLLED_KEYS`,
  `DEFAULT_TIER`, `INK_FADE_MIN/MAX/DEFAULT_SEC`: zero importers (contrast: `expandTier` and
  `DEFAULT_INTENT_CONFIG` are live in channel + client).
- **`ComposedIntent.meta`** — permanently `{}`; renderPrompt hardcodes it, the channel's only
  read always yields `undefined`, tests assert it's absent from the wire.
- **`renderAppSelection`/`renderCodeSelection`/`SHORT_SELECTION_CHARS`** — live internals, but
  exported for a consumer (`resolveSegments`) that died. Un-export.
- **Producer-less Engine verbs** — `strokeDone`/`inkCleared` (explicitly deferred "post-v1" —
  keep the event *types* for trace replay, verbs are currently unreachable), `videoShare` and
  the vscode `Mode`/`setMode` (no caller anywhere; overlay leftovers).

**Recommendation:** delete keymap.ts + its test and the config-strip exports; make `talkMode`
optional-tolerated instead of required-shipped; drop `meta` at the next breaking version;
un-export the three renderers. For the Engine verbs: keep `strokeDone`/`inkCleared` types
(deferred roadmap + trace replay), prune `videoShare` and the vscode Mode unless you consider
them live roadmap. One preservation note: `TRANSCRIPTION_ENGINES`' per-vendor param table is
documentation-grade — worth keeping its *content* somewhere (docs pass) even if the export
dies.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B7. Trace-UI: the standalone-era stack (verdict: confirmed)

- **`traceViewer` Vite plugin + the `./vite` subpath export** (`src/vite.ts`): zero importers
  anywhere; the page it served is a console SPA route now; `aiui debug` doesn't stand up Vite.
  Removing it also lets `packages/aiui` drop its unused `aiui-trace-ui` dependency (confirmed
  separately — nothing under `packages/aiui/src` imports it), and CLAUDE.md needs a new
  subpath-export example (docs pass).
- **EventPanes + the DebugSource stack** (`engineSource`, `staticSource`, `traceLiveSource`):
  no consumer since the lab died; `index.ts:23` claims a deleted host still mounts it. One
  subtlety the verifier caught: `extractIntentEvents` *is* called on every live trace poll —
  and its output discarded. Removing the stack should also stop that wasted compute.
- **`defaultPreviewUrl`** (`paths.ts`): defaults to `/api/preview`, a route only the deleted
  lab served — every live consumer overrides it; any future bare use silently 404s. Default it
  to the channel's real `/debug/api/preview` or require injection.

**Recommendation:** remove all three (plus the aiui dependency), keeping TracesPane/TraceView
(live in the intent panel and console) untouched.

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B8. The frozen-extension coexistence machinery (verdict: confirmed; **your call on timing**)

Both host tiers carry a detector for the OLD extension's on-page ring
(`aiui-webext-indicator-host`): `ext/content.ts` MutationObserver + `cdp/page-script.ts`
`checkForeign()` twin, the `foreign`/`foreignClient` event plumbing through both buses,
`foreignArmed` in IntentContext gating `available.arm`, `LEGACY_RING_HOST_ID`, README policy
text, and dedicated tests. No tracked code can ever render that DOM id — the only possible
trigger is the frozen extension still *installed in a browser profile from an old checkout*.
The repo's own retirement-pass report already lists this cluster as outstanding removal.

Also in this cluster: the dead `ink` slot in the extension bus sticky-replay map (nothing ever
writes it; "ink" isn't even a served capability — though its steelman, replaying *pencil*
engagement on reload, may be a real gap worth a separate look), and the never-called `locate`
capability + ignored `stroke` report (declared, stubbed, zero callers; jump and regionDrag
cover both anticipated uses).

**Recommendation:** confirm your browser profiles no longer have the frozen extension loaded,
then delete the whole cluster in one sweep (both tiers + spec gate + tests + README paragraph).
Delete the `ink` slot and the `locate` union member now regardless. Keep `stroke` only if the
"post-v1 shot enrichment" plan is real.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:
don't worrk about old browser profiles

### B9. `paintClients` / the 'ipad' pill (verdict: confirmed unwired; PARITY P5)

`IntentContext.paintClients` feeds the panel's "ipad" status pill; its only writer in the
entire tree is the fake-tier SimulateStrip debug button, so in production the pill is
permanently off. PARITY.md records it as open item P5 ("a lane wiring job, not a blocked
one"), and the wiring seam exists (`pencil-host.ts` `onStatus(HostSessionStatus)`, unconnected).
The name also carries retired paint vocabulary.

**Recommendation:** decide the feature, not just the code: **(a)** wire it from
`HostSessionStatus` and rename to `pencilClients` (completes P5), or **(b)** drop field + pill
+ debug toggle together. Recommend (a) — the remote pencil landed and presence is genuinely
useful — but it's real work, not cleanup.

- [X ] Agree — wire it (a)
- [ ] Agree — drop it (b)
- [ ] Partially agree / other (see comments)
- [ ] Disagree

Comments:

### B10. aiui-vscode — rewritten for clarity, as requested (decision was UNSURE → kept as is)

**What the package is.** Exactly what you'd expect: a small VS Code extension (status bar +
one command, "Send Selection to Browser Tab") plus the library code it's built from. Its whole
job is: you select some code in the editor, invoke the command, and the selection should
appear in a browser tab's intent turn — the editor-side twin of selecting text on the page.

**How a send is supposed to travel.** Three hops:
1. The extension finds your running channels by reading the on-disk channel registry (the same
   registry `aiui claude` sessions register into). This hop **works**.
2. It POSTs the selection to the chosen channel's `/session/publish` HTTP route. This hop
   **works** too — the channel deliberately keeps `/session/peers` + `/session/publish` as its
   "external tools" surface, and that's tested.
3. The channel forwards the published selection to a connected browser client — and here the
   chain is broken, in two independent places:
   - The extension only offers tabs whose session-bus peer registered with role `"app"`. That
     role was what the deleted dev overlay used. The live intent client registers as
     `"intent-client"` — so the extension's tab picker is always empty, and every send stops at
     the (formerly "no overlay tabs connected") message before even POSTing.
   - Even if a tab were offered, the intent client currently ignores incoming `publish`
     messages entirely (its session-bus handler only processes snapshot/peers/set). Nobody is
     listening on the far end.

**So: the extension is fine; it's aimed at a socket nothing plugs into anymore.** Nothing
about it is complicated — reviving it is two small changes on the *intent-client* side (accept
`publish` frames and turn them into a `code-selection` event on the open turn; and either
filter on the role the client actually uses or have the client also advertise itself as a
selection target), plus deleting one filter constant here. That is real (small) feature work,
not cleanup, which is why nothing was changed structurally in this pass.

**What WAS done now:** its user-facing strings no longer reference the dead overlay (the
QuickPick help text, the npm description, the "no app tabs connected" message), and its wire
mirror comments now name the live contracts instead of a deleted file. Everything else is
untouched, matching your UNSURE.

**UPDATE (2026-07-18, follow-up commit): the loop is wired.** The session bus client now
surfaces transient `publish` frames (`onPublish` + the pure `asBusPublish` /
`asContributedSelection` narrows in session.ts), both panel entries forward a `"contribution"`
selection into the wire engine's `codeSelection()` (armed-gated by the engine's own
lifecycle, exactly like a reader contribution), and the extension's picker now targets role
`"intent-client"` peers (renamed `selectionTargets`; "no intent panels connected" wording).
End to end: select in VS Code → `POST /session/publish` → hub → panel → `code-selection`
event → composeIntent renders it inline in the lowered prompt.

Original verified evidence, for reference: `appTabs()` filters `role === "app"` (no live
client greets with it); `reduceBusMessage` in the intent client handles only
snapshot/peers/set; release.yml ships the .vsix and root package.json carries the
vscode:vsix/install scripts, so the packaging half is actively maintained.

### B11. Runtime instrumentation for the deleted DevTools panel (verdict: mixed)

- **`setChannelPort`**: zero callers; nothing writes `__AIUI__.port`; its one remaining
  "consumer" is a stale skill-doc instruction. **Remove** (confirmed).
- **The FrameMetric ring** (`recordFrameMetric`, written on every frame ack): live write path,
  zero readers since the panel died — write-only overhead. **Decision:** remove, or keep as a
  documented live-introspection surface (`__AIUI__` is the designed agent-facing surface; the
  console or an agent workflow could re-adopt it). Recommend remove; re-add with a consumer.
- **The `data-aiui-tab` stamped-identity read path** (two parse branches + `TAB_DATASET_KEY`):
  no tracked writer; the MV3 extension and CDP tier convey tab identity by other means.
  **Remove the two branches + constant** (the containing functions are live — surgical edit).

- [ X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B12. aiui-viz overlay-era hooks (verdict: confirmed)

- **`liveSignal`**: deprecated by its own docblock, kept "only for the frozen extension panel"
  (deleted). Zero consumers. Its teaching content lives on in the write-semantics proposal and
  `solid-semantics.test.ts`. **Remove module + barrel export.**
- **`OVERLAY_READY_EVENT` listener + `readyWired` set** (`agent-tools.ts`): compat for a
  late-installing bridge nothing installs; the missed-forward scenario is structurally
  impossible since the registry installs synchronously. **Remove**, and rename
  `forwardToOverlay`/`OverlayToolsBridge` to registry vocabulary.
- **`OverlayToolsBridge`**: structural duplicate of `AiuiToolsRegistry` from a module this file
  already imports. **Fold into the imported type.**
- **`KeyHint.iconSvg`**: zero writers, zero readers, innerHTML footgon, documented host
  deleted. **Remove from the published type.**

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B13. aiui-util extension machinery (verdict: confirmed)

`reloadExtension`, `evaluateInExtension`, `extensionTargets`, `listBrowserTargets`, and the
wake-page apparatus — the old CRXJS dev loop's CDP plumbing. Zero consumers, no test file; the
CLI command that drove them is a tombstone. `loadUnpackedExtension` + `discoverSessionBrowser`
are the live half (used by the intent client's build scripts). **Recommendation:** delete the
dead half, keeping the shared connect/request/close helpers `loadUnpackedExtension` needs
(extraction needs care — the verifier flagged shared internals).

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B14. Pencil/remote-bar copy-inherited seams (verdict: confirmed/low — awareness items)

- **`resolveChannel`/`channelPort` enrichment seam**: unwired in *both* relays' production
  mounts (pencil fully — no host even sends `channelPort`; bar half — the host sends it but
  `barSidecar` never passes a resolver). Copy-inherited from paint's design; both packages are
  days old and multi-session is stated direction. **Recommendation: leave, but fix the
  comments that describe it as live** (remote-bar `protocol.ts:146-150`). Revisit at the
  multi-session milestone.
- **`clientStatic`** (pencil): production path moved to `serveClientSurface`; ~70 lines kept
  for the Lab rig. **Option:** port the Lab to `serveClientSurface` and shrink the file to
  `defaultClientDir()`. Low priority.
- **pencil `PROTOCOL_VERSION = 2`**: exported, never on the wire, never checked (unlike the
  runtime's, which is stamped and asserted). **Use it (send in register/join) or delete it.**
  Recommend delete until versioning is actually needed.

- [ X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B15. CLI package odds and ends (verdict: confirmed unless noted)

- **`@habemus-papadum/aiui-trace-ui` runtime dependency**: nothing imports it (see B7).
  **Drop.**
- **`greet()` skeleton placeholder** on the published surface + its test. **Remove** (`name`
  alone covers the packaging smoke test).
- **Enter-nudge**: the mechanism is a deliberate, owner-dated hold (**keep**), but
  `first-run.ts` still asks every new user the enterNudge question and persists an answer that
  does nothing while the flag is off. **Skip the question while disabled.**
- **`FOR_TESTING_MODES`/`ForTestingMode`** deprecated aliases: not on the public surface, zero
  importers (the `chrome.forTesting` *key* tolerance is separate and stays). **Remove.**
- **`--aiui-mcp`** survives only to power its own deprecation warning; its doc comment
  describes overlay-era behavior. **Keep the tombstone warning for now; fix the doc; drop the
  flag when the migration window closes** (partially used).
- **`pencil-url.ts` multi-surface vestige** (unused `prefix`/`name` params, `_name`): low-value;
  fold into the paint-vocabulary sweep or leave (a future `aiui bar url` would reuse it).

- [X ] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B16. Channel placeholder `config` command + `CHANNEL_CONFIG` (verdict: confirmed)

A scaffold-era subcommand printing a hardcoded frozen object; self-described placeholder;
consumers are its own tests asserting the placeholder shape (ossifying it) and the README. It
also squats the `config` command name real channel configuration would want.
**Recommendation:** remove the command, constant, barrel export, and shape-assertion tests
(update the README example in the docs pass). *Alternative:* replace with real config
introspection — but that's a feature, and a future implementation would rewrite it anyway.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B17. Demos & scaffolding (verdict: confirmed)

- **`demos/july09`**: a blank, stripped, date-named scaffold contributing zero unique code
  while paying workspace costs (version lockstep, CI typecheck, lockfile). Historical docs
  cite it as a *moment in time* (git history preserves that). **Recommendation:** delete; if a
  standing blank test bed is wanted, recreate as `demos/blank` (`pnpm new-demo` reproduces it
  in seconds by design). Note: it's also one of only two in-repo users of the `cellFactories`
  compat option (see B18).
- **`demos/walkthrough/src/ui/App.tsx`**: orphaned scaffold file nothing imports, whose doc
  comment claims the shell role `main.tsx` actually plays — actively contradicts the
  walkthrough's teaching narrative. **Delete.**
- **Root `paint:demo` script**: targets a deleted package; fails in fresh clones. **Delete**
  (also under A1).
- **`create-aiui` scaffold.test.ts `aiui: { demo: true }` fixture**: keep the *behavior* (a
  package.json with some aiui key but not `scaffold: true` is occupied — real edge), rename
  fixture/title away from the retired command's vocabulary.
- **`packages/aiui-test-app`**: assessed and **kept** — actively wired (root scripts, intent
  client dev flow, documented successor to the workbench). Recorded so it isn't re-litigated.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B18. Source-processor `cellFactories` compat option (verdict: partially used)

Pre-FactorySpec sugar, specially destructured in `aiui()`. In-repo users: exactly
`demos/july09` and `aiui-test-app` (two-line migration each). After migrating them it exists
only for external consumers of a pre-1.0 package. **Recommendation:** migrate the two configs;
then either keep the shim documented as external-compat or drop it in a minor. Mild either way.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B19. Claude-plugin placeholder content (verdict: refuted as a whole — narrow cleanup only)

The finder flagged the whole base `aiui` plugin; the verifier refuted that — it contains the
real, session-loaded `aiui-workflow` skill. What *is* placeholder: `commands/aiui-scaffold.md`,
`commands/aiui-status.md`, `scripts/hello.mjs`, and the "Placeholder" self-descriptions in
plugin.json/marketplace.json. These ship into every session's command surface.
**Recommendation:** remove the two placeholder commands + hello.mjs (the plugin-loading path
stays exercised by the real skills), fix the self-descriptions.

- [ X] Agree
- [ ] Partially agree (see comments)
- [ ] Disagree

Comments:

### B20. Identity passes `silenceTrim`/`imageDownscale` (verdict: refuted as legacy — product decision)

Not dead code: both run in the hot attachment path with an explicit in-code commitment ("the
pass structure is real even while the passes are stubs… ships later"). But the config knobs
are user-visible and do nothing when toggled. **Decision, not cleanup:** ship the real passes,
or drop the knobs (keeping the pass structure) until they exist. Flagged so the commitment
doesn't rot silently.

- [ ] Ship the passes (schedule)
- [ X] Drop the knobs for now
- [ ] Leave as is
- [ ] Comments:

### Cleared in Part B (no action, recorded)

`fakeBus` and the fake tier (deliberate three-tier design; only its *public-index placement*
is worth a future thought) · the "extension debugging" pane and raw TracePane (live and
load-bearing — the SimulateStrip is the CDP tier's only supplier of mic-grant/iPad facts;
rename per A4, removal is premature) · the sidecar upgrade/raw-body seams in `web.ts` (live —
all four sidecars claim the upgrade hook; only the phantom "reader" rationale is stale, per
A4) · composer-era config fields `submode`/`liveVendor`/`liveModel` (live wire-compat until
the channel retires the composer paths — pairs with B5's sunset) · `aiui-test-app` (B17) ·
the aiui plugin as a whole (B19).

### Implementation notes — Part B (2026-07-18)

All agreed items landed. Specifics and deliberate stop-lines:

- **B1/B2/B3:** text-concat kept and repositioned as the /ws reference/diagnostic format
  (`textConcatProcessor` un-exported from the barrel; module header states the role); the
  selection side-channel, the `context` chunk, the `video` lane, and the runtime's non-final
  `IntentThread.send` are gone end-to-end. Stop-line: the server-side `sendPrompt(text, meta?)`
  parameter and `LoweredPromptMessage.meta` stay — that's the generic "meta becomes `<channel>`
  tag attributes" affordance, not the Option-C map; removing it would have exceeded the agreed
  scope.
- **B4:** `pcm16ToWav`/`REALTIME_VOICE_RATE`/`OPENAI_REALTIME_VOICE_URL` moved to a new
  `src/pcm.ts`; `realtime-voice.ts` (+test +e2e) deleted; `realtimeVoiceModel`/`realtimeTools`/
  `realtimeReasoning` dropped; `realtimeVoice` kept (live linter voice).
- **B5:** `retracted` removed; coercion shims kept (sunset note in place); the REST-tier
  "flip to rapid" TODO left as the tracked decision (no behavior change); trace-card `live-*`
  historical support kept.
- **B6:** keymap.ts deleted (−621 lines); `talkMode` now optional-tolerated; config-strip
  exports, `ComposedIntent.meta`, `videoShare`, and the `vscode` Mode removed;
  `strokeDone`/`inkCleared` kept (deferred roadmap); the three renderers un-exported from the
  package index (still module-exported for in-package tests). Note: `TRANSCRIPTION_ENGINES`'
  per-vendor param table was deleted with the code — its content survives in git history and
  docs/guide/transcription.md; consider resurrecting the table into the guide in the docs pass.
- **B8:** the whole coexistence cluster is gone from both tiers (per "don't worry about old
  browser profiles"), plus the `ink` sticky slot and the `locate` capability; `stroke` kept.
- **B9:** implemented as **(a) wire it**: `paintClients` → `pencilClients`, fed live from
  `HostSessionStatus.viewers` via `createPencilHost`'s `onStatus` in both entries; PARITY P5
  marked closed.
- **B11:** `setChannelPort`, the FrameMetric ring, and the `data-aiui-tab` path removed; the
  `frames` field also came off `window.__AIUI__`'s type + the plugin seed (runtime, viz,
  source-processor kept in sync). Follow-up for the docs pass: the session-browser skill still
  tells agents to read `__AIUI__.port`/`frames`.
- **B15:** all landed; `--aiui-mcp` tombstone kept with corrected docs; the enter-nudge master
  switch moved next to the mechanism (`ENTER_NUDGE_ENABLED` in util/enter-nudge.ts) so
  first-run and claude.ts share it.
- **B17/B18:** demos/july09 deleted; `cellFactories` removed outright (test-app migrated to
  the default factory table — it uses no `control()`/`action()`, so behavior is identical).
- Not in any agreed rec, left untouched: `aiui-util`'s unused `packageFromSource` convenience
  export (3 lines, harmless; its doc example was fixed by the sweep).

---

## Part C — Code-smell categories (stretch goal)

Categories only, as requested — each would be its own focused agentic pass. Examples are
representative, not exhaustive. Ordered by how often the 15 areas independently reported them:

1. **Provenance-narrative comment rot** (reported by 11/15 areas). Long design-history
   headers narrating deleted predecessors, dated reworks, and plan-phase codes; this is the
   engine that *generates* Part A. A style decision (how much history lives in code vs
   proposals) would prevent recurrence. Ex: `engine.ts` (five overlay attributions),
   `ext/capture.ts:1-26`, `trace-ui/src/index.ts:1-33`.
2. **Comment-enforced twins & mirror-not-import contracts** (9/15). Wire shapes and logic
   duplicated across packages/process boundaries, kept aligned only by "change both together"
   comments and cross-check tests: runtime↔channel chunk descriptors, content-script↔
   page-script capability twins, driver-watch's inline twin with hand-copied constants,
   vscode's hand-mirrored contracts, remote-bar's WireCap restatement.
3. **Copy-descended subsystem near-twins** (8/15). Whole modules cloned then diverging:
   pencil vs remote-bar backends/sidecars (same room-relay machinery), the four voice-vendor
   session state machines (segment binding/drain/outbox copied 3-4×, `concatChunks`/base64
   helpers triplicated, FakeUpstream fixture ×4), mcp vs serve command lifecycle blocks,
   new-package.mjs vs new-demo.ts helpers.
4. **Oversized multi-concern modules** (8/15). `intent-v1.ts` 1,587 (with a ~1,050-line
   function), `surface.ts` 1,279, `engine.ts` 1,263, `cdp-bus`/`page-script`/`lanes` 650-730
   each, `turn-preview.tsx` 652, `web.ts`'s ~400-line `startWebServer`, `panel.tsx` 549.
5. **Published-API sprawl without consumers** (7/15). Barrel exports of internal seams, test
   doubles, and dead surfaces (channel index ~250 symbols incl. mocks; lowering's keymap/
   config-strip exports; trace-ui's `./vite`); no distinction between public contract and
   internal seam.
6. **Prose inventories that drift** (7/15). Hand-enumerated lists in comments/help that the
   code contradicts: sidecar sets (two different wrong answers), capability inventories (×3,
   disagreeing), scripts with hardcoded package lists (`versioning.mjs` MANIFEST_FILES,
   `docs-gen.mjs` sidebar), scaffold doc-prose duplicated as string literals in two scripts.
7. **Stringly-typed dispatch with cast escapes** (6/15). Capability/op/stage-label strings
   matched in parallel switch ladders on both sides of a wire with `payload as {...}` casts:
   serveRelay handlers, page-script op dispatch, trace-ui's 270-line stage-label classifier +
   renderer re-switch.
8. **Config/boilerplate incantation duplication** (6/15). The solid-js inline/never-external
   Vitest incantation re-implemented per consumer with a pointer comment; externalize-builtins
   Vite lib config duplicated across packages + skeleton + create-aiui; HMR-guard block pasted
   per module; identical vitest twins across demos at different drift stages.
9. **Origin/bind assumptions vs the trusted-LAN posture** (2/15 but load-bearing). Debugger
   pages hardcode `http://127.0.0.1:<port>` from a bare port — breaks every cross-machine
   viewer under `channel.bind: host` (trace-ui debug-page, console main.tsx). Related:
   stylesheet-DOM drift in trace-ui (classes styled nowhere, retired-picker rules remaining).
10. **Test-infra structural gaps** (4/15). Channel tsconfig excludes `*.test.ts` from
    typecheck so fixtures drift (stubs still implement deleted interface members);
    import-order-coupled test setup (worker stub must be first import); module-global
    singletons making the MV3 capture host untestable; jsdom/node vitest splits repeated by
    hand.

**Response (pick the next pass(es)):**

- [ ] 2 & 3 (duplication/twins) next
- [ ] 4 (oversized modules) next
- [ ] 5 (API surface) next
- [ ] Other / ordering (see comments)

Comments:

---

## Sequencing (as executed, 2026-07-18)

1. Part B structural changes, serially per package cluster, each gated on that package's
   typecheck + tests (Part B before the sweeps, so no effort was spent rewording comments on
   code about to be deleted).
2. Full stage gate: `pnpm install` + `pnpm -r typecheck` + `pnpm -r test` + biome +
   `pnpm test:packaging` + `pnpm version:check` — all green.
3. A0–A5 sweep: 10 parallel agents over per-package briefs
   (`review-pass1.local/sweep/*.md`), each running its packages' tests + biome after editing.
4. Final gate: everything above re-run green; straggler grep for retired vocabulary over
   tracked source: zero hits outside `.md`.

**Still open after this pass:** Part C smell selection (next agentic run); the docs/skills
pass (`.md` vocabulary, README/guide updates, the session-browser skill's `__AIUI__` claims,
channel README's removed `config` command example).

**Follow-up commits closed the rest (2026-07-18):** B10's intent-client `publish` wiring
shipped and was verified live against `pnpm test-app:channel`; the ghost dirs were deleted
(with the biome.json ignore entry); and the B5 REST retirement was executed in full —
transcription is STREAMING-ONLY now: the sparse-hello default tier flipped to `rapid`, a
legacy `transcriber: "openai"` hello coerces to `openai-realtime` (recorded in `coerced`,
like the voice veneer), `openaiTranscriber` and the channel's whole-segment transcription
branch were deleted (an old client's `seg_N` blob is still acked and trace-saved, just never
transcribed), and the client's talk lanes stream PCM for everything except the local `mock`
tier (the whole-blob REST upload branch is gone).

---

## Appendix D — full verified site lists

Generated from the verified findings; `(adj)` = confirmed with corrections. The full
per-finding evidence — finder notes, verifier verdicts, exact correction text, and the
legacy-candidate usage analyses — is parked (gitignored) at
`docs/proposals/review-pass1.local/verified-findings.json`; the plan pass should read it
rather than re-deriving. Line numbers are 1-indexed at review time.


### D.1 — paint/ink vocabulary (→ A3)

- `package.json:25` — packages/aiui-paint (deleted package; untracked ghost dir remains on disk)
- `packages/aiui-claude-channel/src/commands/mcp.ts:28` — the retired paint sidecar; the console sidecar is missing from the list
- `packages/aiui-claude-channel/src/commands/serve.ts:22` — the retired paint sidecar; console missing
- `packages/aiui-claude-channel/src/live-resolve.ts:18` — The deleted resolve step (resolveSegments) and behavior nothing implements
- `packages/aiui-claude-channel/src/live-resolve.ts:43` — resolveSegments — deleted with the model-composes submode
- `packages/aiui-claude-channel/src/live-resolve.ts:91` — resolveSegments — deleted function
- `packages/aiui-claude-channel/src/live-session.ts:120` — LiveSession.drainToolCall — a method deleted with the composer submode
- `packages/aiui-claude-channel/src/openai-live.ts:8` — transcription-and-realtime-submodes.md design doc
- `packages/aiui-claude-channel/src/page-tools.ts:5` — aiui-dev-overlay (deleted package)
- `packages/aiui-claude-channel/src/page-tools.ts:11` *(adj)* — the old aiui-extension as the activation sender
- `packages/aiui-claude-channel/src/page-tools.ts:165` — the old extension's service worker
- `packages/aiui-claude-channel/src/sidecar.ts:4` — the retired aiui-paint sidecar (ghost dir packages/aiui-paint)
- `packages/aiui-claude-channel/src/summarize.ts:16` *(adj)* — the Corrector type (retired with the corrector round-trip)
- `packages/aiui-claude-channel/src/summarize.ts:70` — openaiCorrector (retired function)
- `packages/aiui-claude-channel/src/web.test.ts:48` — the retired `aiui paint url` command
- `packages/aiui-claude-channel/src/web.ts:17` — the retired aiui-paint sidecar
- `packages/aiui-claude-channel/src/web.ts:101` — the retired aiui-paint sidecar
- `packages/aiui-claude-channel/src/web.ts:139` — a 'code reader' sidecar that exists nowhere in the tracked tree
- `packages/aiui-claude-channel/src/web.ts:251` — the retired `aiui paint url` command
- `packages/aiui-intent-client/src/cdp-proxy.test.ts:88` — the retired paint relay's websocket route (the live equivalent is /pencil/host)
- `packages/aiui-intent-client/src/cdp/cdp-bus.ts:83` — 'ink' vocabulary from the retired aiui-ink package — the artifact is the page bundle (locator …
- `packages/aiui-intent-client/src/cdp/cdp-bus.ts:166` — channel-origin paint pages (/paint/) that no tracked sidecar serves anymore
- `packages/aiui-intent-client/src/ext/extension-bus.ts:69` — the retired `ink` capability — nothing ever writes `ink` into sticky and no page serves an "in…
- `packages/aiui-intent-client/src/ext/manifest.ts:91` *(adj)* — the retired `ink` name for the pencil surface
- `packages/aiui-intent-client/src/ext/protocol.ts:14` — the retired `ink` capability name (renamed to `pencil`) and a capability list that has drifted
- `packages/aiui-intent-client/src/ext/sw.ts:24` — the retired `ink` name for the pencil markup surface
- `packages/aiui-intent-client/src/page/pencil-mount.ts:7` — the ink-era InkSurface (aiui-ink ghost package / pre-pencil client ink)
- `packages/aiui-intent-client/src/page/pencil-mount.ts:16` — class InkSurface — defined nowhere in the tracked tree (belonged to deleted aiui-ink; only oth…
- `packages/aiui-intent-client/src/sidecar.ts:8` — the paint sidecar — no tracked code serves /paint/; the mounted set is intent/bar/pencil/conso…
- `packages/aiui-intent-client/src/spec.ts:51` — the retired 'paint' surface (aiui-paint, deleted; superseded by aiui-pencil — standardSidecars…
- `packages/aiui-intent-client/src/spec.ts:57` — the deleted frozen extension — doc for the `foreignArmed` context field
- `packages/aiui-intent-client/src/tools-link.ts:21` — the deleted old extension's tools-link module
- `packages/aiui-intent-runtime/src/errors.ts:11` *(adj)* — IntentToolContext — a type/interface that exists nowhere in the tracked tree (dev-overlay voca…
- `packages/aiui-intent-runtime/src/intent-types.ts:39` *(adj)* — IntentToolContext (nonexistent in tracked tree)
- `packages/aiui-pencil/client/vite.config.ts:8` — deleted aiui-paint's precedent
- `packages/aiui-pencil/lab/vite.config.ts:87` — deleted aiui-paint's demo directory, in present tense
- `packages/aiui-pencil/src/backend.ts:6` — deleted package aiui-paint
- `packages/aiui-pencil/src/backend.ts:22` — the aiui-paint JPEG-pumping relay, deleted
- `packages/aiui-pencil/src/client-static.ts:6` — deleted aiui-paint
- `packages/aiui-pencil/src/client/pen-input.ts:2` — deleted aiui-paint's iPad client
- `packages/aiui-pencil/src/corners.ts:9` — aiui-ink's surface (deleted), described in present tense
- `packages/aiui-pencil/src/fade.ts:2` — deleted package aiui-ink
- `packages/aiui-pencil/src/host-session.ts:11` — paint-host.ts, a file of deleted aiui-paint
- `packages/aiui-pencil/src/index.ts:10` — deleted packages aiui-ink and aiui-paint (untracked ghost dirs)
- `packages/aiui-pencil/src/index.ts:131` — the deleted aiui-paint package ('paint v1')
- `packages/aiui-pencil/src/protocol.ts:8` — the paint-era wire design (JPEG frames + preview-retiring ack)
- `packages/aiui-pencil/src/protocol.ts:16` — deleted aiui-paint's stream
- `packages/aiui-pencil/src/protocol.ts:102` — deleted aiui-paint's scroll/zoom gesture wire shapes
- `packages/aiui-pencil/src/protocol.ts:142` — deleted aiui-paint's signaling shape
- `packages/aiui-pencil/src/remote.test.ts:33` — deleted aiui-paint
- `packages/aiui-pencil/src/remote.ts:15` — deleted aiui-paint
- `packages/aiui-pencil/src/remote.ts:23` — deleted aiui-paint ('paint v1')
- `packages/aiui-pencil/src/remote.ts:49` — a constant in deleted aiui-paint's iPad client
- `packages/aiui-pencil/src/remote.ts:129` — deleted aiui-paint's fade implementation
- `packages/aiui-pencil/src/sidecar.ts:5` — the /paint sidecar route of deleted aiui-paint
- `packages/aiui-pencil/src/sidecar.ts:18` — deleted aiui-paint's page-serving precedent
- `packages/aiui-pencil/src/surface.ts:51` — deleted package aiui-ink
- `packages/aiui-pencil/src/surface.ts:507` — InkSurface, a class of deleted aiui-ink
- `packages/aiui-pencil/src/surface.ts:689` — 'the paint stream' as a name for the CURRENT remote transport
- `packages/aiui-remote-bar/src/backend.test.ts:10` — aiui-paint/backend.test.ts (deleted file)
- `packages/aiui-remote-bar/src/backend.ts:6` — aiui-paint (deleted)
- `packages/aiui-remote-bar/src/backend.ts:25` — aiui-paint (deleted)
- `packages/aiui-remote-bar/src/backend.ts:28` — 'the overlay' — dev-overlay-era vocabulary; no tracked code probes /bar/info cross-origin
- `packages/aiui-remote-bar/src/backend.ts:36` *(unverified)* — the /paint/ HTML page of deleted aiui-paint (the live exception is pencil's /pencil/ page)
- `packages/aiui-remote-bar/src/protocol.ts:25` — aiui-paint (deleted package; superseded by aiui-pencil — pencil/src/sidecar.ts:5 says '/paint …
- `packages/aiui-remote-bar/src/sidecar.ts:6` — aiui-paint (deleted)
- `packages/aiui-remote-bar/src/sidecar.ts:16` — aiui-paint (deleted)
- `packages/aiui-remote-bar/src/sidecar.ts:25` — the /paint/ route (not served by any tracked code; pencil serves /pencil/)
- `packages/aiui-remote-bar/src/ui/client.ts:49` — aiui-paint's client page (deleted)
- `packages/aiui-trace-ui/src/sources.ts:5` — the lab (aiui-dev-overlay)
- `packages/aiui-util/src/browser.ts:157` — the deleted aiui-paint sidecar's host page (paint is absent from the channel's standardSidecar…
- `packages/aiui-viz/src/live-signal.ts:19` — the deleted aiui-extension panel
- `packages/aiui/src/commands/claude.ts:144` — the deleted aiui-paint sidecar's /paint/ page
- `packages/aiui/src/commands/claude.ts:284` — the deleted aiui-paint sidecar
- `packages/aiui/src/commands/claude.ts:287` — the deleted aiui-paint sidecar (and the retired 'ink' vocabulary)
- `packages/aiui/src/commands/mcp.ts:27` — the deleted aiui-paint sidecar
- `packages/aiui/src/commands/pencil-url.ts:50` — a retired demo/dev server (paint-era) that duplicated lanAddresses
- `packages/aiui/src/util/aiui-args.ts:63` — the deleted aiui-paint sidecar
- `packages/aiui/src/util/config-schema.ts:152` — the deleted aiui-paint sidecar
- `packages/aiui/src/util/config.ts:112` — the deleted aiui-paint sidecar
- `packages/aiui/src/util/first-run.ts:31` — the deleted aiui-paint sidecar and a nonexistent `aiui paint url` command

### D.2 — dev-overlay references (→ A4)

- `demos/gallery/src/site/router.ts:5` *(adj)* — the retired aiui overlay; the navigation/selection watcher now lives in aiui-intent-runtime (c…
- `demos/twins/vitest.config.ts:5` — the retired overlay-injecting Vite plugin ("the overlay plugin retired (T3)", commit b3c72e9)
- `demos/walkthrough/src/model/keys.ts:7` — the retired "aiui intent overlay" as the owner of the backtick key
- `demos/walkthrough/vitest.config.ts:5` — the retired overlay-injecting Vite plugin
- `packages/aiui-claude-channel/src/channel.ts:51` *(adj)* — a file in the deleted aiui-dev-overlay package
- `packages/aiui-claude-channel/src/debug.ts:10` — aiui-dev-overlay's debug-ui (deleted); viewer now lives in aiui-trace-ui
- `packages/aiui-claude-channel/src/debug.ts:181` — the old dev-server-hosted /__aiui/debug page
- `packages/aiui-claude-channel/src/intent-v1.ts:28` — pre-greenfield clients (deleted dev overlay / old extension)
- `packages/aiui-claude-channel/src/intent-v1.ts:1313` — the deleted dev-overlay clients ('older overlays' / 'the current overlay')
- `packages/aiui-claude-channel/src/linter-sidecar.ts:101` — the deleted dev-overlay ('LEGACY overlay' / 'the current overlay')
- `packages/aiui-claude-channel/src/realtime-voice.ts:47` — docs/guide/intent-overlay.md — an 'overlay'-era guide page
- `packages/aiui-claude-channel/src/session-hub.ts:25` — the dev overlay (deleted) and the phantom code-reader view
- `packages/aiui-claude-channel/src/stats.ts:9` *(adj)* — aiui-dev-overlay (deleted package)
- `packages/aiui-claude-channel/src/web.test.ts:348` — aiui-dev-overlay (deleted package)
- `packages/aiui-claude-channel/src/web.ts:238` — aiui-dev-overlay (deleted package)
- `packages/aiui-claude-channel/src/web.ts:279` — the dev overlay (deleted); now the intent client's turn host
- `packages/aiui-intent-client/src/ext/capture.ts:139` — aiui-dev-overlay, the deleted original web intent tool
- `packages/aiui-intent-client/src/lanes.ts:6` *(adj)* — aiui-dev-overlay (deleted); the imports now live in aiui-intent-runtime
- `packages/aiui-intent-client/src/lanes.ts:199` — aiui-dev-overlay — the next line says 'the overlay renders a dedicated label' in PRESENT tense
- `packages/aiui-intent-client/src/lanes.ts:375` — aiui-dev-overlay (deleted)
- `packages/aiui-intent-client/src/lanes.ts:574` — the deleted dev-overlay's modality.ts (named on line 575)
- `packages/aiui-intent-client/src/page/jump-mode.test.ts:4` — deleted aiui-dev-overlay
- `packages/aiui-intent-client/src/page/jump-mode.ts:3` — files inside deleted packages/aiui-dev-overlay
- `packages/aiui-intent-client/src/page/jump-mode.ts:4` — packages/aiui-dev-overlay (the original web intent tool)
- `packages/aiui-intent-client/src/page/jump-mode.ts:14` — deleted aiui-dev-overlay picker
- `packages/aiui-intent-client/src/spec.ts:54` *(adj)* — aiui-dev-overlay (deleted) — 'the overlay's vscode mode'
- `packages/aiui-intent-client/src/transport.ts:19` — aiui-dev-overlay (deleted), and an 'anticipated' jump feature that has since shipped via the s…
- `packages/aiui-intent-client/src/ui/panes.test.tsx:13` *(adj)* — deleted aiui-dev-overlay
- `packages/aiui-intent-client/src/ui/turn-preview.tsx:2` — deleted aiui-dev-overlay
- `packages/aiui-intent-client/src/ui/turn-preview.tsx:26` — deleted aiui-dev-overlay file multimodal/preview.tsx
- `packages/aiui-intent-runtime/src/selection.ts:5` — aiui-dev-overlay (now DELETED, not frozen) and an untracked handoff doc
- `packages/aiui-lowering-pipeline/src/config.ts:9` — aiuiDevOverlay() from the deleted aiui-dev-overlay package
- `packages/aiui-lowering-pipeline/src/config.ts:183` — the retired dev-overlay as the thing a user launches
- `packages/aiui-lowering-pipeline/src/config.ts:374` — an advanced-config.ts module
- `packages/aiui-lowering-pipeline/src/config.ts:386` — the retired dev-overlay as expandTier's client-side consumer
- `packages/aiui-lowering-pipeline/src/engine.test.ts:662` *(adj)* — the retired dev-overlay modality as the pre-filtering caller
- `packages/aiui-lowering-pipeline/src/engine.ts:60` — the retired dev-overlay as a current Engine host
- `packages/aiui-lowering-pipeline/src/engine.ts:124` — the retired dev-overlay as the implicit-turn host
- `packages/aiui-lowering-pipeline/src/engine.ts:310` — the retired dev-overlay modality
- `packages/aiui-lowering-pipeline/src/engine.ts:478` — the retired dev-overlay's navigation watcher
- `packages/aiui-lowering-pipeline/src/engine.ts:603` — an overlay turn-store.ts module
- `packages/aiui-lowering-pipeline/src/index.ts:8` — the retired dev-overlay's modality as the sharing consumer
- `packages/aiui-lowering-pipeline/src/keymap.ts:5` — the retired dev-overlay
- `packages/aiui-lowering-pipeline/src/types.ts:62` — the deleted overlay; selection.ts now lives in aiui-intent-runtime/src/selection.ts
- `packages/aiui-lowering-pipeline/src/types.ts:237` — an overlay navigation.ts module
- `packages/aiui-pencil/client/vite.config.ts:16` *(adj)* — the aiui locator/instrumentation Vite plugin under its retired 'dev-overlay' name
- `packages/aiui-pencil/vite.config.ts:19` — deleted aiui-dev-overlay's Vite-config experience
- `packages/aiui-pencil/vite.config.ts:24` *(adj)* — a config recipe living in deleted aiui-dev-overlay
- `packages/aiui-remote-bar/src/backend.ts:328` — 'the overlay' probe (no tracked prober of /bar/info exists)
- `packages/aiui-remote-bar/src/sidecar.ts:18` — 'the overlay' probe (no tracked consumer)
- `packages/aiui-source-processor/src/index.ts:4` *(adj)* — the deleted aiui-dev-overlay (lineage)
- `packages/aiui-source-processor/src/source-locator.ts:3` — the deleted dev overlay and the old packages/aiui-demo (now demos/gallery)
- `packages/aiui-source-processor/src/source-locator.ts:13` — the retired overlay as the sourceRoot injector
- `packages/aiui-source-processor/src/source-locator.ts:63` — the aiuiDevOverlay() API of the deleted packages/aiui-dev-overlay
- `packages/aiui-test-app/package.json:4` — the retired "intent overlay" (packages/aiui-dev-overlay, the original web intent tool)
- `packages/aiui-test-app/src/ui/App.tsx:19` — the retired aiui overlay (dev-overlay) as the thing the backtick arms
- `packages/aiui-trace-ui/src/event-panes.ts:4` — the workbench lab (aiui-dev-overlay) and aiui-devtools-extension, both deleted ghost packages
- `packages/aiui-trace-ui/src/event-panes.ts:26` — the lab dev server's /api/preview proxy (aiui-dev-overlay era)
- `packages/aiui-trace-ui/src/index.ts:6` — the workbench lab, the debug surface of the deleted aiui-dev-overlay package
- `packages/aiui-trace-ui/src/index.ts:23` — the lab's dock (aiui-dev-overlay, deleted)
- `packages/aiui-trace-ui/src/styles.ts:6` *(adj)* — the lab dock (aiui-dev-overlay) and aiui-devtools-extension panel, both deleted
- `packages/aiui-trace-ui/src/styles.ts:184` *(adj)* — aiui-dev-overlay's mm-diff CSS (deleted)
- `packages/aiui-trace-ui/src/trace-view.ts:94` *(adj)* — aiui-dev-overlay's mm-thumb CSS (deleted)
- `packages/aiui-trace-ui/src/trace-view.ts:784` *(adj)* — aiui-dev-overlay's correction flash (deleted)
- `packages/aiui-trace-ui/src/trace-view.ts:868` *(adj)* — aiui-dev-overlay's mm-thumb-peek widget (deleted)
- `packages/aiui-trace-ui/src/traces-pane.ts:6` — the workbench lab (aiui-dev-overlay)
- `packages/aiui-trace-ui/src/vite.ts:5` — the aiui-dev-overlay Vite plugin (deleted)
- `packages/aiui-util/src/browser.ts:176` *(adj)* — aiui-dev-overlay's speech.ts (package deleted; readable only in git history)
- `packages/aiui-util/src/provenance.ts:52` — the deleted aiui-dev-overlay package, used as the doc example for packageFromSource
- `packages/aiui-viz/src/agent-tools.ts:25` — packages/aiui-dev-overlay (deleted)
- `packages/aiui-viz/src/agent-tools.ts:46` — aiui-dev-overlay/handoff/frontend-tool-registry.md, deleted with the package
- `packages/aiui-viz/src/agent-tools.ts:71` — the deleted overlay's ws tools bridge
- `packages/aiui-viz/src/agent-tools.ts:87` — the deleted dev overlay's late bridge-install announcement (aiui:tools-ready)
- `packages/aiui-viz/src/agent-tools.ts:101` — the deleted overlay's ws bridge
- `packages/aiui-viz/src/agent-tools.ts:170` — the deleted overlay's late-install scenario
- `packages/aiui-viz/src/aiui-global.ts:10` — the deleted overlay's tools bridge
- `packages/aiui-viz/src/aiui-global.ts:81` — the deleted overlay's ws bridge
- `packages/aiui-viz/src/cell-view.tsx:56` — the deleted dev overlay as the consumer of data-cell/data-cell-loc stamps
- `packages/aiui-viz/src/cell.test.ts:450` — the deleted dev overlay; the ladder now lives in aiui-intent-runtime/vscode.ts and aiui-intent…
- `packages/aiui-viz/src/cell.ts:140` — attribution consumers that now live in aiui-intent-client (page/jump-mode.ts) and aiui-intent-…
- `packages/aiui-viz/src/control.ts:161` — the deleted aiui-dev-overlay package's Vite plugin API
- `packages/aiui-viz/src/hot-graph.ts:27` — the deleted dev overlay's Vite-plugin integration; the live plugin is aiui() in aiui-source-pr…
- `packages/aiui-viz/src/hot-graph.ts:52` — agent-tools.ts's OverlayToolsBridge, itself named for the deleted overlay
- `packages/aiui-viz/src/modal/diff.ts:5` — the deleted dev overlay's intent pipeline
- `packages/aiui-viz/src/modal/flash.ts:41` — the deleted overlay's mm- CSS class names
- `packages/aiui-viz/src/modal/index.ts:4` — the deleted dev overlay
- `packages/aiui-viz/src/modal/index.ts:28` — the deleted overlay's intent pipeline as the node-side wordDiff consumer
- `packages/aiui-viz/src/modal/keys.ts:8` — the deleted dev overlay
- `packages/aiui-viz/src/modal/reconcile.ts:7` — a bug in the deleted dev overlay
- `packages/aiui-viz/src/site/tex.tsx:15` — the deleted dev overlay's selection watcher
- `packages/aiui-viz/vite.config.ts:27` — the deleted aiui-dev-overlay package's vite config
- `packages/aiui-viz/vite.config.ts:61` — the deleted overlay's intent pipeline as the modal subpath's node consumer
- `packages/aiui-vscode/package.json:4` — the deleted aiui-dev-overlay (the original web intent tool)
- `packages/aiui-vscode/src/contribution.ts:2` — the deleted aiui-dev-overlay as the payload's consumer
- `packages/aiui-vscode/src/contribution.ts:6` — session-contrib.ts in the deleted aiui-dev-overlay — no file of that name exists anywhere in t…
- `packages/aiui-vscode/src/extension.ts:91` — dev-overlay-hosting app tabs (role "app") — no tracked client greets the session hub with role…
- `packages/aiui-vscode/src/extension.ts:198` — mounting the deleted aiui-dev-overlay in an app page
- `packages/aiui-vscode/src/index.ts:2` — the deleted aiui-dev-overlay
- `packages/aiui/src/util/config-schema.ts:22` — the deleted aiui-dev-overlay's Vite plugin and a nonexistent guide page
- `packages/aiui/src/util/openai-preflight.ts:4` — the deleted aiui-dev-overlay ('the overlay')
- `packages/aiui/src/util/openai-preflight.ts:122` — the deleted aiui-dev-overlay
- `packages/aiui/src/util/openai-preflight.ts:126` — the deleted dev overlay and the nonexistent docs/guide/intent-overlay.md
- `packages/aiui/test/openai-pipeline.e2e.ts:12` — the deleted aiui-dev-overlay (the prompt now lives in the channel/lowering pipeline)
- `packages/create-aiui/src/cli.ts:94` — the retired dev overlay's arming UX and 'overlay' vocabulary
- `packages/create-aiui/templates/app/src/main.tsx:10` — the retired dev overlay's arming UX
- `packages/create-aiui/templates/app/src/ui/Banner.tsx:15` — the retired dev overlay's arming UX
- `packages/create-aiui/templates/app/vitest.config.ts:5` — an overlay-injecting vite plugin that no longer exists
- `scripts/new-demo.ts:178` *(adj)* — aiui-dev-overlay's vite plugin (deleted package); the identifier aiuiDevOverlay exists nowhere…
- `scripts/new-demo.ts:225` — the retired dev overlay's arming UX (backtick key + floating ✳ button)

### D.3 — old extension / devtools-extension references (→ A4)

- `biome.json:16` — packages/aiui-extension (the deleted first browser extension)
- `packages/aiui-claude-channel/src/debug.test.ts:231` — aiui-devtools-extension panel (deleted)
- `packages/aiui-claude-channel/src/debug.ts:166` — aiui-devtools-extension panel (deleted)
- `packages/aiui-claude-channel/src/frame.ts:34` *(adj)* — aiui-devtools-extension (deleted)
- `packages/aiui-claude-channel/src/launch-info.ts:11` — aiui-devtools-extension panel (deleted); the console dashboard renders launch info now
- `packages/aiui-claude-channel/src/page-tools.test.ts:22` — the old extension's service worker
- `packages/aiui-claude-channel/src/page-tools.ts:249` — the old extension's service worker as the activation sender
- `packages/aiui-claude-channel/src/stats.ts:6` *(adj)* — aiui-devtools-extension (deleted package)
- `packages/aiui-claude-channel/src/summarize.ts:9` — the DevTools panel (aiui-devtools-extension, deleted)
- `packages/aiui-intent-client/src/caps.ts:143` — the deleted aiui-extension panel UI, plus a 'Phase-2 lanes' future that has arrived (lanes.ts …
- `packages/aiui-intent-client/src/cdp/page-script.ts:4` — the old extension's content script (aiui-extension/aiui-webext, deleted)
- `packages/aiui-intent-client/src/cdp/page-script.ts:70` *(adj)* — the deleted frozen extension; also points at 'the coexistence policy in the client's README'
- `packages/aiui-intent-client/src/cdp/page-script.ts:630` — the frozen old extension (aiui-webext), deleted from the tracked tree
- `packages/aiui-intent-client/src/cdp/page-script.ts:636` — the frozen aiui-webext/aiui-extension browser extension's on-page ring indicator (packages/aiu…
- `packages/aiui-intent-client/src/claims.ts:3` — the deleted aiui-extension panel's syncPencilSurface/syncTabStream/syncVideo functions (mappin…
- `packages/aiui-intent-client/src/client.test.ts:305` — the deleted frozen extension — the whole describe block tests machinery whose real-world trigg…
- `packages/aiui-intent-client/src/config.ts:5` — a source file inside the deleted aiui-extension package
- `packages/aiui-intent-client/src/ext/capture.ts:3` *(adj)* — the deleted aiui-extension capture module and its RESULTS.md (M10/M1/M2 measurement labels cit…
- `packages/aiui-intent-client/src/ext/channel.ts:25` — the frozen old extension's storage namespace — the reason for the `2` suffix in aiui2.config /…
- `packages/aiui-intent-client/src/ext/content-main.ts:10` — 'one day jump-to-editor' — implemented in this very file (job 3, lines 17-19 and the armJump h…
- `packages/aiui-intent-client/src/ext/content.ts:242` — the deleted/frozen aiui-extension — the whole coexistence-detector block (lines 241-266)
- `packages/aiui-intent-client/src/ext/extension-bus.test.ts:172` — the frozen old extension (aiui-extension)
- `packages/aiui-intent-client/src/ext/manifest.ts:14` — the frozen old extension (aiui-extension), deleted from tracking but kept as an installed 'saf…
- `packages/aiui-intent-client/src/ext/panel.tsx:120` — the deleted aiui-extension (source of the CSP worklet measurement)
- `packages/aiui-intent-client/src/ext/protocol.ts:91` — the DOM id of the deleted aiui-extension/aiui-webext on-page indicator
- `packages/aiui-intent-client/src/ext/relay.ts:6` — the deleted aiui-webext package
- `packages/aiui-intent-client/src/ext/sw.ts:5` — the deleted aiui-extension service worker
- `packages/aiui-intent-client/src/keys.ts:3` — aiui-extension's panel leader.ts (package deleted from the tracked tree; ghost dir only)
- `packages/aiui-intent-client/src/session.ts:17` — the deleted devtools-extension panel's bus.ts and the retirement-era 'salvage list'
- `packages/aiui-intent-client/src/spec.ts:5` — the deleted aiui-devtools-extension panel's main.tsx
- `packages/aiui-intent-client/src/spec.ts:236` — the deleted old extension client
- `packages/aiui-intent-client/src/transport.ts:5` — the deleted aiui-extension's content script
- `packages/aiui-intent-client/src/transport.ts:96` — the deleted aiui-extension/aiui-webext relay protocol
- `packages/aiui-intent-client/src/transport.ts:116` — the frozen old extension (aiui-extension), deleted from the tracked tree
- `packages/aiui-intent-client/src/ui/channel-header.tsx:3` — deleted aiui-extension's connection chip
- `packages/aiui-intent-client/src/ui/turn-preview.tsx:148` — the retired extension side panel (aiui-extension / devtools-panel era)
- `packages/aiui-intent-runtime/src/instrumentation.ts:2` — aiui-devtools-extension (deleted)
- `packages/aiui-intent-runtime/src/instrumentation.ts:7` — the DevTools panel (deleted devtools extension)
- `packages/aiui-intent-runtime/src/instrumentation.ts:205` — aiui-devtools-extension (deleted) — the only writer of data-aiui-tab
- `packages/aiui-intent-runtime/src/instrumentation.ts:245` — aiui-devtools-extension (deleted)
- `packages/aiui-trace-ui/src/sources.ts:7` — the old extension (aiui-devtools-extension / aiui-extension, both deleted)
- `packages/aiui-trace-ui/src/styles.ts:43` *(adj)* — the lab dock and DevTools extension
- `packages/aiui-trace-ui/src/trace-view.ts:25` *(adj)* — aiui-devtools-extension (deleted)
- `packages/aiui-trace-ui/src/trace-view.ts:70` *(adj)* — originally the DevTools extension's cross-origin embedding
- `packages/aiui-util/src/browser.ts:7` — aiui-devtools-extension (the DevTools panel), deleted from the tracked tree
- `packages/aiui-util/src/browser.ts:18` *(adj)* — the retired aiui-devtools-extension autoload in the aiui CLI
- `packages/aiui-util/src/extension.ts:6` — the frozen/deleted aiui-extension's CRXJS dev loop
- `packages/aiui-util/src/extension.ts:24` — the deleted aiui-extension package and its reload.html wake page
- `packages/aiui-util/src/extension.ts:198` — the deleted aiui-webext package's dev-stamp module
- `packages/aiui-viz/src/live-signal.ts:14` — packages/aiui-extension (the frozen safety-net extension), deleted from the tracked tree
- `packages/aiui/src/commands/claude.ts:304` — the deleted aiui-devtools-extension
- `packages/aiui/src/util/chrome.ts:260` — a deleted sibling code block (the old extension's resolution ladder) that contained the origin…
- `packages/aiui/src/util/chrome.ts:281` — the deleted (formerly frozen) aiui-extension and its build-on-launch ladder
- `scripts/versioning.mjs:82` — the deleted extension manifests (aiui-extension's static manifest.json and the webext/devtools…

### D.4 — dead documentation pointers (→ A5)

- `packages/aiui-claude-channel/src/elevenlabs-realtime.ts:13` — A machine-local findings file in the gitignored .aiui-cache/
- `packages/aiui-claude-channel/src/intent-v1.ts:14` — an untracked 'graduation handoff' design doc
- `packages/aiui-claude-channel/src/intent-v1.ts:40` — streaming-turns.md — a design doc absent from the tracked tree
- `packages/aiui-claude-channel/src/intent-v1.ts:208` — transcription-and-realtime-submodes.md — untracked design doc
- `packages/aiui-claude-channel/src/live-session.ts:24` *(adj)* — docs/proposals/realtime_pivot_plan.md
- `packages/aiui-claude-channel/src/prompt-context.ts:90` — streaming-turns.md — untracked design doc
- `packages/aiui-claude-channel/src/realtime-voice.ts:5` — model-tiers.md design doc
- `packages/aiui-claude-channel/src/realtime.ts:10` — streaming-turns.md design doc
- `packages/aiui-claude-channel/src/speak.ts:6` — Design docs streaming-turns.md and model-tiers.md
- `packages/aiui-claude-plugin/marketplace/.claude-plugin/marketplace.json:16` — a drafts-stage frontend-design skill; the actual SKILL.md is a full 290-line skill and its plu…
- `packages/aiui-claude-plugin/marketplace/.claude-plugin/marketplace.json:21` — a session-browser draft in drafts/ that does not exist (drafts/ contains only frontend-design-…
- `packages/aiui-lowering-pipeline/src/config.ts:57` — a streaming-turns.md document
- `packages/aiui-lowering-pipeline/src/config.ts:60` — a model-tiers.md document
- `packages/aiui-lowering-pipeline/src/config.ts:125` — openai-audio-stack.md — now at archive/workbench/openai-audio-stack.md
- `packages/aiui-lowering-pipeline/src/config.ts:139` — realtime_prompt_linter_design.md — now at archive/realtime_prompt_linter_design.md
- `packages/aiui-trace-ui/src/trace-cards.ts:388` *(adj)* — a handoff/ directory that does not exist in the tracked tree (git ls-files handoff is empty)
- `packages/aiui-viz/src/cell-view.tsx:5` — a docs/ path that moved to archive/reactive-flows/solid-cells-solidjs_v2.md
- `packages/aiui-viz/src/graph-trace.ts:7` *(adj)* — a proposal document that does not exist in the tracked tree
- `packages/aiui/src/util/openai-preflight.ts:7` — a multimodal-intent-graduation handoff doc that is not in the tracked tree
- `packages/aiui/test/openai-pipeline.e2e.ts:27` — an untracked multimodal-intent-graduation.md plan doc
- `packages/create-aiui/src/scaffold.ts:5` — the retired `aiui demo` command and packages/aiui/templates/demo

### D.5 — other confirmed drift (→ A2 and misc)

- `packages/aiui-claude-channel/src/agents.ts:7` — a `list_channels` MCP tool that does not exist
- `packages/aiui-claude-channel/src/cost.ts:4` — the corrector (retired pipeline stage)
- `packages/aiui-claude-channel/src/cost.ts:101` — the corrector (retired)
- `packages/aiui-claude-channel/src/gemini-live.ts:9` — The deleted composer-era submit_intent machinery
- `packages/aiui-claude-channel/src/intent-v1.linter.test.ts:73` — Composer-era LiveSession methods (nudgeSubmit, drainToolCall) that no longer exist on the inte…
- `packages/aiui-claude-channel/src/live-resolve.test.ts:8` — Fixture for the deleted resolveSegments tests
- `packages/aiui-claude-channel/src/live-resolve.test.ts:35` — The deleted resolve/re-attach step
- `packages/aiui-claude-channel/src/openai-live.ts:11` — The deleted composer-era submit_intent machinery
- `packages/aiui-claude-channel/src/prompt-context.ts:142` — older intent-v1 clients' legacy context frame (deleted clients)
- `packages/aiui-claude-channel/src/sidecar.ts:11` — the old launcher-injected sidecar architecture
- `packages/aiui-claude-channel/src/standard-sidecars.ts:33` — an earlier three-sidecar set (before the console sidecar joined)
- `packages/aiui-console/app/main.tsx:21` — the loopback-only channel assumption
- `packages/aiui-intent-client/src/cdp/cdp-bus.ts:186` — 'the old client's lastActiveTab' — the deleted extension client
- `packages/aiui-intent-client/src/cdp/page-bundle.ts:3` — a superseded delivery mechanism — the header claims the bundle 'arrives as an ES module over t…
- `packages/aiui-intent-client/src/config.ts:6` — a then-future Phase 2 that has since shipped — lanes.ts binds these controls now
- `packages/aiui-intent-client/src/config.ts:88` — the retired keyboard-chord zoom implementation
- `packages/aiui-intent-client/src/ext/content.ts:496` — an 'anticipated' locate capability whose motivating feature (jump-to-editor) has since shipped…
- `packages/aiui-intent-client/src/ext/manifest.ts:116` — an early five-line version of content-main.ts — the file is now 123 lines (tools bridge + jump…
- `packages/aiui-intent-client/src/ext/side-panel-zoom.test.tsx:5` — a discarded font-size-based zoom implementation — the shipped code sets CSS `zoom` and its com…
- `packages/aiui-intent-client/src/lanes.ts:51` — the deleted devtools panel's turn.ts (also referenced at lines 17 and 94)
- `packages/aiui-intent-client/src/lanes.ts:328` — the deleted devtools panel
- `packages/aiui-intent-client/src/page/pencil-mount.test.ts:75` — the deleted pen-only capture shim from pencil-mount's first integration
- `packages/aiui-intent-client/src/page/pencil-mount.ts:13` — the first cut of this same file (git history only)
- `packages/aiui-intent-client/src/ui/channel-header.tsx:16` — a decision recorded against the deleted extension's chip
- `packages/aiui-intent-client/src/ui/panel.test.tsx:5` — the retired extension panel (pre-greenfield client)
- `packages/aiui-intent-runtime/src/errors.ts:23` — the DevTools panel (deleted)
- `packages/aiui-intent-runtime/src/instrumentation.ts:149` — the DevTools panel (deleted)
- `packages/aiui-intent-runtime/src/instrumentation.ts:171` — a web.test.ts in this package (does not exist; aiui-claude-channel/src/web.test.ts does)
- `packages/aiui-intent-runtime/src/protocol.ts:215` — the DevTools panel (deleted)
- `packages/aiui-intent-runtime/src/selection.ts:70` *(adj)* — correct mode — removed in the append-only pivot (see the note in aiui-lowering-pipeline/src/en…
- `packages/aiui-lowering-pipeline/src/fixtures.test.ts:12` — the retired Option-C assembly scheme
- `packages/aiui-lowering-pipeline/src/index.ts:6` — the retired Option-C {shot_n} token + meta-map prompt scheme
- `packages/aiui-lowering-pipeline/src/keymap.ts:14` — H as the help key — retired in-file
- `packages/aiui-lowering-pipeline/src/keymap.ts:237` *(adj)* — the removed E (correct-mode) binding
- `packages/aiui-lowering-pipeline/src/render.ts:281` — the channel's composer-era resolveSegments path
- `packages/aiui-lowering-pipeline/src/types.ts:288` — the retired Option-C token+meta rendering
- `packages/aiui-lowering-pipeline/src/types.ts:362` — a correct.ts module (the correction micro-pipeline's channel side)
- `packages/aiui-pencil/lab/src/model/pad-renderer.ts:10` — PencilSurface as a future artifact
- `packages/aiui-pencil/src/client-static.ts:7` — a file that does not exist in the tracked tree
- `packages/aiui-pencil/src/client/app.tsx:11` — the pencil Lab's former in-lab client page, since moved into src/client/
- `packages/aiui-pencil/src/index.ts:14` — the package's own not-yet-built phases — which HAVE shipped
- `packages/aiui-remote-bar/src/protocol.ts:148` *(unverified)* — an __AIUI__.port write path and a registry-resolution wiring that exist nowhere in tracked code
- `packages/aiui-remote-bar/src/sidecar.ts:9` — an __AIUI__.port that no tracked code writes
- `packages/aiui-trace-ui/src/debug-page.ts:4` — the plugin-served /__aiui/debug page
- `packages/aiui-trace-ui/src/debug-page.ts:9` — the loopback-only channel bind
- `packages/aiui-trace-ui/src/debug-page.ts:66` — aiui debug/aiui vite injecting a channel port into this page
- `packages/aiui-trace-ui/src/event-panes.ts:36` — the lab's settings drawer (deleted)
- `packages/aiui-trace-ui/src/paths.ts:9` — the lab's dev server (deleted)
- `packages/aiui-trace-ui/src/styles.ts:8` — the channel-served /debug HTML viewer
- `packages/aiui-trace-ui/src/styles.ts:223` — the retired scrolling row-list picker design of TracesPane
- `packages/aiui-trace-ui/src/traces-pane.ts:7` — the plugin-served debug page / plugin-backed aiui debug
- `packages/aiui-trace-ui/src/vite.ts:9` — an earlier `aiui debug` that stood up its own Vite server with this plugin
- `packages/aiui-viz/src/modal/keys.ts:55` — the deleted extension panel's Font Awesome SVG bundling
- `packages/aiui-viz/src/mode-solid.ts:26` — the deleted extension panel's control-mirror desync bug

### D.6 — managed-browser terminology lag (→ A2)

- `packages/aiui/src/commands/debug.ts:10` *(adj)* — Chrome for Testing as THE session browser
- `packages/aiui/src/commands/vite.ts:207` *(adj)* — the CfT-only era of the managed-browser sync

### D.7 — aiui-demo / aiui demo relics (→ A2)

- `packages/aiui-claude-channel/src/processors.test.ts:77` — packages/aiui-demo (moved to demos/gallery)
- `packages/create-aiui/src/scaffold.test.ts:46` — the `aiui: { demo: true }` marker only the retired `aiui demo` scaffolder wrote
- `packages/create-aiui/src/scaffold.ts:12` — the retired `aiui demo` scaffolder's marker contract

### D.8 — workbench-lab mentions (→ A0 cat. 2/3)

- `packages/aiui-trace-ui/src/event-panes.test.ts:5` — the workbench lab
- `packages/aiui-trace-ui/src/styles.ts:4` — the workbench lab and its wb-insp-* stylesheet

### D.9 — refuted by the verifiers (excluded; keep as is)

- `demos/july09/vite.config.ts:11` — Quote verified at lines 11-12, but the comment is accurate and current: it states what the aiui() plugin does NOT do ('Nothing el…
- `packages/aiui-claude-channel/src/gemini-live.ts:35` — The comment describes a live, deliberately retained compat path, not a dangling referent: intent-v1.ts:1311-1330 (onVideoChunk, '…
- `packages/aiui-claude-channel/src/transcribe.ts:4` — The comment is accurate and current: it already says the workbench lab is 'retired', and the referent is tracked at archive/workb…
- `packages/aiui-intent-runtime/src/audio.ts:8` — Quote spans lines 7-8. Accurate past-tense provenance, and the workbench lab's remains ARE tracked: archive/workbench/ (field-not…
- `packages/aiui-intent-runtime/src/index.ts:3` — Quote present at line 3. But the comment is accurate and self-aware: it says 'retired dev overlay ... the original is deleted — r…
- `packages/aiui-intent-runtime/src/locator.ts:17` — Quote at lines 16-17. The comment is accurate, self-aware history ('died with the dev overlay') and its present-tense half — the …
- `packages/aiui-intent-runtime/src/talk-lanes.ts:3` — Quote spans lines 3-4 (verbatim twin of wire.ts). Same grounds: accurate past-tense history; B2.4 documented in tracked docs/prop…
- `packages/aiui-intent-runtime/src/transcribe.ts:11` — Quote at lines 11-13. Same grounds as audio.ts:8: accurate historical justification, referent readable in tracked archive/workben…
- `packages/aiui-intent-runtime/src/wire.ts:3` — Quote spans lines 3-4. Accurate past-tense provenance, and 'B2.4' is resolvable from the tracked tree: docs/proposals/dev-overlay…
- `packages/aiui-source-processor/src/index.ts:25` — Quote at line 4, but this is accurate past-tense provenance, not a stale claim: the module genuinely was extracted from aiui-viz/…
- `packages/aiui-trace-ui/src/trace-cards.ts:381` — Quote verified at line 381. Not a stale reference: the comment is accurate and current. The realtime submode really is retired (i…
- `packages/aiui/src/commands/extension.ts:114` — Quote verified at line 114 (printError for the retired dev/reload subactions). This is an intentional, accurate tombstone: it cor…
- `packages/aiui/src/commands/vite.ts:19` — Quote verified at line 19. Not stale: it is a deliberate, owner-dated NOTE ('owner, 2026-07-17') explaining in past tense why `ai…
- `packages/aiui/src/commands/vite.ts:137` — Quote verified at line 137 in parseViteLocalUrl's docstring. The comment already says 'retired workbench lab' — past tense, accur…
- `packages/aiui/src/program.ts:127` — Quote verified at line 127. Not a stale reference: it is a deliberate tombstone asserting the command does NOT exist, which is ac…
- `packages/aiui/src/util/config.ts:122` — Quote verified at line 122 (continuing onto 123). Not a stale reference: this is the DEPRECATED_FIELDS rationale doc, written in …

