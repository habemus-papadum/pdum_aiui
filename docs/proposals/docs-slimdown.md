# Docs slim-down — a per-file ruling on every markdown in the doc set

**Status: proposal — awaiting markup.** Nothing here has been executed. Mark the verdicts you
disagree with and the marked-up table becomes the plan.

**Date:** 2026-07-31.

## Why

The hand-written doc set is **30 pages / 50k words in `docs/guide/`** plus 11 proposals (35k
words) and 33 package-sourced pages (18k words). Much of it was written ahead of, or beside, the
code and has drifted. The goal is not to fix it page by page — it is to get down to **a handful
of true pages we can hold in our heads**, then grow back deliberately.

The target: **eight guide pages** (plus the motivation essay, which never goes stale). Everything
else is deleted, parked, or repositioned to where it actually belongs — usually next to the
package it documents, where `docs-gen` picks it up with no curation.

## Verdicts

| Verdict | Meaning |
| ------- | ------- |
| **FIX** | Stays where it is. Small corrections only — no rewrite. |
| **TRIM** | A keeper, cut down to a **shell**: title, the outline we want, one honest paragraph per section, and `_TODO._` where prose is owed. This is the "seven or eight documents in front of me" set. |
| **MOVE** | Content is good, location is wrong. `git mv` to a package's `docs/` (auto-listed by `docs-gen`, no sidebar edit) or to a demo. No rewrite. |
| **PARK** | Delete from the site now, rewrite later — possibly somewhere else. Content goes to `archive/docs/<name>.md` so the raw material is one `cat` away; that is the same convention `archive/` already carries ("readable on GitHub, deliberately not part of the docs site"). |
| **DROP** | Gone. Git history is the only copy anyone should ever need. |

`PARK` vs `DROP` is the only judgment call that costs anything, and it costs almost nothing:
parking is a `git mv`.

## The target: 8 pages

| # | Page | From | What it is |
| - | ---- | ---- | ---------- |
| 1 | `guide/index.md` — **Introduction** | FIX in place | What the three things are: the frontend library for agent-written visualization UIs, the intent tool, the prompt-lowering framework. Already close to right. |
| 2 | `guide/getting-started.md` — **Getting started** | TRIM + absorb `installation.md` | Keys first, then the **three run modes** (below). |
| 3 | `guide/warning.md` — **Read before running** | FIX | Safety posture. `CLAUDE.md` mandates this stays intact and accurate; it is short and current. |
| 4 | `guide/intent-panel.md` — **Using the panel** | NEW (replaces `browser-extension.md`) | The panel as the user meets it: the turn, the modes, dictation, the oracle, sending. The expansion slot for per-part guides later. |
| 5 | `guide/prompt-lowering.md` — **Prompt lowering** | TRIM | The concept: high-level multimodal intent compiled through inspectable stages. |
| 6 | `guide/frontend-for-agents.md` — **Frontend for agents** | TRIM | The concept + a pointer to the library's own docs (which move under `aiui-viz`). |
| 7 | `guide/config.md` — **Configuration & keys** | FIX | The most current file in the set — touched today. |
| 8 | `guide/development.md` — **Developing this repo** | TRIM + absorb `documentation.md`, `releasing.md` | One internal page instead of three. |
| + | `guide/motivation.md` — **Motivation** | FIX | 714 words of first-person "why". Cannot go stale; the home page's first button points at it. Keep. |

### The spec for #2, since it drives the most work

Three modes, in this order:

1. **`npx` over an existing website** — no app, no scaffold, no Vite. Install the keys, run
   `aiui claude`, prompt over pages you did not write. This is the shortest path to "what is this
   thing" and today it is buried under the scaffolder.
2. **Scaffold a new app** — `pnpm create @habemus-papadum/aiui`, the loop in two terminals.
3. **Add aiui to an app you already have** — the plugin + one CLI line (today: `installation.md`'s
   last section).

