/**
 * providers.ts — built-in launcher recipes for well-known languages.
 *
 * `aiui setup-lsp` is Claude-driven: for an exotic language it works out how to
 * install + launch the server and hand-writes the launcher. But for common
 * languages that ship as npm binaries, a deterministic recipe is better than
 * asking the model to rediscover it each time — so python (pyright) and
 * typescript (typescript-language-server) have built-in recipes here. A recipe
 * emits the SAME executable-launcher + manifest format as a hand-authored one,
 * and is still probe-tested before being recorded — it is a shortcut, not a
 * hardcoded server the channel special-cases.
 *
 * The emitted launcher computes the project root from its own on-disk location
 * and resolves the server from the **nearest `node_modules/.bin` at or above**
 * that root (a workspace member finds its monorepo root's install). What
 * happens when no project install exists splits by the launcher's home:
 *
 *  - **Committed** (`.aiui/lsp/`, written by `aiui lsp provision`): strictly
 *    portable — no absolute machine paths, so a clone + install works. If the
 *    project doesn't have the server installed, `build` throws the actionable
 *    "add it as a devDep" message and the language is skipped, because the
 *    committed launcher could never run on a fresh clone either.
 *  - **Cache** (`.aiui-cache/lsp/`, the automatic bootstrap): the launcher gets
 *    a baked **fallback to the server that ships with aiui-lsp itself**
 *    (`bundledFallback`), resolved to an absolute path at generation time. The
 *    cache is gitignored and per-machine by definition, so the absolute path is
 *    fine — and it is what makes the reader work out of the box in projects
 *    that never installed a language server (most of them; the availability
 *    `require.resolve` resolves from aiui-lsp's own dependencies, NOT the
 *    project's, so without the fallback the check passes while the launcher
 *    exits 126).
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { workspaceMemberDirs } from "./workspace";

const require = createRequire(import.meta.url);

export interface BuiltLauncher {
  language: string;
  languageId: string;
  extensions: string[];
  /** The executable launcher's contents (a shell script with a shebang). */
  script: string;
  /** Human label recorded as `name` in the manifest. */
  name: string;
  initializationOptions?: Record<string, unknown>;
}

/** How a recipe builds its launcher — the home decides the failure story. */
export interface BuildOptions {
  /**
   * Bake a machine-local fallback into the launcher: when no
   * `node_modules/.bin` at or above the project has the server, exec the copy
   * that ships with aiui-lsp itself (an absolute path resolved at generation
   * time). Right for the gitignored cache bootstrap — per-machine by
   * definition, and the reason the reader works out of the box in projects
   * that never installed a language server. Wrong for committed launchers,
   * which must stay portable: without this flag, `build` instead REQUIRES a
   * project install and throws the actionable message when there is none.
   */
  bundledFallback?: boolean;
}

export interface ProviderRecipe {
  language: string;
  languageId: string;
  extensions: string[];
  /** Resolve the server for this project; throws with an actionable message if
   * the server binary can't be found (so setup can report + skip it). */
  build(projectRoot: string, opts?: BuildOptions): BuiltLauncher;
}

const shebang = "#!/usr/bin/env bash\n";

/**
 * The nearest `node_modules/.bin/<serverBin>` at or above `startDir`, or
 * undefined. The generation-time twin of the launcher's runtime walk-up, used
 * to decide whether a *portable* launcher can work here at all.
 */
function findBinUp(startDir: string, serverBin: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", serverBin);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The launcher script. It lives at `<root>/.aiui/lsp/<lang>/launch` (or the
 * `.aiui-cache` twin), so the project root is three levels up from the script;
 * it computes that at runtime and execs the first `node_modules/.bin/<serverBin>`
 * found walking up from there — the project's own install wins, and a workspace
 * member finds its monorepo root's. `serverBin` is the bin name the server
 * package publishes (pnpm/npm links it into `.bin`), e.g.
 * `typescript-language-server` or `pyright-langserver`.
 *
 * With no `fallbackEntry`, the script is **portable** (no absolute machine
 * paths — committable, works on any clone once dependencies are installed) and
 * a missing server is a loud exit 127 with the install hint. With one (the
 * cache bootstrap), the last line execs the aiui-lsp-bundled server via `node`
 * from PATH instead.
 */
function launcherScript(
  lang: string,
  serverBin: string,
  opts: { installHint: string; fallbackEntry?: string },
): string {
  const tail = opts.fallbackEntry
    ? `# No project install found — fall back to the server bundled with aiui-lsp.\n` +
      `# This launcher lives in the gitignored cache (machine-local), so the\n` +
      `# absolute path is fine here; a committed launcher never gets this line.\n` +
      `exec node "${opts.fallbackEntry}" --stdio "$@"\n`
    : `echo "aiui LSP launcher: ${serverBin} not found in node_modules/.bin at or above $ROOT — ${opts.installHint}" >&2\n` +
      `exit 127\n`;
  return (
    `${shebang}` +
    `# aiui LSP launcher — ${lang}. Generated by \`aiui setup-lsp\`.\n` +
    `# Speaks LSP on stdio; the channel/reader spawns this and pipes bytes.\n` +
    `# ROOT is this project (the launcher lives at .aiui/lsp/<lang>/launch, three\n` +
    `# levels down); the server is the nearest node_modules/.bin install at or\n` +
    `# above ROOT (a workspace member finds its monorepo root's), node from PATH.\n` +
    `ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"\n` +
    `DIR="$ROOT"\n` +
    `while true; do\n` +
    `  BIN="$DIR/node_modules/.bin/${serverBin}"\n` +
    `  [ -x "$BIN" ] && exec "$BIN" --stdio "$@"\n` +
    `  [ "$DIR" = "/" ] && break\n` +
    `  DIR="$(dirname "$DIR")"\n` +
    `done\n` +
    tail
  );
}

