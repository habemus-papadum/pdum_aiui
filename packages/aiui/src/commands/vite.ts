import { execa } from "execa";
import { type CliInvocation, resolvePackageCli } from "../util/resolve-cli";
import { printError } from "../util/ui";

const VITE_PKG = "vite";

/**
 * Launch Vite, forwarding any extra args (e.g. `aiui vite dev`,
 * `aiui vite --port 3000`, `aiui vite --version`).
 *
 * Unlike `claude` — an external tool we look up on the PATH — Vite is a declared
 * dependency of this package, so we resolve it straight out of node_modules and
 * run it via the current Node with an absolute path. Resolving it also doubles
 * as the "is Vite available?" check: if it isn't installed, we fail loudly
 * rather than shelling out to nothing. See {@link resolvePackageCli}.
 */
export async function runVite(passthrough: string[] = []): Promise<void> {
  let vite: CliInvocation;
  try {
    vite = resolvePackageCli(VITE_PKG);
  } catch {
    printError(
      "Vite is not available",
      "`vite` should be installed as a dependency of aiui — try reinstalling.",
    );
    process.exitCode = 1;
    return;
  }

  // stdio inherit so the dev server owns the terminal and Ctrl-C reaches it.
  // reject:false so a non-zero/interrupted Vite exit is propagated as our exit
  // code instead of throwing an error the user didn't cause.
  const result = await execa(vite.command, [...vite.args, ...passthrough], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}
