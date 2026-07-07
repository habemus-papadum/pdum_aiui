/**
 * language-id.ts — map a file path to the Monaco *grammar* id used to create its
 * text model (which also selects which LSP providers fire, since providers are
 * registered per language id).
 *
 * This is display-side fallback only: the LSP-managed languages (python,
 * typescript, …) come from the project's manifest, and the backend prefers that.
 * Everything else (markdown, json, toml, …) gets a Monaco grammar id here so the
 * reader still syntax-highlights unmanaged files.
 */
const BY_EXT: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".toml": "toml",
  ".sh": "shell",
  ".bash": "shell",
  ".c": "c",
  ".h": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".jl": "julia",
  ".lean": "lean",
  ".rs": "rust",
  ".go": "go",
};

export function monacoLanguageId(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return BY_EXT[path.slice(dot).toLowerCase()] ?? "plaintext";
}
