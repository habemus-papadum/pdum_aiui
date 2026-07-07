/**
 * types.ts — the thin, coarse interface the reactive layer sees.
 *
 * Per the proposal: cells wrap a *thin* interface over Monaco — currentFile,
 * selection, lspStatus, diagnostics, navHistory — and drive commands INTO the
 * island while observing coarse events OUT. Monaco's per-keystroke / per-fold /
 * per-scroll state never crosses this boundary.
 */
import type { Range as LspRange } from "vscode-languageserver-protocol";

export type { LspRange };

/** A source selection — natively the deictic reference Tier 2's compose path
 * consumes (a code selection IS `file:line:col-range` + excerpt). */
export interface SelectionSnapshot {
  /** Project-relative POSIX path. */
  file: string;
  range: LspRange;
  /** The selected text (may be empty for a bare cursor). */
  text: string;
}

/** One entry in the jump-back / jump-forward stack. */
export interface NavEntry {
  file: string;
  /** Zero-based line/char (LSP position) to restore the cursor to. */
  line: number;
  character: number;
}

/** A configured language server as the reader's UI sees it (from /lsp/servers +
 * live connection status). */
export interface ReaderServer {
  language: string;
  languageId: string;
  name?: string;
  extensions: string[];
  /** Whether setup's self-test passed, if recorded. */
  verified?: boolean;
  /** Live client status: idle | connecting | initializing | ready | error | closed. */
  status: string;
}

/** A flattened outline item for the panel + breadcrumb (from documentSymbol). */
export interface OutlineItem {
  name: string;
  detail: string;
  /** Monaco/LSP SymbolKind (0-based, as Monaco uses it). */
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  depth: number;
}
