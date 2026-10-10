/**
 * The `create-aiui` bin — what `pnpm create @habemus-papadum/aiui [dir]` runs.
 *
 * Deliberately tiny: classify the target, copy the shipped template, make it a
 * git repo, install, print the next steps. All the interesting parts live in the
 * template (templates/app) and in scaffold.ts (which the tests exercise).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { classifyTarget, initGitRepo, packageManager, scaffoldApp, templateRoot } from "./scaffold";
import { VERSION } from "./version";

const USAGE = `create-aiui — scaffold a SolidJS + aiui-viz app with the voice dock, ready for an agent to edit

usage: pnpm create @habemus-papadum/aiui [dir] [--skip-install]

  dir             target directory (default: aiui-app); must be new, empty,
                  or a previous scaffold (which is continued, never overwritten)
  --skip-install  scaffold only; run your package manager's install yourself
`;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  const skipInstall = args.includes("--skip-install");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length > 1) {
    console.error(`error: expected at most one directory argument\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const target = resolve(process.cwd(), positional[0] ?? "aiui-app");

  switch (classifyTarget(target)) {
    case "occupied":
      console.error(
        `error: ${target} already exists and isn't a create-aiui scaffold\n` +
          "Pick an empty (or new) directory — the scaffold never overwrites existing content.",
      );
      process.exitCode = 1;
      return;
    case "existing-scaffold":
      console.log(`existing scaffold found at ${target} — continuing where it left off`);
      break;
    case "new": {
      const template = templateRoot();
      if (!template) {
        console.error("error: the app template did not ship with this install");
        process.exitCode = 1;
        return;
      }
      scaffoldApp(template, target, VERSION);
      console.log(`scaffolded your app at ${target}`);
      initGitRepo(target);
      break;
    }
  }

  const pm = packageManager();
  if (!skipInstall && !existsSync(join(target, "node_modules"))) {
    console.log(`installing dependencies with ${pm} (one time)…`);
    const install = spawnSync(
      pm,
      pm === "npm" ? ["install", "--no-audit", "--no-fund"] : ["install"],
      { cwd: target, stdio: "inherit" },
    );
    if (install.status !== 0) {
      console.error(`error: ${pm} install failed — fix that, then re-run this command to continue`);
      process.exitCode = install.status ?? 1;
      return;
    }
  }

  const rel = relative(process.cwd(), target) || ".";
  console.log(`
your app is ready. Next:

  cd ${rel}
  ${pm} run dev        # Vite; open the printed URL

The page explains itself from there: the starter is scenery for your agent to
point at, built to be rebuilt. The voice dock in the corner takes an OpenAI key
from OPENAI_API_KEY in the environment or from its own key pane. (Optional:
\`direnv allow\` in ${rel} activates .envrc — PATH + .env.)`);
}

main();
