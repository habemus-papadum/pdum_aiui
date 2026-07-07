/**
 * monaco.ts — the single import point for Monaco, configured lean.
 *
 * A code *reader* needs the core editor (syntax highlight, folding, peek, the
 * command system) but NOT Monaco's built-in language services (the TS/JSON
 * workers): all real language intelligence comes from a genuine language server
 * over `/lsp` (see lsp/client.ts). So we import `editor.api` (core, no languages)
 * plus a handful of Monarch grammars for cheap client-side highlighting, and the
 * base `editor.worker` is the only worker we wire up.
 *
 * This keeps the bundle far below the full `monaco-editor/esm/.../editor.main`
 * (which drags in every language service + its workers) and means MonacoEnvironment
 * only ever needs the one worker.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// Monarch grammars for client-side highlighting (tokenizer only — no services).
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
// The base editor worker (tokenization/diff/link detection). Vite's `?worker`
// suffix compiles it to a dedicated-worker constructor.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Must be set before the first editor is created. We only ever return the base
// worker because we imported no language services.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
