import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDefaultManifest,
  type LspManifest,
  type LspServerEntry,
  launcherPath,
  loadManifest,
  type ProbeOp,
  type ProbeOpResult,
  type ProbeReport,
  probeLauncher,
  serverForLanguageId,
} from "@habemus-papadum/aiui-lsp";
import chalk from "chalk";
import { printError } from "../util/ui";

/**
 * `aiui lsp` — the tools `aiui setup-lsp` (and its skill) use to inspect, seed,
 * and *self-test* a project's language-server setup.
 *
 * The project root is always `process.cwd()`: these commands operate on the
 * project the user is standing in, reading/writing its `.aiui/lsp/` (falling back
 * to a legacy `.aiui-cache/lsp/` on read). `probe` is the load-bearing one — it
 * runs a real LSP handshake against a launcher so the skill never records a
 * server it hasn't proven works.
 */

/** Dirs the sample-file walk never descends into. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "__pycache__",
  ".aiui",
  ".aiui-cache",
]);

const NO_MANIFEST = "no LSP configured — run `aiui setup-lsp`";

interface ListOptions {
  json?: boolean;
}
interface ProvisionOptions {
  force?: boolean;
  json?: boolean;
}
interface ProbeOptions {
  file?: string;
  position?: string;
  json?: boolean;
}

/** `aiui lsp list` — show the current manifest, or point at setup. */
export function runLspList(opts: ListOptions = {}): void {
  const root = process.cwd();
  const manifest = loadManifestOrExit(root);
  if (!manifest) {
    if (opts.json) {
      console.log(JSON.stringify({ configured: false, servers: [] }, null, 2));
    } else {
      console.log(NO_MANIFEST);
    }
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (manifest.servers.length === 0) {
    console.log("LSP configured, but no servers recorded — run `aiui setup-lsp`.");
    return;
  }
  console.log(chalk.bold(`LSP servers (${manifest.servers.length}) — ${root}`));
  for (const s of manifest.servers) {
    const verified = s.verified
      ? s.verified.ok
        ? chalk.green(`verified ${s.verified.at}`)
        : chalk.red(`FAILED ${s.verified.at}`)
      : chalk.dim("unverified");
    console.log("");
    console.log(`  ${chalk.cyan(s.language)}  ${chalk.dim(s.name ?? "")}`);
    console.log(`    languageId : ${s.languageId}`);
    console.log(`    extensions : ${s.extensions.join(" ")}`);
    console.log(`    launcher   : ${relative(root, launcherPath(root, s))}`);
    console.log(`    status     : ${verified}`);
  }
}

/** `aiui lsp provision` — bootstrap python/js launchers from the built-in recipes. */
export function runLspProvision(opts: ProvisionOptions = {}): void {
  const root = process.cwd();
  const logs: string[] = [];
  const manifest = ensureDefaultManifest(root, {
    force: opts.force,
    onLog: (line) => logs.push(line),
    // A deliberate act: record the setup in the committed .aiui/lsp (the
    // implicit reader-backend bootstrap lands in the gitignored cache instead).
    home: "committed",
  });
  if (opts.json) {
    console.log(JSON.stringify({ logs, manifest }, null, 2));
    return;
  }
  for (const line of logs) {
    console.log(line);
  }
  if (manifest.servers.length === 0) {
    console.log(
      "No well-known languages provisioned. Hand-author launchers for other languages, then `aiui lsp probe <language>`.",
    );
    return;
  }
  console.log("");
  console.log(
    `Provisioned ${manifest.servers.length} server(s): ${manifest.servers.map((s) => s.language).join(", ")}.`,
  );
  console.log("Verify each with `aiui lsp probe <language>`.");
}

/**
 * `aiui lsp probe <language>` — the self-test. Load the manifest, find the
 * server, build a launch from its launcher, pick a sample file, run a real LSP
 * handshake + read-only ops, print ✓/✗ per op, and exit non-zero on failure.
 */
export async function runLspProbe(language: string, opts: ProbeOptions = {}): Promise<void> {
  const root = process.cwd();
  const manifest = loadManifestOrExit(root);
  if (!manifest) {
    printError(NO_MANIFEST);
    process.exitCode = 1;
    return;
  }
  const entry = serverForLanguageId(manifest, language);
  if (!entry) {
    printError(
      `no server for "${language}" in the manifest`,
      `configured: ${manifest.servers.map((s) => s.language).join(", ") || "(none)"}`,
    );
    process.exitCode = 1;
    return;
  }

  const sample = opts.file ? join(root, opts.file) : findSampleFile(root, entry.extensions);
  if (!sample) {
    printError(
      `no sample file found for "${entry.language}"`,
      `looked for files ending in ${entry.extensions.join(", ")} under ${root} — pass --file <relpath> to choose one`,
    );
    process.exitCode = 1;
    return;
  }
  let text: string;
  try {
    text = readFileSync(sample, "utf8");
  } catch (err) {
    printError(`could not read sample file ${sample}`, msg(err));
    process.exitCode = 1;
    return;
  }

  const position = parsePosition(opts.position);
  const ops: ProbeOp[] = ["documentSymbol", "hover", "foldingRange"];
  if (position) {
    ops.push("definition", "references");
  }

  const report = await probeLauncher({
    launch: { command: launcherPath(root, entry), args: [], cwd: root },
    rootUri: pathToFileURL(root).href,
    sample: {
      uri: pathToFileURL(sample).href,
      languageId: entry.languageId,
      text,
    },
    ...(position ? { position } : {}),
    ops,
    ...(entry.initializationOptions ? { initializationOptions: entry.initializationOptions } : {}),
    // Language servers vary wildly in cold-start time (pyright is quick; Julia's
    // LanguageServer.jl can take a while). Be generous so a slow-but-working
    // server isn't recorded as broken.
    timeoutMs: 60_000,
  });

  const passed = probePassed(report);
  if (opts.json) {
    console.log(JSON.stringify({ language: entry.language, sample, passed, report }, null, 2));
  } else {
    printProbeReport(entry, sample, report, passed);
  }
  // A spawned server (notably typescript-language-server, which traps SIGTERM to
  // shut tsserver down and can outlive the killed launcher) may keep Node's event
  // loop alive after the probe returns. This is a one-shot self-test — exit
  // deterministically once stdout has flushed.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(passed ? 0 : 1);
}

/** The LSP capability flag each optional op depends on. */
const OP_CAPABILITY: Record<string, string> = {
  documentSymbol: "documentSymbolProvider",
  foldingRange: "foldingRangeProvider",
  hover: "hoverProvider",
  definition: "definitionProvider",
  references: "referencesProvider",
};

/**
 * A failed op is "excused" when the server never advertised the capability it
 * needs — the *launcher* is fine, the server simply doesn't offer that feature
 * (pyright, for one, has no `foldingRangeProvider`). Excused ops don't fail the
 * probe; a genuine handshake or supported-op failure still does. The bare probe
 * report is stricter (`report.ok` requires every op), so the CLI applies this
 * capability-aware judgment on top of it.
 */
function isExcused(r: ProbeOpResult, caps: Record<string, unknown> | undefined): boolean {
  if (r.ok) return false;
  const flag = OP_CAPABILITY[r.op];
  return Boolean(flag) && !caps?.[flag];
}

/** Whether the launcher is usable: the handshake and every *advertised* op
 * passed (ops the server doesn't advertise are excused, not failures). */
function probePassed(report: ProbeReport): boolean {
  if (report.error) return false;
  return report.results.every((r) => r.ok || isExcused(r, report.serverCapabilities));
}

/** Load the manifest, surfacing a corrupt-manifest error loudly. Returns
 * `undefined` when simply absent (callers decide how to message that). */
function loadManifestOrExit(root: string): LspManifest | undefined {
  try {
    return loadManifest(root);
  } catch (err) {
    printError("the LSP manifest is present but unreadable", msg(err));
    process.exitCode = 1;
    return undefined;
  }
}

/** Pretty-print a probe report: one row per op (✓ ok, ○ unsupported-but-excused,
 * ✗ genuine failure), then the overall verdict. */
function printProbeReport(
  entry: LspServerEntry,
  sample: string,
  report: ProbeReport,
  passed: boolean,
): void {
  console.log(chalk.bold(`probe ${entry.language} — ${entry.name ?? entry.launcher}`));
  console.log(chalk.dim(`  sample: ${sample}`));
  for (const r of report.results) {
    const excused = isExcused(r, report.serverCapabilities);
    const mark = r.ok ? chalk.green("✓") : excused ? chalk.dim("○") : chalk.red("✗");
    const detail = excused
      ? "server does not advertise this capability"
      : (r.summary ?? r.error ?? "");
    console.log(`  ${mark} ${r.op}${detail ? chalk.dim(` — ${detail}`) : ""}`);
  }
  if (report.error) {
    console.log(chalk.red(`  error: ${report.error}`));
  }
  if (!passed && report.log.length) {
    console.log(chalk.dim("  log:"));
    for (const line of report.log) {
      console.log(chalk.dim(`    ${line}`));
    }
  }
  console.log(passed ? chalk.green("  → ok") : chalk.red("  → FAILED"));
}

/** Walk the project (skipping heavy dirs) for the first file whose extension is
 * one this server owns. Deterministic-ish: entries are sorted per directory. */
function findSampleFile(root: string, extensions: string[]): string | undefined {
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs: string[] = [];
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(join(dir, e.name));
        continue;
      }
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (exts.has(e.name.slice(dot).toLowerCase())) {
        return join(dir, e.name);
      }
    }
    // Depth-first, but visit shallower siblings before descending.
    for (const d of dirs.reverse()) stack.push(d);
  }
  return undefined;
}

/** Parse a `line:col` argument into a 0-based LSP position. */
function parsePosition(raw: string | undefined): { line: number; character: number } | undefined {
  if (!raw) return undefined;
  const m = /^(\d+):(\d+)$/.exec(raw.trim());
  if (!m) {
    throw new Error(`--position must be "line:col" (0-based), got "${raw}"`);
  }
  return { line: Number(m[1]), character: Number(m[2]) };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
