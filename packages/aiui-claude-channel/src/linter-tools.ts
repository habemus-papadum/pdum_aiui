/**
 * The prompt linter's tool surface — today exactly one tool, `read_file`.
 *
 * The linter (see {@link ./live-session}.LINTER_INSTRUCTIONS) may check a
 * file or selection against the actual source before flagging it — verify
 * suspicions, don't browse. The execution policy, deliberate and documented
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
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

/**
 * How a live consumer observes a tool round-trip — the consumer supplies its
 * OWN event/label vocabulary (`linter-tool-*` vs `oracle-tool-*`); the
 * execution policy above stays in one place. Part of the shared live-consumer
 * core (capture-bus-and-consumers.md §6 Phase 2): the linter and the oracle
 * run the same tools, differing only in how the round-trip is recorded.
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