/**
 * Shared availability logic for a node-distributed server. Portable mode
 * requires a project (or ancestor) install and throws `installHint` without
 * one; fallback mode resolves the aiui-lsp-bundled entry (its own dependency,
 * so this only fails on a broken install) and bakes it into the script.
 */
function resolveServer(
  projectRoot: string,
  opts: BuildOptions | undefined,
  spec: { serverBin: string; entrySpecifier: string; installHint: string },
): { fallbackEntry?: string } {
  if (opts?.bundledFallback) {
    // Throws if aiui-lsp's own copy is missing — an environment so broken the
    // recipe cannot promise anything.
    return { fallbackEntry: require.resolve(spec.entrySpecifier) };
  }
  if (!findBinUp(projectRoot, spec.serverBin)) {
    throw new Error(`${spec.serverBin} not found in this project — ${spec.installHint}`);
  }
  return {};
}

/** pyright's stdio language server. */
const python: ProviderRecipe = {
  language: "python",
  languageId: "python",
  extensions: [".py", ".pyi"],
  build(projectRoot, opts): BuiltLauncher {
    const resolved = resolveServer(projectRoot, opts, {
      serverBin: "pyright-langserver",
      entrySpecifier: "pyright/langserver.index.js",
      installHint: "`pnpm add -D pyright` (or install it globally)",
    });
    const version = safeVersion("pyright");
    return {
      language: "python",
      languageId: "python",
      extensions: [".py", ".pyi"],
      script: launcherScript("python (pyright)", "pyright-langserver", {
        installHint: "pnpm add -D pyright",
        ...resolved,
      }),
      name: `pyright${version ? ` ${version}` : ""}`,
    };
  },
};

/** typescript-language-server (wraps tsserver) for TS/JS. */
const typescript: ProviderRecipe = {
  language: "typescript",
  languageId: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  build(projectRoot, opts): BuiltLauncher {
    const resolved = resolveServer(projectRoot, opts, {
      serverBin: "typescript-language-server",
      entrySpecifier: "typescript-language-server/lib/cli.mjs",
      installHint: "`pnpm add -D typescript-language-server typescript`",
    });
    // No `initializationOptions.tsserver.path`: an absolute tsserver path would
    // break portability. typescript-language-server finds the project's own
    // `typescript` from its cwd (the backend/probe spawn the launcher with cwd =
    // project root), so the project just needs `typescript` as a dependency.
    const version = safeVersion("typescript-language-server");
    return {
      language: "typescript",
      languageId: "typescript",
      extensions: typescript.extensions,
      script: launcherScript(
        "typescript (typescript-language-server)",
        "typescript-language-server",
        { installHint: "pnpm add -D typescript-language-server typescript", ...resolved },
      ),
      name: `typescript-language-server${version ? ` ${version}` : ""}`,
    };
  },
};

export const PROVIDERS: Record<string, ProviderRecipe> = { python, typescript };

/** Scan a project (shallowly recursive, skipping heavy dirs) for extensions that
 * a built-in provider owns; returns the provider keys, in a stable order.
 *
 * Monorepo-aware: when `projectRoot` is a workspace root, only its member
 * packages are scanned (so a top-level setup reflects the workspace's own
 * languages, not an unrelated nested project elsewhere in the tree — e.g. a
 * `packages/*` TS monorepo isn't dragged into Python by an `examples/` app).
 * A plain project falls back to walking its own tree. */
export function detectLanguages(projectRoot: string, maxDepth = 4): string[] {
  const extToProvider = new Map<string, string>();
  for (const [key, recipe] of Object.entries(PROVIDERS)) {
    for (const ext of recipe.extensions) extToProvider.set(ext, key);
  }
  const found = new Set<string>();
  const skip = new Set([
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
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.size === Object.keys(PROVIDERS).length) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
      } else {
        const dot = e.name.lastIndexOf(".");
        if (dot < 0) continue;
        const provider = extToProvider.get(e.name.slice(dot).toLowerCase());
        if (provider) found.add(provider);
      }
    }
  };
  // A workspace root reflects its members' languages; a plain project, its own tree.
  const roots = workspaceMemberDirs(projectRoot) ?? [projectRoot];
  for (const r of roots) walk(r, 0);
  return Object.keys(PROVIDERS).filter((k) => found.has(k));
}

function safeVersion(pkg: string): string | undefined {
  try {
    return (require(`${pkg}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
