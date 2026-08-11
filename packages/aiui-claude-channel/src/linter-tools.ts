/**
 * The LOCAL-READ tool surface: `read_file`, `list_files`, and `grep`, under
 * one execution policy.
 *
 * Two consumers advertise DIFFERENT subsets of it, which is the point of
 * keeping the policy in one module (O3c, the intent-oracle proposal in git history):
 *
 *  - the **prompt linter** offers `read_file` alone — its brief is "verify a
 *    suspicion before flagging it", and a linter that browses a repository is
 *    a linter spending your realtime budget on wandering;
 *  - the **intent panel's oracle** offers all three, reached over the intent
 *    sidecar's `POST /intent/oracle/tool`, because answering "what does this
 *    code do" genuinely needs to find the code first.
 *
 * The execution policy, deliberate and documented
 * (docs/guide/prompt-linting.md):
 *
 *  - **Anything readable, fully recorded.** The path resolves against the
 *    prompt cwd (the project the human is composing about) but is NOT
 *    jailed to it — the linter is a local dev tool running as the user, and
 *    a read it can't do the user's own agent could. What keeps this honest
 *    is that every call and every result is first-class in the trace
 *    (`linter-tool-call` / `linter-tool-result` events + trace stages), so
 *    nothing the linter saw is invisible.
 *  - **32 KB cap** with an explicit truncation marker — realtime instructions
 *    are billed per turn; a whole file rarely helps past its head.
 *  - **Binary sniff** — a NUL byte in the head means "not text"; the model
 *    gets told rather than fed garbage.
 *  - **Errors return to the model** as readable strings (ENOENT etc.), never
 *    throw — a failed read is a linting datum, not a fault.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The read cap, in bytes — past this the content truncates with a marker. */
export const READ_FILE_CAP_BYTES = 32 * 1024;

/** How much of the head is sniffed for NUL bytes (binary detection). */
const BINARY_SNIFF_BYTES = 1024;

/** The one tool's name — shared by both vendors' declarations below. */
export const READ_FILE_TOOL_NAME = "read_file";

const READ_FILE_DESCRIPTION =
  "Read a file from the project to verify a suspicion before flagging it. " +
  "Relative paths resolve against the project root. Text files only; " +
  "large files are truncated.";

/** The `read_file` declaration in OpenAI realtime's tool shape. */
export const READ_FILE_TOOL_OPENAI = {
  type: "function",
  name: READ_FILE_TOOL_NAME,
  description: READ_FILE_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (relative to the project root, or absolute).",
      },
    },
    required: ["path"],
  },
} as const;

/** The `read_file` declaration in Gemini Live's functionDeclarations shape. */
export const READ_FILE_DECLARATION_GEMINI = {
  name: READ_FILE_TOOL_NAME,
  description: READ_FILE_DESCRIPTION,
  parameters: {
    type: "OBJECT",
    properties: {
      path: {
        type: "STRING",
        description: "File path (relative to the project root, or absolute).",
      },
    },
    required: ["path"],
  },
} as const;

/** One executed read: what goes back to the model + the trace's short gloss. */
export interface ReadFileResult {
  ok: boolean;
  /** What the model reads — the (possibly truncated) content, or the error. */
  content: string;
  /** The one-line human gloss for the `linter-tool-result` event / trace row. */
  summary: string;
}

/**
 * Execute a `read_file` call. `cwd` is the prompt cwd (relative paths resolve
 * against it); absent → the process cwd. Never throws.
 */
export function executeReadFile(args: Record<string, unknown>, cwd?: string): ReadFileResult {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (rawPath === "") {
    return {
      ok: false,
      content: "read_file error: no path given",
      summary: "no path given",
    };
  }
  const path = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, content: `read_file error: ${message}`, summary: message };
  }
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) {
    return {
      ok: false,
      content: `read_file: ${rawPath} is a binary file (${bytes.length} bytes) — not text`,
      summary: `${rawPath} — binary (${bytes.length} bytes)`,
    };
  }
  const truncated = bytes.length > READ_FILE_CAP_BYTES;
  const text = bytes.subarray(0, READ_FILE_CAP_BYTES).toString("utf8");
  const kb = (bytes.length / 1024).toFixed(1);
  return {
    ok: true,
    content: truncated
      ? `${text}\n[…truncated at ${READ_FILE_CAP_BYTES / 1024} KB of ${kb} KB]`
      : text,
    summary: `${rawPath} — ${kb} KB${truncated ? " (truncated)" : ""}`,
  };
}

