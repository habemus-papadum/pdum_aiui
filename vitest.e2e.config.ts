import { defineConfig } from "vitest/config";

// End-to-end tests — the ones that spawn real subprocesses (notably Claude Code)
// and cost real usage. They are deliberately NOT `*.test.ts`, so the default
// `vitest run` (see vitest.config.ts) never collects them; they run only through
// this config, via `pnpm test:e2e`. Think of `*.e2e.ts` as a pytest marker you
// opt into: `pnpm test` is "not e2e", `pnpm test:e2e` is "-m e2e".
//
// Within an e2e file, gate further at runtime:
//   describe.skipIf(!claudeAvailable())  — degrade gracefully when claude is absent
//   describe.runIf(E2E_HEAVY)            — keep heavy strategies out of CI
export default defineConfig({
  test: {
    include: ["packages/**/*.e2e.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // e2e tests launch and drive real processes: run them serially and give them
    // room (a Claude turn on Haiku can take a while).
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
