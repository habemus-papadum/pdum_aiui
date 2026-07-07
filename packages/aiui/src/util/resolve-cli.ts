import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageRoot, runningFromSource } from "@habemus-papadum/aiui-util";

// `packageRoot` (and the "still carries src/ → dev checkout" heuristic below)
// moved to aiui-util as shared provenance logic; re-exported here so existing
// importers keep resolving it from this module.
export { packageRoot } from "@habemus-papadum/aiui-util";

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

  if (runningFromSource(root)) {
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
