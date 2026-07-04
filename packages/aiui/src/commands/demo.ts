/**
 * `aiui demo [dir]` — scaffold a disposable, runnable demo playground.
 *
 * The repo's `pnpm demo` serves `packages/aiui-demo` straight out of the
 * checkout — fine for developers, but every agent edit lands in the working
 * tree and wants to ride along upstream. This command is the outside-world
 * version: it copies a small sample app (Vite + the `aiuiDevOverlay()`
 * integration, real source) into a directory of the user's own, makes it a
 * standalone git repo, installs its dependencies, and prints how to run the
 * loop. Agent chaos stays in the sandbox, like a much-mutated notebook —
 * except versioned and nowhere near this repo.
 *
 * Designed for `npx @habemus-papadum/aiui demo my-demo` and for **re-running**:
 * the scaffold marks its package.json (`"aiui": { "demo": true }`), and a
 * marked directory is never re-scaffolded — a second run just tops up
 * `node_modules` if needed and reprints the next steps, so a demo in progress
 * (including everything the agent changed) continues exactly where it was.
 * The scaffold also lists `@habemus-papadum/aiui` as its own devDependency, so
 * after the one `npm install`, `npx aiui …` inside the directory resolves
 * locally — no repeated downloads.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { printError, printNote } from "../util/ui";
import { VERSION } from "../util/version";
import { commandExists } from "../util/which";

export interface DemoOptions {
  /** Scaffold only — skip `npm install` (used by the packaging test/CI). */
  skipInstall?: boolean;
}

/** What `aiui demo` finds at the target path. */
export type DemoTargetState = "new" | "existing-demo" | "occupied";

export async function runDemo(dir: string | undefined, opts: DemoOptions = {}): Promise<void> {
  const target = resolve(process.cwd(), dir ?? "aiui-demo");

  switch (classifyDemoTarget(target)) {
    case "occupied":
      printError(
        `${target} already exists and isn't an aiui demo`,
        "Pick an empty (or new) directory — the scaffold never overwrites existing content.",
      );
      process.exitCode = 1;
      return;
    case "existing-demo":
      printNote(`existing demo found at ${target} — continuing where it left off`);
      break;
    case "new": {
      const template = templateRoot();
      if (!template) {
        printError("the demo template did not ship with this aiui install");
        process.exitCode = 1;
        return;
      }
      scaffoldDemo(template, target);
      console.log(`scaffolded the demo playground at ${target}`);
      await initGitRepo(target);
      break;
    }
  }

  if (!opts.skipInstall && !existsSync(join(target, "node_modules"))) {
    if (!commandExists("npm")) {
      printNote("npm not found on PATH — run your package manager's install in the demo yourself");
    } else {
      console.log("installing dependencies (one time)…");
      const result = await execa("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: target,
        stdio: "inherit",
        reject: false,
      });
      if (result.exitCode) {
        printError("npm install failed — fix that, then re-run this command to continue");
        process.exitCode = result.exitCode;
        return;
      }
    }
  }

  printNextSteps(target);
}

/**
 * Decide what to do with the target: `new` (missing or empty), an
 * `existing-demo` (package.json carries the scaffold marker — continue), or
 * `occupied` (anything else — refuse; never clobber unknown content).
 */
export function classifyDemoTarget(target: string): DemoTargetState {
  if (!existsSync(target)) {
    return "new";
  }
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return "occupied"; // a file, or unreadable — either way, not ours
  }
  if (entries.length === 0) {
    return "new";
  }
  try {
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      aiui?: { demo?: boolean };
    };
    if (pkg.aiui?.demo === true) {
      return "existing-demo";
    }
  } catch {}
  return "occupied";
}

/**
 * The dependency range the scaffold pins aiui packages to: this build's exact
 * release line when it has one, `latest` from a dev build (whose `0.0.0+dev`
 * doesn't exist on the registry).
 */
export function demoDependencyRange(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? `^${version}` : "latest";
}

/** Copy the template, restore `.gitignore`, and pin dependency ranges. */
export function scaffoldDemo(template: string, target: string): void {
  mkdirSync(target, { recursive: true });
  cpSync(template, target, { recursive: true });
  // npm strips `.gitignore` files from tarballs, so the template ships it
  // undotted and the scaffold puts the dot back.
  if (existsSync(join(target, "gitignore"))) {
    renameSync(join(target, "gitignore"), join(target, ".gitignore"));
  }
  const pkgFile = join(target, "package.json");
  writeFileSync(
    pkgFile,
    readFileSync(pkgFile, "utf8").replaceAll(
      "__AIUI_VERSION_RANGE__",
      demoDependencyRange(VERSION),
    ),
  );
}

/**
 * Make the sandbox its own git repo (best-effort): agent edits become
 * inspectable local history and can't wander into any surrounding project.
 * Skipped when the target already sits inside a work tree.
 */
async function initGitRepo(target: string): Promise<void> {
  if (!commandExists("git")) {
    return;
  }
  const inside = await execa("git", ["-C", target, "rev-parse", "--is-inside-work-tree"], {
    reject: false,
  });
  if (inside.exitCode === 0) {
    return;
  }
  const init = await execa("git", ["-C", target, "init", "--quiet"], { reject: false });
  if (init.exitCode !== 0) {
    return;
  }
  await execa("git", ["-C", target, "add", "-A"], { reject: false });
  // May fail without a user.name/email configured; the repo alone is enough.
  await execa("git", ["-C", target, "commit", "--quiet", "-m", "aiui demo scaffold"], {
    reject: false,
  });
}

/**
 * The template directory shipped with this install. Probed upward from this
 * module because the relative depth differs between layouts: `dist/cli.js`
 * (bundled, installed) sits one level below the package root; the tsx-run
 * `src/commands/demo.ts` sits two below.
 */
export function templateRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "templates", "demo");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return undefined;
}

function printNextSteps(target: string): void {
  const rel = relative(process.cwd(), target) || ".";
  const rerun = rel === "aiui-demo" ? "aiui demo" : `aiui demo ${rel}`;
  console.log(`
demo ready. Run the loop:

  cd ${rel}
  npm run claude     # terminal 1 — Claude Code with the aiui channel + session browser
  npm run dev        # terminal 2 — the demo app (Vite + the intent tool)

then open the app in the session browser (the window you share with the agent):

  npx aiui open http://localhost:5173

Click the ✳ aiui button on the page and type an intent — it lands in the session
as a prompt. Re-run \`${rerun}\` anytime to continue this sandbox.`);
}
