/**
 * Tiny child-process helper shared by both vault backends.
 *
 * Deliberately NOT `execFile`'s promisified form: that throws on a non-zero
 * exit and buries stdout inside the thrown error, but both backends need to
 * read stdout/stderr/exit-code together to distinguish "not found" (a normal,
 * expected outcome) from a real failure. `run` never throws for a non-zero
 * exit — callers inspect `code`. It DOES reject for a spawn failure (e.g. the
 * binary doesn't exist), which `runTool` below turns into a friendly error.
 *
 * Always invoked via `spawn(cmd, args, …)` with `args` as an array — never
 * through a shell — so nothing here is vulnerable to shell-quoting bugs, and
 * a secret handed through `input` never touches a shell (see the doc comment
 * on `RunOptions.input`).
 */

import { spawn } from "node:child_process";

export interface RunOptions {
  /**
   * Bytes to write to the child's stdin, then close it (EOF). Written
   * EXACTLY as given — no trailing newline is appended here. Both backends
   * rely on that byte-exactness (see the doc comments in `vault-macos.ts` /
   * `vault-linux.ts` on why a stray trailing newline matters for a secret).
   */
  input?: string;
}

export interface RunResult {
  /** Exit code, or `null` if the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `cmd args…`, capturing stdout/stderr. Resolves even on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.once("error", (err) => reject(err));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input, "utf8");
    child.stdin.end();
  });
}

/**
 * `run`, but a spawn failure (most commonly `ENOENT` — the CLI isn't
 * installed / not on PATH) is turned into a single clear Error instead of a
 * raw Node exception, using the caller-supplied install/setup hint.
 */
export async function runTool(
  cmd: string,
  args: string[],
  opts: RunOptions,
  notFoundHelp: string,
): Promise<RunResult> {
  try {
    return await run(cmd, args, opts);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`\`${cmd}\` was not found on PATH. ${notFoundHelp}`);
    }
    throw err;
  }
}
