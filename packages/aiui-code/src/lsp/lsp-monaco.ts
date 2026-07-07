/**
 * lsp-monaco.ts — the seam between real LSP results and Monaco's UI.
 *
 * Monaco is the durable imperative island; this module is the thin adapter that
 * (1) converts coordinates (LSP is 0-based line/char + UTF-16 columns, which
 * matches Monaco's 1-based line/column after a +1), (2) registers Monaco
 * providers whose implementations just call the LspClient, and (3) turns
 * `publishDiagnostics` into Monaco markers. It rewrites transport/coordinate
 * shape only — never LSP semantics.
 */
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  Position as LspPosition,
  Range as LspRange,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import { monaco } from "../monaco/monaco";
import type { LspClient } from "./client";

type Monaco = typeof monaco;
type IRange = monaco.IRange;

// --- coordinate conversions -------------------------------------------------

export const toMonacoPosition = (p: LspPosition): monaco.IPosition => ({
  lineNumber: p.line + 1,
  column: p.character + 1,
});

export const toLspPosition = (p: monaco.IPosition): LspPosition => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});

export const toMonacoRange = (r: LspRange): IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export const toLspRange = (r: IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

const severity = (s: number | undefined): monaco.MarkerSeverity => {
  switch (s) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
};

/** What the reader must provide so cross-file navigation + peek can open targets. */
export interface ReaderNavHost {
  /** Ensure a model exists for this file URI (fetch + create + didOpen if new). */
  ensureModel(uri: string): Promise<void>;
  /** Make this URI the active editor model and reveal an optional range. */
  openUri(uri: string, range?: LspRange): Promise<void>;
}

/** Resolve the LSP client that owns a document's language id (or undefined if
 * that language has no configured server). */
export type ClientResolver = (languageId: string) => LspClient | undefined;

/**
 * Register the read-only LSP providers on Monaco for the given language ids, and
 * wire the cross-resource editor opener. Each provider resolves its client by the
 * document's language id, so one registration serves every configured language
 * (python via pyright, typescript via tsserver, …). Diagnostics are subscribed
 * per-client at client creation, not here. Call once (durable island setup).
 */
export function registerLspProviders(
  m: Monaco,
  clientFor: ClientResolver,
  host: ReaderNavHost,
  languageIds: string[],
): () => void {
  const disposables: { dispose(): void }[] = [];

  // A request can lose a race with `didOpen` (server: "document should be
  // opened"), and a server may answer a capability it never advertised with an
  // error (pyright has no foldingRangeProvider). Neither should reach the console
  // as an uncaught rejection — a read-only reader just yields nothing that pass.
  const safe = async <T>(fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };
  // Only issue an optional request when the server advertises it. `capabilities`
  // is populated after `initialize`; a truthy value (boolean or options object)
  // means supported.
  const supports = (
    client: LspClient,
    cap: keyof NonNullable<LspClient["capabilities"]>,
  ): boolean => Boolean(client.capabilities?.[cap]);

  for (const languageId of languageIds) {
    disposables.push(
      m.languages.registerDefinitionProvider(languageId, {
        provideDefinition(model, position) {
          const client = clientFor(model.getLanguageId());
          if (!client) return null;
          return safe<monaco.languages.Location[]>([], async () => {
            const locs = await client.definition(model.uri.toString(), toLspPosition(position));
            // Pre-open target models so Monaco's peek preview has content.
            await Promise.all(locs.map((l) => host.ensureModel(l.uri).catch(() => {})));
            return locs.map(locationToMonaco);
          });
        },
      }),
      m.languages.registerReferenceProvider(languageId, {
        provideReferences(model, position, context) {
          const client = clientFor(model.getLanguageId());
          if (!client) return null;
          return safe<monaco.languages.Location[]>([], async () => {
            const locs = await client.references(
              model.uri.toString(),
              toLspPosition(position),
              context.includeDeclaration,
            );
            await Promise.all(locs.map((l) => host.ensureModel(l.uri).catch(() => {})));
            return locs.map(locationToMonaco);
          });
        },
      }),
      m.languages.registerHoverProvider(languageId, {
        provideHover(model, position) {
          const client = clientFor(model.getLanguageId());
          if (!client) return null;
          return safe<monaco.languages.Hover | null>(null, async () => {
            const hover = await client.hover(model.uri.toString(), toLspPosition(position));
            if (!hover?.contents) return null;
            const value = hoverToMarkdown(hover.contents);
            if (!value) return null;
            return {
              contents: [{ value }],
              ...(hover.range ? { range: toMonacoRange(hover.range) } : {}),
            };
          });
        },
      }),
      m.languages.registerDocumentSymbolProvider(languageId, {
        provideDocumentSymbols(model) {
          const client = clientFor(model.getLanguageId());
          if (!client || !supports(client, "documentSymbolProvider")) return [];
          return safe<monaco.languages.DocumentSymbol[]>([], async () =>
            symbolsToMonaco(await client.documentSymbols(model.uri.toString())),
          );
        },
      }),
      m.languages.registerFoldingRangeProvider(languageId, {
        provideFoldingRanges(model) {
          const client = clientFor(model.getLanguageId());
          if (!client || !supports(client, "foldingRangeProvider")) return [];
          return safe<monaco.languages.FoldingRange[]>([], async () => {
            const ranges = await client.foldingRanges(model.uri.toString());
            return (ranges ?? []).map((r) => ({
              start: r.startLine + 1,
              end: r.endLine + 1,
              ...(r.kind ? { kind: new m.languages.FoldingRangeKind(r.kind) } : {}),
            }));
          });
        },
      }),
    );
  }

  // Cross-resource navigation (ctrl-click / peek "open"): the supported public
  // API since Monaco 0.34. Route it through the reader so opening another file
  // is one code path with the sidebar and the agent tools.
  disposables.push(
    m.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const range =
          selectionOrPosition && "startLineNumber" in selectionOrPosition
            ? toLspRange(selectionOrPosition)
            : selectionOrPosition
              ? {
                  start: toLspPosition(selectionOrPosition),
                  end: toLspPosition(selectionOrPosition),
                }
              : undefined;
        void host.openUri(resource.toString(), range);
        return true; // we handled it
      },
    }),
  );

  return () => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // best-effort teardown
      }
    }
  };
}