Keys come first in all three: what `aiui claude` asks on first run, where the secret goes (OS
vault), and `aiui keys` for later.

## Ledger — `docs/guide/` and the landing page (30 files)

| File | Words | Verdict | Note |
| ---- | ----: | ------- | ---- |
| `docs/index.md` | 304 | **FIX** | Home hero. Three feature cards already match the three layers; re-point the links that die. |
| `guide/index.md` | 688 | **FIX** | The introduction. Fix "two hosts" (there are three) and the dead links; otherwise keep. |
| `guide/motivation.md` | 714 | **FIX** | Timeless essay. Untouched. |
| `guide/getting-started.md` | 1581 | **TRIM** | To the three-mode shell above. Absorbs `installation.md`. |
| `guide/installation.md` | 569 | **PARK** | Folds into getting-started (its "add to your own app" section is mode 3). Overlaps getting-started nearly completely today — that duplication is half the reason the entry path reads as stale. |
| `guide/warning.md` | 933 | **FIX** | Load-bearing and accurate. Re-check the `--dangerously-skip-permissions` opt-in wording against `config.ts`. |
| `guide/config.md` | 2557 | **FIX** | Current. Trim only what points at parked pages. |
| `guide/browser-extension.md` | 607 | **DROP** | Already a self-declared stub of `_TODO._` sections. Its outline is the seed for the new `intent-panel.md`; the file itself is not worth carrying. |
| `guide/prompt-lowering.md` | 1434 | **TRIM** | Keeper. Cut the layer-2/layer-3 recaps that duplicate the introduction. |
| `guide/frontend-for-agents.md` | 2374 | **TRIM** | Keeper as the *concept* page. The methodology moves (next rows). |
| `guide/frontend-user-guide.md` | 5336 | **MOVE** → `packages/aiui-viz/docs/` | This is the library's user guide, not a site guide. `docs-gen` lists it under the package automatically. |
| `guide/frontend-playbook.md` | 2126 | **MOVE** → `packages/aiui-viz/docs/` | Same. |
| `guide/frontend-design-choices.md` | 2915 | **MOVE** → `packages/aiui-viz/docs/` | Same. |
| `guide/frontend-hard-won.md` | 2711 | **MOVE** → `packages/aiui-viz/docs/` | Same. Version-pinned notes; belongs beside the code that pins them. |
| `guide/frontend-style-guide.md` | 1837 | **MOVE** → `packages/aiui-viz/docs/` | Same. |
| `guide/duckdb-mosaic.md` | 2362 | **MOVE** → `packages/aiui-viz/docs/` | The page you named. `aiui-viz` exports `./duckdb` and `./mosaic`; `demos/seismos` is the worked example. Good content, wrong shelf. |
| `guide/oracle.md` | 1569 | **PARK** | Real and recent, but it is a *part of the panel*. Raw material for the panel guide's oracle section. |
| `guide/prompt-linting.md` | 1241 | **PARK** | Same — a panel feature, not a top-level guide. |
| `guide/transcription.md` | 1385 | **PARK** | Same. Merge-worthy into a future "dictation" section. |
| `guide/realtime-live.md` | 1906 | **PARK** | Engine internals behind the linter. |
| `guide/realtime-vendors.md` | 1106 | **PARK** | Vendor wire notes — the most perishable page in the set (last touched 2026-07-09). |
| `guide/attribution.md` | 1683 | **PARK** | Sharp and true, but it is the *mechanism* under lowering. Comes back as a concepts page when there is a concepts section. |
| `guide/channel.md` | 1650 | **PARK** | Internals of the hub process. Belongs next to `aiui-claude-channel` when rewritten. |
| `guide/chrome.md` | 2390 | **PARK** | The managed-browser story. Half of it is config surface that `config.md` already carries. |
| `guide/remote.md` | 948 | **PARK** | Real feature, narrow audience. |
| `guide/vscode.md` | 970 | **MOVE** → `packages/aiui-vscode/docs/` | It documents the extension; the extension has a package with a `docs/` dir already. |
| `guide/prompt-rendering.md` | 4212 | **MOVE** → `packages/aiui-claude-channel/docs/` | **Generated** ("do not edit" — `render-audit --docs`). Re-point the generator's output path; then it stays fresh and off the guide nav forever. See gate 3. |
| `guide/development.md` | 1400 | **TRIM** | The one internal page. Absorbs the two below. |
| `guide/documentation.md` | 443 | **PARK** | Becomes a section of `development.md` ("how the site is generated"). |
| `guide/releasing.md` | 622 | **PARK** | Becomes a section of `development.md`; `AGENTS.md` + `CLAUDE.md` already hold the guardrails, and this page restates them. |

