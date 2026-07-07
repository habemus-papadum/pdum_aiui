/**
 * reader-env.d.ts — ambient shims this package's typecheck needs once the reader
 * entry imports `@habemus-papadum/aiui-code` source-first.
 *
 * Source-first has a cost at the type layer: importing aiui-code's `.` entry
 * pulls its Monaco/Vite module graph into *this* package's `tsc` run, and that
 * graph leans on ambient declarations that live in aiui-code's own compilation
 * and never load through a value import:
 *  - `vite/client` — `import.meta.hot`/`env` and the `*?worker` specifier;
 *  - the lean Monaco ESM subpaths (`editor.api` + Monarch grammars), which ship
 *    no types of their own.
 *
 * We declare both locally rather than referencing aiui-code's internal shim by
 * path — a cross-package `node_modules/.../src/...` reference would hardcode the
 * pnpm layout and vanish in the published (dist) shape. `monaco-editor` is a
 * devDependency of this package precisely so `export * from "monaco-editor"`
 * below resolves from *our* context (Monaco types its `.` export, a superset of
 * `editor.api`). Keep this in sync with aiui-code's `src/monaco/monaco-esm.d.ts`.
 */

/// <reference types="vite/client" />

declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/esm/vs/basic-languages/*";
