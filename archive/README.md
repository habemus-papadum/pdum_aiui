# archive

Retired documents: pre-implementation explorations and design notes that shaped the code but are
no longer maintained or part of the docs site. Kept readable here on GitHub for provenance; safe
to delete outright someday.

- `agentic_ui_workflow/` — early sketches of the agentic frontend loop (HMR discipline,
  observable web workers, frontend debugging). Distilled into the *Frontend for Agents* guide
  pages and the `aiui-viz` / `demos/gallery` implementations.
- `reactive-flows/` — the solid-cells design lineage (motivation, two SolidJS iterations).
  Distilled into `aiui-viz`'s cell implementation.
- `extension-spikes/` — runnable measurement spikes (a scratch MV3 capture-probe extension, an
  MCP `tools/list_changed` probe, a CRXJS smoke build) behind
  `docs/proposals/browser-extension-intent-tool.md` §12; results in its `RESULTS.md`.
- `code-review-pass1-stale-and-legacy.md` / `code-review-pass2-*.md` — the 2026-07 code-review
  records: pass 1 (stale references + legacy code) and pass 2 (the S1–S10 smell sweep — the
  `smells` index plus the five executed decision documents). All decisions are implemented on
  main; the gitignored evidence (`docs/proposals/review-pass*.local/`) stays where the docs'
  pointers name it.
- Loose files — one-off design notes (attachment path encoding, tab routing, early desiderata
  and package plans); superseded by the guide pages and package docs, occasionally still cited
  as provenance.
