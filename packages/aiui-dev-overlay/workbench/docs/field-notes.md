# Field notes: what building the workbench taught us

*Lessons that cost something to learn, recorded so they don't get re-learned. Design intent
lives in [turn-flow.md](./turn-flow.md); model strategy in
[openai-audio-stack.md](./openai-audio-stack.md); this page is the engineering residue.*

## The correction micro-pipeline

**Shape:** `{transcript (one segment per line), selected span, instruction}` → small LLM →
**V4A patch** (`apply_patch` format) → context-anchored apply → pink/green word-diff flash →
clean text. Corrector is a seam (`correct.ts`) like the transcriber: `mock` builds the patch
locally (offline, instant), `openai` asks a chat model (default `gpt-4o-mini`, ~2.1–2.3 s
observed). Failed patches degrade to plain first-occurrence replacement plus a note event —
corrections never silently vanish.

**The two instruction modes** (the prompt names them explicitly, and the distinction is
load-bearing):

1. **Replacement** — the instruction is verbatim content for the selected span. Selected
   "curb", said "curve" → swap the span, touch nothing else.
2. **Description** — the instruction *talks about* the change: *"no, it's not beat, it's Vite,
   the frontend build tool."* The selection is only the example occurrence; the model infers
   the edit and applies it to **every** affected occurrence document-wide, and uses the
   explanatory context (spelling, meaning) without leaking it into the text.

Verified live: transcript with two "beat" lines, one occurrence selected, description-mode
instruction → two-hunk patch fixing both, correct capitalization, untouched third line
(gpt-4o-mini, 2237 ms). This is why corrections are patches, not string replaces.

**Why V4A:** it's the patch grammar OpenAI models are trained to emit, and its applier matches
**context, never line numbers** — right for a transcript that has no stable line identity. We
implement the single-document subset (`*** Update File: transcript`, `@@` hunks, ` `/`-`/`+`
lines) with exact-then-trimmed context matching (`patch.ts`, pure, tested). Temperature 0.

**Segments-as-lines is a contract, not a convenience.** The transcript document the corrector
sees is "one talk segment per line", and `composeIntent` must produce *the same* document —
we originally merged consecutive segments into one text run for prettiness, and patches
generated against per-segment lines stopped applying. If the line-ification ever changes, it
must change in `composeIntent`, the preview's pieces, and the corrector's doc assembly
together. (The join is by-line for patching, by-space for the final prompt.)

**Corrections compound.** Each correction patches the *already-corrected* document (the
pipeline builds `docLines` from `composeIntent`, not from raw finals), so a second fix can
target text a first fix produced. Anchoring is by content (context lines), so earlier patches
don't invalidate later selections the way offsets would.

## Selection beat the lasso

The first correction UI lassoed the preview text with the pen. It failed in a way worth
remembering: the lasso canvas necessarily sits *on top* of the text, so
`caretRangeFromPoint(x, y)` hit-tests the canvas, not the words under it — no offsets ever
resolved. (Fix at the time: drop the canvas out of hit-testing with `pointer-events: none`
during resolution.) The deeper lesson: **the browser already has a precise
text-targeting gesture** — native selection — with none of those problems, better
sub-word precision, and zero code for rendering feedback. Now correct mode just makes the
preview selectable; `Selection` → range endpoints → per-span `data-off` bookkeeping →
character offsets.

Related, for anyone driving the UI synthetically (tests, agents): `setPointerCapture(pointerId)`
throws `NotFoundError` for synthetic pointer ids — guard it; and dispatched `PointerEvent`s
carry coordinates that hit-test fine, but browser-native behaviors (real selection) still need
the real APIs (`Selection.addRange`) rather than simulated drags.

## The backtick / typing-guard truths

Arming on `` ` `` is safe against editors to the extent the guard can see them: `<input>`,
`<textarea>`, `contentEditable` (which is ProseMirror, Lexical, Quill, CodeMirror 6, Slate),
Monaco's hidden textarea, ARIA `role="textbox"` — all detected (via `composedPath()[0]`, so
shadow-DOM inputs too). Iframe-hosted editors are safe for free: their key events never reach
the parent document. The **un-closable hole**: a widget handling keys on a plain non-editable
element is indistinguishable from the page; the overlay would arm *and* swallow the key. If
that ever matters in the shipping overlay, the answer is a less collidable arming gesture
(hold, or a modifier chord), not more heuristics.

## Browser & platform gotchas

- **`getDisplayMedia` once per session**: ask on the first shot (user picks "This Tab"), keep
  the stream, and every later shot is an instant frame grab. The capture veil must be gone from
  the compositor before grabbing — we wait ~120 ms after hiding it, which a very fast S-tap
  sequence can still race.
- **Chrome ≥ 136 requires a non-default `--user-data-dir` for `--remote-debugging-port`** and
  branded Chrome ≥ 137 ignores `--load-extension`; Chrome for Testing honors it. (Owned by the
  aiui docs, but both shaped workbench/browser decisions.)
- **Vite resolves `publicDir` at server start** — files added to a `public/` created after
  startup 404 (actually: fall through to index.html) until restart.
- **OpenAI sniffs uploaded audio by filename extension**, not content-type: the proxy must name
  the multipart file to match the container (`segment.wav` vs `.webm` vs `.m4a`) or
  transcription 400s.
- `caretRangeFromPoint` honors hit-testing (see the lasso story) — anything overlaying text
  must be `pointer-events: none` while you resolve offsets.

## Keys & config

**The repo-root `.env.dev` beats a shell-exported `OPENAI_API_KEY` everywhere** (dev-server
proxy, bench, on purpose): a stale export shadowing the real key produced confusing 401s twice
before the rule was inverted. If a key "doesn't work", check which layer supplied it first.

## Model observations so far

- REST STT: ~1–1.5 s floor regardless of utterance length for the 4o family; whisper-1 scales
  with duration. Full table + implications in
  [openai-audio-stack.md](./openai-audio-stack.md#l0--rest-stt-per-segment-built-the-current-default).
- Correction diffs: `gpt-4o-mini` at temperature 0 produced well-formed V4A on every attempt so
  far, including multi-hunk document-wide edits; ~2.1–2.3 s round trip. No retry logic has been
  needed yet — add it only when a malformed patch is actually observed (the plain-replacement
  fallback already contains the blast radius).

## Where state accumulates

| What | Where | Cleanup |
| --- | --- | --- |
| Workbench settings | `localStorage["aiui-workbench-settings"]` | clear site data |
| Shot PNGs | `$TMPDIR/aiui-workbench/` | OS temp cleanup |
| Exported event streams | wherever you saved them — they're the future IR-pass fixtures | keep the good ones |
