import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Resolve modules the way this package would at runtime.
const nodeRequire = createRequire(import.meta.url);

/**
 * Absolute root directory of an installed (or workspace-linked) dependency.
 *
 * Rather than resolve the package *through* the module system — which would hit
 * its `exports` map (forcing a built `dist/`, and normally blocking access to
 * `package.json`) — we ask Node for the `node_modules` dirs it would search and
 * read `package.json` straight off disk. This needs nothing special from the
 * target package (no `exports` entry) and works even when it has not been
 * built, so dev iteration requires no compile step.
 */
export function packageRoot(packageName: string): string {
  const segments = packageName.split("/");
  for (const base of nodeRequire.resolve.paths(packageName) ?? []) {
    const manifest = join(base, ...segments, "package.json");
    if (existsSync(manifest)) {
      return dirname(manifest);
    }
  }
  throw new Error(`could not locate the "${packageName}" package (is it installed?)`);
}

/** How to spawn a CLI: a program plus the args that precede any subcommand. */
export interface CliInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to run a dependency package's CLI, without ever needing it built
 * in a dev checkout.
 *
 * A package is considered "in dev" when it still carries its `src/` directory
 * (published tarballs ship only `dist/`). In that case we run the TypeScript
 * source directly through `tsx`, so edits take effect with no build step. Once
 * installed from npm, we run the built `dist` entry instead. Either way it is
 * spawned via the current Node with an absolute path, so it relies on neither
 * the PATH nor an executable bit.
 */
export function resolvePackageCli(packageName: string, binName?: string): CliInvocation {
  const root = packageRoot(packageName);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };

  const binRel =
    typeof pkg.bin === "string" ? pkg.bin : binName ? pkg.bin?.[binName] : firstValue(pkg.bin);
  if (!binRel) {
    throw new Error(
      `package ${packageName} declares no bin${binName ? ` named "${binName}"` : ""}`,
    );
  }

  if (existsSync(join(root, "src"))) {
    // dev: dist/cli.js -> src/cli.ts, run through tsx (no build needed).
    const srcRel = binRel.replace(/^\.?\/?dist\//, "src/").replace(/\.js$/, ".ts");
    return { command: process.execPath, args: ["--import", "tsx", resolve(root, srcRel)] };
  }
  // installed: run the built entry directly.
  return { command: process.execPath, args: [resolve(root, binRel)] };
}

function firstValue(bin: Record<string, string> | undefined): string | undefined {
  return bin ? Object.values(bin)[0] : undefined;
}