// ── list_files and grep — the oracle's half of the surface (O3c) ─────────────
//
// Same policy as `read_file` above, one addition that is theirs alone: every
// bound is SURFACED, never silently applied. A voice model told "42 matches
// (capped at 40)" can ask for a narrower pattern; one handed 40 results that
// look complete cannot. Directories that are never the answer (`.git`,
// `node_modules`, build output) are skipped for SIGNAL, not for security —
// the policy above is explicit that this is a local dev tool running as the
// user, and what keeps it honest is that every call is recorded.

/** Entries a single `list_files` may return before truncating. */
export const LIST_FILES_CAP = 200;
/** Matches a single `grep` may return before truncating. */
export const GREP_MATCH_CAP = 40;
/** Files a single `grep` will open before giving up on the search. */
export const GREP_FILE_CAP = 2000;
/** Longest match line handed to the model — a minified bundle is not evidence. */
const GREP_LINE_CAP = 300;

/** Directory names never worth walking: enormous, and never the answer. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-ext", ".next", "coverage"]);

export const LIST_FILES_TOOL_NAME = "list_files";
export const GREP_TOOL_NAME = "grep";

const LIST_FILES_DESCRIPTION =
  "List files and directories under a path in the project, to find what to read. " +
  "Relative paths resolve against the project root. Results are capped.";

const GREP_DESCRIPTION =
  "Search the project's text files for a regular expression and return matching lines " +
  "with their file and line number. Use it to locate code before reading it. " +
  "Results are capped.";

/** The `list_files` declaration in OpenAI realtime's tool shape. */
export const LIST_FILES_TOOL_OPENAI = {
  type: "function",
  name: LIST_FILES_TOOL_NAME,
  description: LIST_FILES_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list (relative to the project root, or absolute).",
      },
      depth: {
        type: "number",
        description: "How many directory levels to descend. Default 1, max 5.",
      },
    },
    required: ["path"],
  },
} as const;

/** The `grep` declaration in OpenAI realtime's tool shape. */
export const GREP_TOOL_OPENAI = {
  type: "function",
  name: GREP_TOOL_NAME,
  description: GREP_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: {
        type: "string",
        description: "Directory or file to search (relative to the project root, or absolute).",
      },
      extensions: {
        type: "array",
        items: { type: "string" },
        description: 'Limit to these file extensions, e.g. ["ts","tsx"].',
      },
    },
    required: ["pattern"],
  },
} as const;

/** Resolve an argument path the way `read_file` does: relative to the project. */
function resolveUnder(raw: unknown, cwd?: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  const base = cwd ?? process.cwd();
  if (value === "") {
    return base;
  }
  return isAbsolute(value) ? value : resolve(base, value);
}

/** Execute a `list_files` call. Never throws. */
export function executeListFiles(args: Record<string, unknown>, cwd?: string): ReadFileResult {
  const root = resolveUnder(args.path, cwd);
  const depth = Math.min(5, Math.max(1, typeof args.depth === "number" ? args.depth : 1));
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, prefix: string, level: number): void => {
    if (truncated || level > depth) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      lines.push(`${prefix}… (unreadable: ${error instanceof Error ? error.message : "?"})`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (lines.length >= LIST_FILES_CAP) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          lines.push(`${prefix}${entry.name}/ (skipped)`);
          continue;
        }
        lines.push(`${prefix}${entry.name}/`);
        walk(join(dir, entry.name), `${prefix}  `, level + 1);
      } else if (entry.isFile()) {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  };

  try {
    if (!statSync(root).isDirectory()) {
      return {
        ok: false,
        content: `list_files: ${root} is a file, not a directory — use read_file`,
        summary: `${root} is a file`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, content: `list_files error: ${message}`, summary: message };
  }

  walk(root, "", 1);
  const body = lines.join("\n");
  return {
    ok: true,
    content: truncated ? `${body}\n[…truncated at ${LIST_FILES_CAP} entries]` : body,
    summary: `${root} — ${lines.length} entr${lines.length === 1 ? "y" : "ies"}${
      truncated ? " (truncated)" : ""
    }`,
  };
}

