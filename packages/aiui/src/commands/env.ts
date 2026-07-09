/**
 * `aiui env` — print shell code that "activates" the current checkout, the
 * `. .venv/bin/activate` of this repo:
 *
 *     eval "$(./aiui env)"     # from the repo root (the ./aiui shim), or
 *     eval "$(aiui env)"       # anywhere aiui already resolves
 *
 * Activation means two things, both scoped to the current shell:
 *
 *  1. **PATH** gains the project's executable dirs — `<root>/bin` (checked-in
 *     shims, e.g. this repo's source-run `aiui`), the workspace root's
 *     `node_modules/.bin` (tsx, vite, vitest, biome, …), and the current
 *     package's own `.bin` when you're inside a nested workspace package.
 *     Each prepend is guarded, so re-running never duplicates entries.
 *  2. **Env files** are exported — `.env`, `.env.local`, `.env.dev`,
 *     `.env.dev.local` from the workspace root, later files winning (the
 *     same "dev"-mode order and file-beats-inherited-export convention as the
 *     channel's own env loading; a stale shell export can't shadow the file).
 *
 * The output also defines `aiui_deactivate` — restore the pre-activation PATH
 * and unset the file-sourced vars (values that pre-existed in the shell are
 * unset too, not restored — the file is the source of truth here).
 *
 * Everything on stdout is shell code and nothing else; the human-readable
 * summary (which dirs, which key *names* — never values) goes to stderr, so
 * `eval` stays clean while you still see what happened. Every emitted line is
 * semicolon-terminated so even an unquoted `eval $(aiui env)` — where the
 * shell collapses newlines to spaces — parses correctly.
 *
 * There is no pnpm-native equivalent of this (closest: `pnpm exec` for one
 * command, `pnpm bin` to print the .bin path). For automatic per-directory
 * activation, pair the checked-in `.envrc` with direnv — see that file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";

/** The env files read from the workspace root, in load order (later wins). */
export const ENV_FILES = [".env", ".env.local", ".env.dev", ".env.dev.local"] as const;

/**
 * Find the workspace root: the nearest ancestor of `start` carrying a
 * `pnpm-workspace.yaml` or a `.git`. Falls back to `start` itself (a bare
 * consumer project without either still gets its own ./node_modules/.bin).
 */
export function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

/**
 * Parse one dotenv file's text into ordered KEY → value entries. Deliberately
 * minimal (the files here hold API keys, not programs): `KEY=VALUE` lines, an
 * optional `export ` prefix, `#` comment lines and blanks skipped, one pair of
 * matching single or double outer quotes stripped. No escape processing, no
 * multiline values, no inline comments after unquoted values.
 */
export function parseDotenv(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    entries.set(match[1], value);
  }
  return entries;
}

/** Single-quote `value` for POSIX shells (embedded `'` becomes `'\''`). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Render the activation script. Pure — the command resolves dirs and reads
 * files, this just writes shell. Every line ends in `;` (see the module
 * header: unquoted `eval` survival), and each PATH prepend is wrapped in a
 * containment check so activation is idempotent.
 */
export function buildEnvScript(input: {
  /** Directories to prepend to PATH, highest priority first. */
  pathDirs: string[];
  /** Env entries to export (already merged across files, later-file wins). */
  vars: Map<string, string>;
}): string {
  const lines: string[] = [];
  lines.push(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    'if [ -z "${_AIUI_OLD_PATH:-}" ]; then _AIUI_OLD_PATH="$PATH"; export _AIUI_OLD_PATH; fi;',
  );
  // Prepend in reverse so pathDirs[0] ends up first on PATH.
  for (const dir of [...input.pathDirs].reverse()) {
    const q = shQuote(dir);
    lines.push(`case ":$PATH:" in *":"${q}":"*) : ;; *) PATH=${q}":$PATH"; export PATH ;; esac;`);
  }
  for (const [key, value] of input.vars) {
    lines.push(`export ${key}=${shQuote(value)};`);
  }
  const unsetVars = input.vars.size > 0 ? ` unset ${[...input.vars.keys()].join(" ")};` : "";
  lines.push(
    "aiui_deactivate () { " +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
      'if [ -n "${_AIUI_OLD_PATH:-}" ]; then PATH="$_AIUI_OLD_PATH"; export PATH; unset _AIUI_OLD_PATH; fi;' +
      `${unsetVars} unset -f aiui_deactivate; };`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The command: resolve the workspace root from the cwd, collect the PATH dirs
 * that exist, merge the env files, and print the script (stdout) + a summary
 * of what it does (stderr, names only — never a value).
 */
export function runEnv(): void {
  const cwd = process.cwd();
  const root = findWorkspaceRoot(cwd);

  const candidates = [join(root, "bin"), join(root, "node_modules", ".bin")];
  if (cwd !== root) {
    candidates.push(join(cwd, "node_modules", ".bin"));
  }
  const pathDirs = candidates.filter((dir) => existsSync(dir));

  const vars = new Map<string, string>();
  const sourceByKey = new Map<string, string>();
  for (const name of ENV_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) {
      continue;
    }
    for (const [key, value] of parseDotenv(readFileSync(path, "utf8"))) {
      vars.set(key, value);
      sourceByKey.set(key, name);
    }
  }

  process.stdout.write(buildEnvScript({ pathDirs, vars }));

  const keys = [...vars.keys()].map((key) => `${key} (${sourceByKey.get(key)})`);
  process.stderr.write(
    chalk.dim(
      `aiui env: root ${root}\n` +
        `aiui env: PATH + ${pathDirs.length > 0 ? pathDirs.join(", ") : "(nothing found)"}\n` +
        `aiui env: export ${keys.length > 0 ? keys.join(", ") : `(none — no ${ENV_FILES.join("/")} at root)`}\n` +
        `aiui env: activate with  eval "$(aiui env)"  — undo with  aiui_deactivate\n`,
    ),
  );
}
