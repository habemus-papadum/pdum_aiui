/**
 * graph.ts — the disposable cell graph + the agent tool surface.
 *
 * The reactive/async layer is thin by design (the proposal's "cells at the
 * coarse edges only"): a couple of cells over the durable reader — the project
 * file tree and the current file's outline — plus the agent tools that drive the
 * reader. Built from the durable roots in store.ts, published through a durable
 * box the UI subscribes to, and hot-swapped wholesale on edit while Monaco, the
 * LSP client, and the nav history keep running.
 */

import {
  type FileEntry,
  type FileTreeResponse,
  ROUTES,
  type Walkthrough,
  type WalkthroughListResponse,
  type WalkthroughStep,
  walkthroughPath,
} from "@habemus-papadum/aiui-code-protocol";
import {
  agentToolkit,
  type Cell,
  cell,
  cellGraph,
  cellRegistry,
  durable,
} from "@habemus-papadum/aiui-viz";
import { createSignal } from "solid-js";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import { backendUrl } from "./backend-origin";
import { activeWalkthrough, reader, walkthroughStep } from "./store";
import type { OutlineItem } from "./types";

export interface CodeGraph {
  /** Every readable file in the project (flat), for the tree + palette. */
  fileTree: Cell<FileEntry[]>;
  /** The current file's document-symbol outline (flattened with depth). */
  outline: Cell<OutlineItem[]>;
  /** Re-fetch the file tree (after the agent adds/removes files). */
  reloadTree(): void;
}

const graphBox = durable("code-reader/graphBox", () => {
  const [get, set] = createSignal<{ graph: CodeGraph; dispose: () => void }>();
  return { get, set };
});

/** The current graph — a stable accessor that survives hot swaps. */
export const codeGraph = (): CodeGraph | undefined => graphBox.get()?.graph;

function build(): { graph: CodeGraph; dispose: () => void } {
  const { graph, dispose } = cellGraph(() => {
    const [treeAttempt, setTreeAttempt] = createSignal(0);

    const fileTree = cell(
      () => ({ attempt: treeAttempt() }),
      async (): Promise<FileEntry[]> => {
        const res = await fetch(backendUrl(ROUTES.tree));
        if (!res.ok) throw new Error(`file tree: ${res.status}`);
        const body = (await res.json()) as FileTreeResponse;
        return body.entries;
      },
    );

    // Recompute when the file changes, when the LSP becomes ready, and when
    // diagnostics settle (pyright refines symbols as analysis completes).
    const outline = cell(
      () => {
        const file = reader.currentFile();
        if (!file) return undefined; // hold until a file is open
        return { file, status: reader.lspStatus(), v: reader.diagnosticsVersion() };
      },
      async (deps): Promise<OutlineItem[]> => {
        const symbols = await reader.documentSymbols(deps.file);
        return flattenSymbols(symbols);
      },
    );

    return {
      fileTree,
      outline,
      reloadTree: () => setTreeAttempt((n) => n + 1),
    } satisfies CodeGraph;
  });
  return { graph, dispose };
}

// --- walkthrough driving (shared by the UI and the agent tools) -------------

export function showWalkthroughStep(w: Walkthrough, index: number): void {
  const i = Math.max(0, Math.min(index, w.steps.length - 1));
  walkthroughStep.set(i);
  const step = w.steps[i];
  if (step) void reader.openFile(step.file, { range: step.range });
}

export function startWalkthrough(w: Walkthrough): void {
  activeWalkthrough.set(w);
  showWalkthroughStep(w, 0);
}

// --- agent tools: the reader's operations, exposed as they are built ---------