/** Execute a `grep` call. Never throws — a bad regex is an answer, not a fault. */
export function executeGrep(args: Record<string, unknown>, cwd?: string): ReadFileResult {
  const source = typeof args.pattern === "string" ? args.pattern : "";
  if (source === "") {
    return { ok: false, content: "grep error: no pattern given", summary: "no pattern given" };
  }
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, content: `grep error: bad pattern — ${message}`, summary: message };
  }
  const extensions = Array.isArray(args.extensions)
    ? args.extensions
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.replace(/^\./, ""))
    : undefined;
  const root = resolveUnder(args.path, cwd);

  const matches: string[] = [];
  let filesRead = 0;
  let capped = false;

  const search = (file: string): void => {
    if (extensions !== undefined) {
      const ext = file.slice(file.lastIndexOf(".") + 1);
      if (!extensions.includes(ext)) {
        return;
      }
    }
    if (filesRead >= GREP_FILE_CAP) {
      capped = true;
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return; // unreadable is not a match, and not a fault
    }
    filesRead += 1;
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return; // binary: never evidence
    }
    const rel = cwd !== undefined && file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= GREP_MATCH_CAP) {
        capped = true;
        return;
      }
      const line = lines[i] as string;
      if (re.test(line)) {
        const text = line.length > GREP_LINE_CAP ? `${line.slice(0, GREP_LINE_CAP)}…` : line;
        matches.push(`${rel}:${i + 1}: ${text.trim()}`);
      }
    }
  };

  const walk = (dir: string): void => {
    if (capped) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) {
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        search(join(dir, entry.name));
      }
    }
  };

  try {
    if (statSync(root).isDirectory()) {
      walk(root);
    } else {
      search(root);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, content: `grep error: ${message}`, summary: message };
  }

  if (matches.length === 0) {
    return {
      ok: true,
      content: `no matches for /${source}/ under ${root} (${filesRead} files searched)`,
      summary: `no matches (${filesRead} files)`,
    };
  }
  // The cap is TOLD, not silently applied: a model that knows it was truncated
  // can narrow the pattern; one handed a complete-looking list cannot.
  const note = capped
    ? `\n[…stopped at ${GREP_MATCH_CAP} matches — narrow the pattern or the path for the rest]`
    : "";
  return {
    ok: true,
    content: `${matches.join("\n")}${note}`,
    summary: `${matches.length} match${matches.length === 1 ? "" : "es"} in ${filesRead} files${
      capped ? " (truncated)" : ""
    }`,
  };
}

/** The three executors behind one name — the oracle route's dispatch table. */
export const LOCAL_READ_TOOLS: Record<
  string,
  (args: Record<string, unknown>, cwd?: string) => ReadFileResult
> = {
  [READ_FILE_TOOL_NAME]: executeReadFile,
  [LIST_FILES_TOOL_NAME]: executeListFiles,
  [GREP_TOOL_NAME]: executeGrep,
};

/**
 * How a live consumer observes a tool round-trip — the consumer supplies its
 * OWN event/label vocabulary (`linter-tool-*`); the execution policy above
 * stays in one place (the shared live-consumer core,
 * capture-bus-and-consumers.md §6 Phase 2).
 */
export interface ToolRunObserver {
  /** The request half arrived — chronicle + trace it (before execution). */
  onCall(tool: string, args: Record<string, unknown>): void;
  /** The result half — `content` is the full text the model will read (trace-only). */
  onResult(ok: boolean, summary: string, content: string): void;
}

/**
 * Execute one live-consumer tool call end to end: validate the tool name,
 * run `read_file`, report both halves through the observer, and respond to
 * the model (the engine handles the vendor resume rule).
 */
export function runConsumerToolCall(
  call: { tool: string; args: Record<string, unknown>; respond(result: string): void },
  promptCwd: string,
  observer: ToolRunObserver,
): void {
  observer.onCall(call.tool, call.args);
  if (call.tool !== READ_FILE_TOOL_NAME) {
    const summary = `unknown tool "${call.tool}"`;
    observer.onResult(false, summary, "");
    call.respond(`error: ${summary}`);
    return;
  }
  const result = executeReadFile(call.args, promptCwd);
  observer.onResult(result.ok, result.summary, result.content);
  call.respond(result.content);
}