**Result:** 29 guide pages → 9. ~50k words → ~10k in the guide, with ~17k relocated (still on the
site, under packages) and ~14k parked in `archive/docs/`.

## Ledger — `docs/proposals/` (11 files, 35k words)

These are **already invisible to readers** (the folder is off the nav) so they are low priority —
but the folder is where "what is true now" goes to die, and `CLAUDE.md`'s own convention is that
finished notes retire to `archive/`.

| File | Words | Verdict | Note |
| ---- | ----: | ------- | ---- |
| `intent-oracle.md` | 3579 | **KEEP** | Accepted 2026-07-30, actively executing (O3). |
| `aiui-oracle.md` | 3298 | **KEEP** | Accepted; O3 builds directly on it. Retire together with the above when O3 lands. |
| `browser-profiles.md` | 1043 | **PARK** → `archive/` | Marked IMPLEMENTED 2026-07-20. |
| `named-configs-and-setup-interview.md` | 2679 | **PARK** → `archive/` | Marked SUPERSEDED by the row above. |
| `aiui-registry.md` | 2760 | **PARK** → `archive/` | The package exists in `bootstrap/` with its own CI; confirm the last milestone before moving. |
| `aiui-registry-plan.md` | 1134 | **PARK** → `archive/` | With its proposal. |
| `native-host-flow.md` | 2096 | **PARK** → `archive/` | Explicitly "descriptive, not a proposal" — a baseline snapshot, which is what `archive/` is for. |
| `desktop-roadmap.md` | 2113 | **PARK** → `archive/` | Phases B–F′ delivered 2026-07-29; Phase A deferred. Note the deferral in `TODO.md` and park. |
| `deployment-shapes.md` | 4510 | **KEEP** | Still the design reference for the two-host `apps/*` work in flight. |
| `claude-code-usage-analytics.md` | 11147 | **MOVE** → travels with `apps/cc-assay` when it is evicted | Largest file in the repo's docs; it documents an app that is staged to leave. Until eviction, no reason for it to sit in `docs/`. |
| `code-review-final-docs-pass.md` | 965 | **DROP** | This document supersedes it — it is the same pass, never marked up. |

## Ledger — package-sourced pages (33 files, 18k words)

`docs/packages/**` is **generated** from `packages/*/README.md` and `packages/*/docs/*.md`. These
stay close to their code and are mostly healthy; **no blanket action**. Three notes:

- **18 READMEs** — leave. They are the package overview pages; drift here is a normal PR-sized fix.
- **13 `docs/getting-started.md`** (one per package) — leave, but they are the natural landing spot
  for anything parked above, since a package guide needs no sidebar curation.
- **`aiui-claude-channel/docs/{architecture,websocket-protocol}.md`** (6.9k words) — **FIX**:
  `websocket-protocol.md` is the biggest single reference in the package set and the one most
  likely to have drifted; worth a targeted read once the guide work is done.

