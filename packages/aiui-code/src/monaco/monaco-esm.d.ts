/**
 * monaco-esm.d.ts — types for Monaco's ESM subpath imports.
 *
 * We import the lean ESM tree (`editor.api` + individual Monarch grammars) so we
 * don't drag in the built-in language services. Monaco only ships types on its
 * `.` export (`editor.main.d.ts`), which is a superset of `editor.api`, so we
 * re-export it for the subpath. The `?worker` specifier is typed by vite/client.
 */
declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/esm/vs/basic-languages/*";
