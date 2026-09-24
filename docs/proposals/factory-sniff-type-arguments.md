# Factory sniff: a type argument hides a control from the compiler

The content sniff that decides whether the locator pass runs on a file requires
the factory name to be followed by `(`; `control<Grade>({ … })` is not admitted,
the file is never transformed, and the production page throws at load. One
regex change, one test.

Status: **PROPOSED 2026-09-23.** Found while building a downstream research note.
Worked around there by writing `control({ value: "minor" as Grade, … })` and a
comment saying why.

## 0. In one screen

`sourceLocatorVite` runs Babel only on files a cheap regex admits. The factory half
of that regex is `\b(?:cell|bridgeEffect|control|action|selectionDim)\s*\(`. A
TypeScript call with an explicit type argument, `control<Grade>({ … })`, has `<Grade>`
between the name and the paren and does not match. The Babel visitor itself would
handle the call fine (it matches on the callee identifier of a `CallExpression`;
Babel's TS parser puts the type argument in `typeParameters`, not in the callee), so
the only gate that fails is the sniff.

It passes in dev and fails in the build because the sniff is different per command:
in `serve` the JSX-stamping part `<[A-Za-z]` is on and happens to match `<Grade>`, so
the file is admitted and the control gets its name; in `build` `stampJsx` defaults off,
the sniff is the factory part alone, the file is skipped, and `control()` throws its
`needs a name` guard on the first page load. Nothing in `pnpm dev`, the tests or the
typecheck sees it; only the built page does.

## 1. What exists (verified 2026-09-23, `aiui-source-processor` 0.18.0+dev, main at 656f294)

| Piece | Where | The fact the fix leans on |
| --- | --- | --- |
| `buildSniff(factories, stampJsx)` | `packages/aiui-source-processor/src/source-locator.ts:484-492` | Factory part: `` `\\b(?:${escaped.join("\|")})\\s*\\(` ``. JSX part `<[A-Za-z]`, only when `stampJsx`. |
| `stampJsx` defaults to `command === "serve"` | `source-locator.ts:553-558` (`configResolved`), documented at `:503-508` | So the build sniff is the factory part only. |
| The out-of-root sniff is always factory-only | `source-locator.ts:560` | A workspace-linked package with `control<T>(…)` fails in dev too. |
| `transform` returns early when the sniff misses | `source-locator.ts:578` | The Babel pass never runs; no name, no loc, no description is injected. |
| The visitor matches on the callee identifier | `source-locator.ts:323-325` | `control<Grade>({…})` is a `CallExpression` whose `callee` is `Identifier("control")`; it would be named. |
| The runtime guard | `packages/aiui-viz/src/control.ts:176-183` | `control() needs a name — either the aiui() Vite plugin … or an explicit { name }`. Thrown at module evaluation, so the whole page fails. |
| Tests cover the sniff only through the JSX-plus-factory case | `source-locator.test.ts:363-372` | No test has a factory call with a type argument. |

## 2. The fix

Admit the call whatever sits between the name and the paren. Two options; the
first is recommended.

**(a) Match the identifier alone.** `\b(?:cell|bridgeEffect|control|action|selectionDim)\b`.
The sniff's job is to skip files that cannot contain a factory call; a file that
mentions the word is worth a parse. False admissions (a local variable named
`control`, the word in a comment) cost one Babel pass on that file and nothing else:
the visitor decides. This also admits `control  <T>(…)`, `control<T<U>>(…)` and any
future spelling.

**(b) Allow an optional type-argument list.** `\b(?:…)\s*(?:<[^\n]*?>\s*)?\(`. Tighter,
but a type argument can contain `(` (a function type) or span lines, and the pattern
then misses again. Not worth the precision.

Either way the JSX part is untouched. With (a), `serve` and `build` admit the same
files for the factory half, which removes the dev/build asymmetry that let this
through.

## 3. Test

In `source-locator.test.ts`, next to the out-of-root cases:

```ts
it("admits a factory call that carries a type argument, in build and out of root", async () => {
  const p = sourceLocatorVite();
  (p.configResolved as (c: object) => void)({ root: "/repo/demos/twins", command: "build" });
  const code = 'export const cutoff = control<"a" | "b">({ value: "a" });';
  const out = await (p.transform as Transform).call(ctx, code, "/repo/demos/twins/src/store.ts");
  expect(out?.code).toContain('name: "cutoff"');
});
```

And the same code through the out-of-root path (`/repo/packages/x/src/store.ts`),
which today fails under both commands.

## 4. Milestones

1. Change `buildSniff` to option (a); add the two tests; bump the patch version.
2. In `docs/guide` where the compiler's naming rule is stated ("assign it to a named
   binding or pass `{ name }`"), add one sentence: the sniff admits any file that
   mentions a factory name, so a type argument on the call is fine.
3. Remove the workaround comment in the research note once the bump is consumed.

## 5. Non-goals

- Making the runtime guard softer. A nameless control is still an error; the guard
  stays.
- Parsing every file. The sniff stays a regex; it only stops requiring the paren.