/** Apply a `publishDiagnostics` payload to the matching model's markers, and
 * return the markers (for the reader's diagnostics summary). Subscribed per
 * client — pyright/tsserver each push their own as analysis settles. */
export function applyDiagnostics(
  m: Monaco,
  uri: string,
  diagnostics: Diagnostic[],
): monaco.editor.IMarkerData[] {
  const markers = diagnostics.map(diagnosticToMarker);
  const model = m.editor.getModel(m.Uri.parse(uri));
  if (model) m.editor.setModelMarkers(model, "lsp", markers);
  return markers;
}

const locationToMonaco = (loc: Location): monaco.languages.Location => ({
  uri: monaco.Uri.parse(loc.uri),
  range: toMonacoRange(loc.range),
});

const diagnosticToMarker = (d: Diagnostic): monaco.editor.IMarkerData => ({
  severity: severity(d.severity),
  // LSP 3.18 widened message to string | MarkupContent.
  message: typeof d.message === "string" ? d.message : d.message.value,
  startLineNumber: d.range.start.line + 1,
  startColumn: d.range.start.character + 1,
  endLineNumber: d.range.end.line + 1,
  endColumn: d.range.end.character + 1,
  ...(d.source ? { source: d.source } : {}),
  ...(d.code !== undefined ? { code: String(d.code) } : {}),
});

function hoverToMarkdown(contents: unknown): string {
  // LSP hover contents: MarkupContent | MarkedString | MarkedString[].
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverToMarkdown).filter(Boolean).join("\n\n");
  const obj = contents as { value?: string; language?: string; kind?: string };
  if (typeof obj.value === "string") {
    return obj.language ? `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` : obj.value;
  }
  return "";
}

/** documentSymbol may return the hierarchical `DocumentSymbol[]` (what we ask
 * for) or the flat `SymbolInformation[]`; map both to Monaco's outline shape. */
function symbolsToMonaco(
  symbols: DocumentSymbol[] | SymbolInformation[] | null,
): monaco.languages.DocumentSymbol[] {
  if (!symbols || symbols.length === 0) return [];
  const isHierarchical = "selectionRange" in symbols[0];
  if (isHierarchical) {
    return (symbols as DocumentSymbol[]).map(mapDocumentSymbol);
  }
  return (symbols as SymbolInformation[]).map((s) => ({
    name: s.name,
    detail: "",
    kind: (s.kind - 1) as monaco.languages.SymbolKind,
    tags: [],
    range: toMonacoRange(s.location.range),
    selectionRange: toMonacoRange(s.location.range),
  }));
}

function mapDocumentSymbol(s: DocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? "",
    // LSP SymbolKind is 1-based; Monaco's enum is 0-based.
    kind: (s.kind - 1) as monaco.languages.SymbolKind,
    tags: [],
    range: toMonacoRange(s.range),
    selectionRange: toMonacoRange(s.selectionRange),
    ...(s.children ? { children: s.children.map(mapDocumentSymbol) } : {}),
  };
}