function registerTools(): void {
  const { registerTool, registerReporter } = agentToolkit("aiuiCode");

  registerTool({
    name: "list_files",
    description: "List every readable file in the project (project-relative paths).",
    run: () => codeGraph()?.fileTree.latest() ?? [],
  });
  registerTool({
    name: "open_file",
    description: "Open a file in the reader by project-relative path; optionally jump to a line.",
    params: {
      path: "project-relative path, e.g. src/pydemo/mesh.py",
      line: "1-based line (optional)",
    },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "number" } },
      required: ["path"],
    },
    run: async (args) => {
      const path = String(args?.path ?? "");
      const line = typeof args?.line === "number" ? args.line : undefined;
      await reader.openFile(path, line ? { range: zeroWidth(line - 1) } : {});
      return { opened: path, line };
    },
  });
  registerTool({
    name: "reveal",
    description:
      "Reveal + select a source range in the current or given file (0-based LSP coords).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        startCharacter: { type: "number" },
        endLine: { type: "number" },
        endCharacter: { type: "number" },
      },
      required: ["path", "startLine"],
    },
    run: async (args) => {
      const path = String(args?.path ?? reader.currentFile() ?? "");
      const range = {
        start: { line: num(args?.startLine), character: num(args?.startCharacter) },
        end: {
          line: num(args?.endLine, num(args?.startLine)),
          character: num(args?.endCharacter),
        },
      };
      await reader.openFile(path, { range });
      return { revealed: path, range };
    },
  });
  registerTool({
    name: "goto_definition",
    description: "Go to the definition of the symbol under the cursor (real LSP).",
    run: async () => (await reader.gotoDefinition()).map(locSummary),
  });
  registerTool({
    name: "find_references",
    description: "Find references to the symbol under the cursor (real LSP).",
    run: async () => (await reader.findReferences()).map(locSummary),
  });
  registerTool({
    name: "workspace_symbol",
    description: "Search project symbols by name (LSP workspace/symbol).",
    params: { query: "fuzzy symbol query" },
    run: async (args) => {
      const results = await reader.workspaceSymbols(String(args?.query ?? ""));
      return results.slice(0, 50).map((s) => ({
        name: s.name,
        kind: s.kind,
        location: "location" in s && s.location ? s.location : undefined,
      }));
    },
  });
  registerTool({
    name: "outline",
    description: "The current file's symbol outline (name, kind, range, depth).",
    run: () => codeGraph()?.outline.latest() ?? [],
  });
  registerTool({
    name: "reload_tree",
    description: "Re-fetch the project file tree (after adding or removing files).",
    run: () => {
      codeGraph()?.reloadTree();
      return { ok: true };
    },
  });
  registerTool({
    name: "back",
    description: "Jump back in the navigation history.",
    run: () => ({ moved: reader.back() }),
  });
  registerTool({
    name: "forward",
    description: "Jump forward in the navigation history.",
    run: () => ({ moved: reader.forward() }),
  });

  // Tier 3 — the agent authors a guided tour, then the human walks it.
  registerTool({
    name: "create_walkthrough",
    description:
      "Author a code walkthrough: an ordered list of steps, each a {file, range, prose}. Persists it and starts it in the reader.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              range: {
                type: "object",
                properties: {
                  start: { type: "object" },
                  end: { type: "object" },
                },
              },
              title: { type: "string" },
              prose: { type: "string" },
              narration: { type: "string" },
              diff: {
                type: "object",
                properties: { before: { type: "string" }, after: { type: "string" } },
              },
            },
            required: ["file", "range", "prose"],
          },
        },
      },
      required: ["title", "steps"],
    },
    run: async (args) => {
      const title = String(args?.title ?? "Untitled tour");
      const steps = (args?.steps as WalkthroughStep[]) ?? [];
      const draft: Walkthrough = { id: "", title, steps, createdBy: "agent" };
      const res = await fetch(backendUrl(ROUTES.walkthroughs), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`save walkthrough: ${res.status}`);
      const { id } = (await res.json()) as { id: string };
      startWalkthrough({ ...draft, id });
      return { id, steps: steps.length };
    },
  });
  registerTool({
    name: "list_walkthroughs",
    description: "List the saved walkthroughs (id, title, step count) available to start.",
    run: async () => {
      const res = await fetch(backendUrl(ROUTES.walkthroughs));
      if (!res.ok) throw new Error(`list walkthroughs: ${res.status}`);
      return (await res.json()) as WalkthroughListResponse;
    },
  });
  registerTool({
    name: "start_walkthrough",
    description: "Load a saved walkthrough by id and begin walking it in the reader.",
    params: { id: "walkthrough id (see list_walkthroughs)" },
    run: async (args) => {
      const id = String(args?.id ?? "");
      const res = await fetch(backendUrl(walkthroughPath(id)));
      if (!res.ok) throw new Error(`walkthrough ${id}: ${res.status}`);
      const w = (await res.json()) as Walkthrough;
      startWalkthrough(w);
      return { id, steps: w.steps.length };
    },
  });
  registerTool({
    name: "walkthrough_goto",
    description: "Show a specific step of the active walkthrough (0-based).",
    params: { index: "step index" },
    run: (args) => {
      const w = activeWalkthrough.get();
      if (!w) throw new Error("no active walkthrough");
      showWalkthroughStep(w, num(args?.index));
      return { step: walkthroughStep.get() };
    },
  });

  // --- reporters: the bounded snapshot -------------------------------------
  registerReporter("cells", () => cellRegistry());
  registerReporter("reader", () => ({
    root: reader.root(),
    currentFile: reader.currentFile(),
    openFiles: reader.openFiles(),
    lspStatus: reader.lspStatus(),
    cursor: reader.cursor(),
    selection: reader.selection(),
    canBack: reader.canBack(),
    canForward: reader.canForward(),
  }));
  registerReporter("diagnostics", () => {
    const file = reader.currentFile();
    if (!file) return { file: null, markers: [] };
    const markers = reader.diagnosticsFor(file);
    return {
      file,
      count: markers.length,
      markers: markers.slice(0, 20).map((m) => ({
        severity: m.severity,
        message: m.message,
        line: m.startLineNumber,
      })),
    };
  });
  registerReporter(
    "outline",
    () =>
      codeGraph()
        ?.outline.latest()
        ?.map((o) => o.name) ?? [],
  );
  registerReporter("walkthrough", () => {
    const w = activeWalkthrough.get();
    return w
      ? { id: w.id, title: w.title, steps: w.steps.length, at: walkthroughStep.get() }
      : null;
  });
}

