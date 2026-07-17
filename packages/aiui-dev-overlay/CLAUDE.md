# aiui-dev-overlay — FROZEN

**Do not edit this package.** It is a read-only reference (frozen 2026-07-16), kept intact and
compiling until it is deleted together with `aiui-extension` and `aiui-devtools-extension` —
see `docs/proposals/dev-overlay-retirement.md`.

The parts that are still alive were **copied out** (deliberately not moved — the copy-paste
rationale is in the proposal):

- Capture + transport runtime (`multimodal/*`, `protocol`, `intent-thread`, `selection`,
  `errors`, `instrumentation`) → `packages/aiui-intent-runtime`
- The trace-debugger UI (`debug-ui/*`) → `packages/aiui-trace-ui`

If a change seems needed here, it belongs in one of those packages instead. The frozen
`aiui-extension` still consumes this package; that pair dies together.
