# Corpus

What the renderers emit today, as readable files — a **baseline, not a contract** for the
prompt-toolkit migration (docs/proposals/structured-prompts-review.md). Produced by
`src/live/prompt.corpus.test.ts` with Vitest file snapshots: a renderer change updates these with
`pnpm exec vitest run -u` and the diff is reviewed like any other. Never edit by hand.
