/**
 * The scaffolder behind `pnpm create @habemus-papadum/aiui` — a fresh SolidJS
 * app pre-wired for the aiui loop.
 *
 * This scaffold is a *starting point*, not throwaway scenery (the retired
 * `aiui demo` command scaffolded that): the frontend-for-agents methodology
 * in miniature — durable roots, a disposable cell graph, the modal
 * interaction kit, agent tools — plus a banner telling the person what
 * they're looking at and to start talking. See templates/app/ for the app
 * itself.
 *
 * The operational contract: a marked directory is
 * **continued**, never re-scaffolded (`"aiui": { "scaffold": true }` in the
 * app's package.json), anything unmarked is refused, and the sandbox becomes
 * its own git repo so agent churn is versioned there and nowhere upstream.
 * Zero runtime dependencies on purpose — `pnpm create` downloads this package
 * fresh; every dependency is latency for the user.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What the scaffolder finds at the target path. */
export type TargetState = "new" | "existing-scaffold" | "occupied";

/**
 * Decide what to do with the target: `new` (missing or empty), an
 * `existing-scaffold` (package.json carries our marker — continue), or
 * `occupied` (anything else — refuse; never clobber unknown content).
 */
export function classifyTarget(target: string): TargetState {
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
      aiui?: { scaffold?: boolean };
    };
    if (pkg.aiui?.scaffold === true) {
      return "existing-scaffold";
    }
  } catch {}
  return "occupied";
}

/**
 * The dependency range the scaffold pins aiui packages to: this build's exact
 * release line when it has one, `latest` from a dev build (whose `X.Y.Z+dev`
 * doesn't exist on the registry).
 */
export function dependencyRange(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? `^${version}` : "latest";
}

/** A valid npm package name from the target directory's basename. */
export function appNameFrom(target: string): string {
  const slug = basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return slug || "aiui-app";
}

/**
 * Copy the template, restore the dot-paths npm strips from published tarballs
 * (`gitignore` → `.gitignore`, `envrc` → `.envrc`), and resolve the tokens:
 * the app's name (from the directory) and the aiui dependency range.
 *
 * `range` defaults to what this build should pin to, and exists so a caller can
 * override it: this repo's own `pnpm new-demo` scaffolds the same template into
 * `demos/<slug>` with `workspace:^`, resolving aiui packages from the checkout
 * instead of the registry. One template, both paths.
 */
export function scaffoldApp(
  template: string,
  target: string,
  version: string,
  range: string = dependencyRange(version),
): void {
  mkdirSync(target, { recursive: true });
  cpSync(template, target, { recursive: true });
  for (const undotted of ["gitignore", "envrc"]) {
    if (existsSync(join(target, undotted))) {
      renameSync(join(target, undotted), join(target, `.${undotted}`));
    }
  }
  const pkgFile = join(target, "package.json");
  writeFileSync(
    pkgFile,
    readFileSync(pkgFile, "utf8")
      .replaceAll("__APP_NAME__", appNameFrom(target))
      .replaceAll("__AIUI_VERSION_RANGE__", range),
  );
}

/**
 * The template directory shipped with this install. Probed upward from this
 * module because the relative depth differs between layouts: `dist/cli.js`
 * (bundled, installed) sits one level below the package root; the tsx-run
 * `src/scaffold.ts` sits two below.
 */
export function templateRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "templates", "app");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * The package manager that invoked us, read from npm_config_user_agent — so
 * `pnpm create` installs with pnpm and `npm create` with npm. Defaults to npm.
 */
export function packageManager(userAgent = process.env.npm_config_user_agent): "pnpm" | "npm" {
  return userAgent?.startsWith("pnpm/") ? "pnpm" : "npm";
}

/**
 * Make the sandbox its own git repo (best-effort): agent edits become
 * inspectable local history and can't wander into any surrounding project.
 * Skipped when the target already sits inside a work tree.
 */
export function initGitRepo(target: string): void {
  const git = (...args: string[]) => spawnSync("git", args, { stdio: "ignore" });
  if (git("--version").error) {
    return;
  }
  if (git("-C", target, "rev-parse", "--is-inside-work-tree").status === 0) {
    return;
  }
  if (git("-C", target, "init", "--quiet").status !== 0) {
    return;
  }
  git("-C", target, "add", "-A");
  // May fail without a user.name/email configured; the repo alone is enough.
  git("-C", target, "commit", "--quiet", "-m", "create-aiui scaffold");
}