// --- helpers ----------------------------------------------------------------

function flattenSymbols(symbols: DocumentSymbol[] | SymbolInformation[] | null): OutlineItem[] {
  if (!symbols || symbols.length === 0) return [];
  const out: OutlineItem[] = [];
  const isHierarchical = "selectionRange" in symbols[0];
  if (isHierarchical) {
    const walk = (list: DocumentSymbol[], depth: number) => {
      for (const s of list) {
        out.push({
          name: s.name,
          detail: s.detail ?? "",
          kind: s.kind - 1,
          range: s.range,
          selectionRange: s.selectionRange,
          depth,
        });
        if (s.children) walk(s.children, depth + 1);
      }
    };
    walk(symbols as DocumentSymbol[], 0);
  } else {
    for (const s of symbols as SymbolInformation[]) {
      out.push({
        name: s.name,
        detail: "",
        kind: s.kind - 1,
        range: s.location.range,
        selectionRange: s.location.range,
        depth: 0,
      });
    }
  }
  return out;
}

const zeroWidth = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 0 },
});
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const locSummary = (l: { uri: string; range: { start: { line: number } } }) => ({
  uri: l.uri,
  line: l.range.start.line + 1,
});

// --- module evaluation = (re)build ------------------------------------------

graphBox.get()?.dispose();
graphBox.set(build());
registerTools();
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.info("[aiui-code:hmr] graph rebuilt over the durable reader island");
  });
}
