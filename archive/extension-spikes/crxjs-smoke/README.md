# crxjs-smoke — M5

CRXJS v2 + Vite 6 + `vite-plugin-solid 3.0.0-next.5` + `solid-js`/`@solidjs/web 2.0.0-beta.15`
(the repo's exact pins) + an import of overlay **source**
(`packages/aiui-dev-overlay/src/errors.ts`) from outside the project root — i.e. the monorepo's
source-first convention pushed through the CRXJS pipeline.

Standalone npm project (deliberately not a workspace member):

```sh
npm install
npm run build     # headless leg: does it produce a loadable MV3 extension?
npm run dev       # live leg: content-script HMR (see below)
```

Gotcha already found and fixed here: Solid 2.0 beta's web runtime is `@solidjs/web` —
`solid-js/web` has no export in beta.15, and `render` must be imported from `@solidjs/web`
(exactly as the overlay's `widget.tsx` does).

## Live HMR leg

1. `npm run dev` (Vite on pinned port 5311; CRXJS writes a dev `dist/`).
2. Load `dist/` unpacked (`chrome://extensions` → Developer mode → Load unpacked).
3. Open any page; the smoke box appears bottom-left. Click the counter a few times.
4. Edit `BADGE` in `src/content.tsx` and save. **Pass:** the box updates in place, counter value
   preserved, no page reload. **Fail:** page reloads (WXT-style granularity) or nothing happens.
5. Edit the message string in `packages/aiui-dev-overlay/src/errors.ts` (revert after!) — same
   expectation, proving cross-package overlay-source HMR reaches the content script.
6. Note the console line `[crxjs-smoke] content script mounted` — a remount means reload, not HMR.

Record results in `../RESULTS.md` (Chrome version, browser flavor, pass/fail per step).
