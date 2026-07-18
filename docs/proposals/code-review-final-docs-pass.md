# Code review, final pass — docs, skills, and CLAUDE.md

**Status: proposal — awaiting markup.** This is the cleanup that passes 1 and 2 deliberately
deferred: every `.md` file, the three Claude skills, and the repo instruction files. Code is
untouched except where a doc quotes it. It is small by design — mark the response blocks and
the approved sections become the plan. (The pass-1/pass-2 records live in
`archive/code-review-pass*.md`.)

The one rule for the whole pass: **docs claim only what the code does today.** Where a doc
described something the review deleted or reshaped (REST transcription, retired surfaces,
pre-split module layouts), the fix is to describe the current design — not to narrate the
change. History belongs in `archive/` and git.

---

## A. Known stale spots (enumerated fixes)

Collected during passes 1–2; each verified still-stale before this proposal was written.

1. `packages/aiui-claude-channel/README.md:30` — imports `CHANNEL_CONFIG`, which does not
   exist (and the surrounding example predates the S4 barrel pruning). Rewrite the example
   against the current barrel (`createChannelServer`, `startWebServer`).
2. `packages/aiui-claude-plugin/…/session-browser/skills/session-browser/SKILL.md:40` — claims
   the channel port is read from `window.__AIUI__.port`; no such field exists (discovery is the
   registry + `DevToolsActivePort`). Audit the skill's whole recipe, not just this line.
3. `packages/aiui-pencil/docs/getting-started.md:19-21` — still the scaffolded `greet`
   placeholder. Replace with a real minimal `PencilSurface` example (mirroring what the
   package README already shows) or delete the page.
4. `docs/guide/transcription.md` (+ `realtime-vendors.md`, `realtime-live.md`, `config.md`,
   `prompt-linting.md` where they mention it) — REST transcription is retired; streaming is
   the only model, `"openai"` is a recorded coercion to `"openai-realtime"`, and `mock` is a
   client-local lane. Sweep every vendor/config mention against `intent-resolve.ts` and
   `docs/guide/config.md`'s echo of `IntentPipelineConfig`.
5. `packages/aiui-claude-channel/docs/websocket-protocol.md` "Source & API" section — add the
   one line the S1 pass earmarked: `aiui-intent-runtime/src/protocol.test.ts` is the
   machine-checked shadow of the prose (type-lockstep guards + byte round-trips). Also
   re-verify the doc's file pointers after the S3 split (`intent-v1.ts` → the `intent-*`
   modules; `web.ts` → `web-runtime/routes/sockets`).
6. `packages/aiui-room-relay/README.md` + `docs/getting-started.md` — scaffolded this week;
   confirm the quick-start actually compiles against the delegate seam and mentions that
   pencil/remote-bar are its two consumers.

**Response:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## B. The sweep — every `.md` verified against current code

One agent pass over `docs/guide/*.md`, package `README.md`s, `PARITY.md`/`BEHAVIOR.md`, and
`demos/*/CLAUDE.md`/`WALKTHROUGH.md`, checking every **executable claim** (a command, a path, a
symbol, a port, a config key, a quoted code block) against the code it names. Categories to
check, from what passes 1–2 changed:

- Deleted/renamed symbols and commands (the S4 unexports; the retired `aiui demo`/`config`
  era; the deleted overlay/extension surfaces — their retirement docs stay, but *current*
  guides must not point readers at them).
- Module layout claims now wrong after the S3 splits (nine files became ~30; guides that name
  `lanes.ts`, `engine.ts`'s compose half, `web.ts` internals, or `surface.ts` internals).
- New realities worth a sentence where a doc already covers the area: the channel `/internal`
  subpath (workspace-internal, no semver), the lowering `/trace-stages` subpath, the
  `aiui-room-relay` package, the typed `PageCapabilityMap` wire.
- `WALKTHROUGH.md` / `demos/walkthrough` step truthfulness (its CLAUDE.md invariant) — verify
  the steps still compile-and-narrate after the workspace-wide changes; expected no-op.

Constraint carried from the pass-1 markup: fixes rewrite claims to the present tense; no
changelog paragraphs in guides. Anything discovered that needs a *code* change gets reported,
not fixed (this pass edits docs only).

**Response:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## C. Skills audit

The three shipped skills (`aiui-workflow`, `session-browser`, `frontend-design` under
`packages/aiui-claude-plugin/marketplace/plugins/`) plus anything in `drafts/`: run each
SKILL.md's instructions mentally against the current CLI/channel/console and fix what a fresh
agent following them would get wrong (A2 is the known instance). Where a skill teaches a
workflow that pass 2 improved (e.g. trace debugging now has typed stage parsing), update the
recipe only if the old one no longer works — improving working recipes is out of scope.

**Response:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## D. CLAUDE.md + AGENTS.md

1. **Land the adopted S10 comment policy** as a short subsection in CLAUDE.md. Proposed text
   (mark up freely — this is the paragraph that will be pasted):

   > ## Comment policy
   >
   > Comments state the *current* contract — what the code guarantees, what a caller may
   > assume, what would break if changed. Never narrate where code came from, what it
   > replaced, or why a change was correct; that is review commentary, and it goes stale the
   > moment it lands. History is reserved for the rare load-bearing warning — a post-mortem
   > rule that prevents re-introducing a live failure (the voice-session file headers are the
   > model) — and even then one sentence, not an essay. When refactoring, delete the old
   > keep-in-sync/provenance commentary along with the duplication that justified it.

2. Verify CLAUDE.md's factual claims survived pass 2 (the security-posture paragraph, the
   packaging conventions, and the package inventory implied by prose — `aiui-room-relay` now
   exists; nothing else structural changed). AGENTS.md expected unchanged; verify only.

**Response:**

- [ ] Approve as proposed
- [ ] Partially (see comments)
- [ ] Defer
- [ ] Drop

Comments:

---

## Method & gates

Execution is one sitting: A (mechanical fixes) → B (sweep, one agent) → C (skills) → D
(CLAUDE.md), one commit per section or one total — your call at markup. Gates: the docs-gen
sidebar drift guard (`pnpm docs:gen` or its CI equivalent), a link check over the touched
pages, `pnpm -r typecheck` if any doc-adjacent code block is extracted into a compiled
example (none planned), and the usual biome/version checks are unaffected. Nothing here
touches package.json, publishConfig, or published code.
