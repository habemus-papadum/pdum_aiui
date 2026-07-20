/**
 * Shared helpers for `store.ts` / `resolve.ts` / `delete.ts`: a small colored
 * logger (mirrors `exploration/ephemeral-keys/util.ts`'s style), secret
 * redaction, a stdin secret reader that never echoes to argv/shell-history,
 * and CLI arg parsing for the `--service` override + positional key names.
 */

import { isVendorKeyName, VENDOR_KEYS, type VendorKeyName } from "./spec.ts";

// ── logging ──────────────────────────────────────────────────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
export const color = c;

export function heading(s: string): void {
  console.log(`\n${c.bold(c.cyan(`▐ ${s}`))}`);
}
export function ok(s: string): void {
  console.log(`  ${c.green("✔")} ${s}`);
}
export function fail(s: string): void {
  console.log(`  ${c.red("✗")} ${s}`);
}
export function info(s: string): void {
  console.log(`  ${c.dim("·")} ${c.dim(s)}`);
}
export function warn(s: string): void {
  console.log(`  ${c.yellow("!")} ${c.yellow(s)}`);
}

/**
 * Redact a secret for logs: NEVER print the value. This is intentionally
 * much more conservative than the ephemeral-keys spike's `redact` (which
 * shows a short prefix of a *short-lived* token) — these are long-lived
 * vendor API keys, so we show only length + a fixed marker.
 */
export function redact(secret: string): string {
  return `<redacted, ${secret.length} chars>`;
}

// ── secret input (never argv, never shell history) ─────────────────────────

/**
 * Read one secret value without it ever appearing in argv or shell history.
 *
 * - Piped/non-interactive stdin (`echo "$X" | npm run store -- FOO`, or a CI
 *   step): reads one line per call. This is the expected path for scripting,
 *   including storing >1 key in one invocation (one line per key, in the
 *   order requested).
 * - A real terminal: masks keystrokes with raw-mode stdin (no dependency —
 *   this is the same technique `npm`'s own password prompts use), so the
 *   secret never gets echoed to the terminal (and so never lands in a
 *   terminal scrollback/log capture) either.
 *
 * Either way, the value is a program-internal string handed straight to
 * `vaultStore`, never round-tripped through a shell.
 */
export async function readSecret(promptLabel: string): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();
  return readMaskedLine(promptLabel);
}

let pipedLines: string[] | null = null;
let pipedLineIndex = 0;

/**
 * Buffer the whole of stdin once, split on `\n`, and serve one line per call.
 *
 * NOT built on `readline.Interface#question()` in a loop — that was tried
 * first and breaks for >1 key: `readline` auto-closes its `Interface` as
 * soon as the underlying stream hits EOF, which for a `printf 'a\nb\n' |
 * …` pipe happens right after the FIRST buffered line is delivered (the
 * whole pipe arrives, and closes, in one go); a second `question()` call
 * then throws `ERR_USE_AFTER_CLOSE` (observed live while testing this
 * spike's multi-key store path). Reading everything up front sidesteps the
 * race entirely.
 */
async function readAllPipedLines(): Promise<string[]> {
  if (pipedLines) return pipedLines;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing "\n" -> no phantom empty line
  pipedLines = lines;
  return lines;
}

/** The next line from a non-tty stdin (see `readAllPipedLines`). `""` if there are no more lines than keys requested. */
async function readPipedLine(): Promise<string> {
  const lines = await readAllPipedLines();
  const line = lines[pipedLineIndex] ?? "";
  pipedLineIndex++;
  return line;
}

// Control-byte codepoints we act on while masking keystrokes. Compared
// numerically (via `codePointAt`) rather than embedded as literal control
// characters or `\u` escapes in string literals — those are easy to mangle
// silently (invisible bytes in source) and hard to review in a diff.
const CODE_CTRL_C = 0x03; // ETX — abort
const CODE_CTRL_D = 0x04; // EOT — submit (same as Enter)
const CODE_BACKSPACE = 0x7f; // DEL — most terminals send this for ⌫

/** Prompt + read one line from a real terminal with keystrokes masked (raw mode; Enter submits, Ctrl-C aborts, backspace works). */
function readMaskedLine(promptLabel: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${promptLabel} (input hidden): `);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      const code = chunk.codePointAt(0);
      if (chunk === "\n" || chunk === "\r" || code === CODE_CTRL_D) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (code === CODE_CTRL_C) {
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        process.exit(130); // conventional SIGINT exit code
      }
      if (chunk === "\b" || code === CODE_BACKSPACE) {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    stdin.on("data", onData);
  });
}

// ── CLI arg parsing (shared shape across store/resolve/delete) ─────────────

export interface ParsedArgs {
  /** Requested key names — defaults to all three if none given. */
  keys: VendorKeyName[];
  /** `--service <name>` override, or the caller's default if absent. */
  service?: string;
}

/**
 * Parse `--service <name>` (in any position) plus positional vendor key
 * names. Exits the process with a clear message on an unknown key name —
 * there's no reasonable recovery, and every caller wants the same behavior.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const keys: VendorKeyName[] = [];
  let service: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--service") {
      service = argv[++i];
      if (!service) {
        console.error("--service requires a value");
        process.exit(2);
      }
      continue;
    }
    if (arg.startsWith("--service=")) {
      service = arg.slice("--service=".length);
      continue;
    }
    if (!isVendorKeyName(arg)) {
      console.error(`Unknown key "${arg}". Expected one of: ${VENDOR_KEYS.join(", ")}`);
      process.exit(2);
    }
    keys.push(arg);
  }
  return { keys: keys.length > 0 ? keys : [...VENDOR_KEYS], service };
}
