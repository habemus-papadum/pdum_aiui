import { defineConfig } from "vitest/config";

// This package builds with tsc + an esbuild script (no Vite), so it has no
// vite.config.ts for Vitest to adopt. Without this file, `pnpm test` run from
// this directory walks up to the repo-root workspace config, whose
// root-relative project globs don't resolve from a package cwd and crash the
// run. The root `vitest run` treats this file as the package's project config.
export default defineConfig({
  test: {},
});
