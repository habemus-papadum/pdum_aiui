# Docs screenshots — the capture list

A working list for re-illustrating the docs (the old shots were dropped in `7a7d7ac` as stale
orphans). Fifteen core shots + three optional. The flow: capture raw shots at your leisure,
drop them anywhere (Desktop is fine) and share the path; then they get optimized (crop, resize
to ~1600 px wide, compressed), renamed to the filenames below, placed in `docs/public/`, and
wired into the pages listed.

**General guidance**

- **Pick one demo as the recurring canvas** — `demos/gears` or `demos/gratings` (both are
  visually rich and crisp) — so the panel shots feel like one coherent session:
  `pnpm -C demos/<slug> claude` + `pnpm -C demos/<slug> dev`, open in the session browser.
- Keep the browser window one consistent size (~1440×900 works) on a retina display; capture
  the **full window** generously — cropping happens in the optimize pass, so don't pre-crop.
- Nothing personal in frame: no real key values (the prompts mask, but don't paste a live key
  mid-capture), no unrelated tabs/bookmarks. Home-dir paths are fine.
- Terminal shots: bump the font a size or two and clear scrollback noise first.
- Naming: prefix raw captures with the shot number (`01-…`, `02-…`) or just note the order.
- macOS window capture: Cmd-Shift-4 then Space; for hover states, Screenshot.app's timer.

## A. The loop itself (guide index + getting started)

**01 · `loop-hero.png`** — *the money shot.* Full desktop: the session browser showing the demo
with the intent side panel open mid-turn (2–3 dictated segments plus a screenshot chip in the
preview), and the Claude Code terminal beside it with the lowered briefing just landed.
→ Used: `guide/index.md` intro; reused at the top of `getting-started.md`.

**02 · `key-interview.png`** — terminal: the vendor-key interview mid-question (ElevenLabs
first — paste-or-Enter). `aiui keys interview` stages it anytime; answer with Enter/skip during
the capture and rerun it for real afterwards.
→ Used: `getting-started.md` § Vendor keys.

**03 · `lowered-prompt.png`** — terminal close-up right after a send: the injected briefing
showing the `[current tab: …]` preamble and an inline `[screenshot located at …]` marker in the
prose (a selection marker too if the turn has one). Same session as 01, captured tighter.
→ Used: `getting-started.md` § Compose; `prompt-lowering.md`.

## B. The intent panel, one per feature (intent-panel.md)

**04 · `panel-armed.png`** — the panel freshly opened and armed over the demo tab
(Cmd/Ctrl+.), empty turn, mic idle. Page + panel both in frame.
→ § Arming a tab.

**05 · `panel-turn.png`** — a turn mid-composition: several spoken segments in the transcript
preview with a screenshot chip placed inline between them, not yet sent.
→ § The turn.

**06 · `segment-editor.png`** — the segment editor open on one mistranscribed segment (mid
re-speak if you can catch it).
→ § The turn.

**07 · `engine-picker.png`** — the config strip open (K) showing the three transcription
engines with their digits, Scribe v2 selected. Panel-only framing is fine.
→ § Dictation — the transcription engines.

**08 · `confidence-heatmap.png`** — a finalized transcript with warm-tinted low-confidence
words; ideally the hover tooltip showing a raw logprob (timer capture). Scribe or GPT-4o
Transcribe — not Realtime Whisper, which has no logprobs.
→ § Dictation.

**09 · `element-shot.png`** — a deliberate element-located screenshot (D): the on-page element
highlight at the capture moment, and/or the resulting chip with its element/source attribution
in the preview. Must be over the aiui demo app so attribution has something to say.
→ § Shots, share, and selections.

**10 · `video-smart.png`** — a screen share running (V): the ● video badge with 🦉 smart mode
and the cadence slider visible, a sampled frame or two already in the preview.
→ § Shots, share, and selections.

**11 · `linter-chips.png`** — the linter on (openai), one or two dismissible 💡 chips showing
and the lint-now button in frame.
→ § The prompt linter.

**12 · `oracle-reply.png`** — the oracle just after answering: the mind strip holding its last
reply. Needs the OpenAI key.
→ § The oracle.

**13 · `pencil-strokes.png`** — pencil strokes over the live page (circle a widget, draw an
arrow) with the located annotation visible in the preview.
→ § The pencil.

**14 · `trace-debugger.png`** — a real turn's lowering trace open in the embedded debugger:
the stage list with one intermediate representation expanded; a 💰 cost card in frame if the
turn used the linter or correction.
→ § The trace debugger; reused in `getting-started.md` § Inspect and `prompt-lowering.md`.

## C. The channel's own surfaces

**15 · `console-dashboard.png`** — `aiui dashboard`: the console landing with channel facts,
the Launch key rows (ElevenLabs/OpenAI/Gemini presence), and the surface cards.
→ Used: `getting-started.md` § The loop, piece by piece.

## D. Optional extras

**16 · `page-tools-ledger.png`** — the console's page-tools ledger with the demo's registered
toolkit and its activity bit.
→ `intent-panel.md` § Page tools.

**17 · `pencil-ipad.png`** — the remote angle: an iPad on the LAN drawing through `/pencil/`
on the same page (an iPad screenshot, or a photo of the iPad if the posture reads better).
→ `intent-panel.md` § The pencil; the remote docs.

**18 · `vscode-jump.png`** — jump mode: the click on the page and VS Code landed at the
authoring source line (split/composite is fine).
→ `intent-panel.md` § VS Code jump; `aiui-vscode` docs.