Adjacent, not part of the site, listed so the ruling is complete: `README.md` (**FIX** — it is the
GitHub front door and duplicates the introduction), `CLAUDE.md` / `AGENTS.md` (**FIX** — update the
`docs/guide/*` pointers this plan invalidates), `TODO.md` (**FIX**), `packages/aiui-intent-client/BEHAVIOR.md`
(**KEEP** — the decided contract), `archive/**` (**leave** — that is the parking lot).

## What breaks when we delete a page (the gates)

Four mechanisms will fail loudly, which is good — but they must be handled in the same commit:

1. **`docs:gen` sidebar drift guard.** The guide sidebar is curated in `scripts/docs-gen.mjs` and
   generation *throws* if a page has no link or a link has no page. Every delete/move is also a
   sidebar edit. (The `packages/*/docs/` destination has no such cost — it is auto-listed. That is
   the argument for MOVE over PARK wherever the content is still true.)
2. **`pnpm skills:check`.** Two shipped Claude skills link into `docs/guide/` with relative paths,
   and CI verifies every link resolves:
   - `frontend-design` → `frontend-{user-guide,playbook,for-agents,design-choices,hard-won,style-guide}.md`, `attribution.md`
   - `aiui-workflow` → `getting-started.md`, `chrome.md`, `config.md`, `warning.md`

   Seven of those are MOVE rows and one (`attribution.md`) is PARK — all fine, since
   `bundle-skill-docs.mjs` resolves any relative link that escapes the package, including into
   `packages/aiui-viz/docs/` or `archive/`. Each moved file = one link edit in a `SKILL.md`.
3. **The generated page.** `prompt-rendering.md` is written by
   `pnpm -C packages/aiui-claude-channel render-audit --docs`. Delete it without re-pointing the
   generator and the next run **recreates it in `docs/guide/`, which then fails gate 1**. Change
   the output path in the same commit.
4. **Source comments.** ~20 files under `packages/*/src` cite guide pages by path
   (`docs/guide/prompt-linting.md`, `docs/guide/warning.md`, …). Nothing enforces these, so they
   rot silently. One `grep -rn "docs/guide/<name>"` per deleted page, and re-point.

## Sequencing

Five commits, each green on `pnpm docs:gen && pnpm skills:check && pnpm docs:lint`:

1. **Move what is true.** The six `aiui-viz` pages, `vscode.md`, and the `prompt-rendering.md`
   generator re-point. Sidebar + skill links updated. No prose written. Biggest word-count drop,
   lowest risk, nothing lost.
2. **Park what we will rewrite.** `git mv` twelve guide pages to `archive/docs/`, drop two, delete
   their sidebar entries. The guide is now nine pages, several of them thin.
3. **Trim the shells.** `getting-started` (the three modes), `prompt-lowering`,
   `frontend-for-agents`, `development` — each cut to outline + honest prose + `_TODO._`. New
   `intent-panel.md` shell.
4. **Fix the four keepers.** `docs/index.md`, `guide/index.md`, `warning.md`, `config.md` — dead
   links, the host count, the source-comment sweep.
5. **Proposals.** Park the six finished ones, drop one, leave the four live.

Then the site is: introduction · motivation · getting started · warning · panel · lowering ·
frontend · config · development — and everything else that still matters lives beside its package.

## Open questions for markup

1. **`chrome.md` and `remote.md`** are PARKed above. They document real, working, user-facing
   behavior; the argument for parking is only "not one of eight". Say the word and either becomes a
   ninth page or a section of getting-started.
2. **`archive/docs/` vs plain deletion.** I default to parking because it is free. If you would
   rather the parked pages simply be gone (git history is a real archive), say so and step 2 gets
   simpler.
3. **The panel page's scope.** One page now, or a section with three children (turn · dictation ·
   oracle) from the start? I propose one page with named `_TODO._` sections, split when a section
   outgrows it.
4. **`claude-code-usage-analytics.md`** — park it now, or hold it in `docs/proposals/` until
   `cc-assay` actually leaves?
