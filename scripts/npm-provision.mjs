#!/usr/bin/env node
// npm provisioning for trusted publishing — the deliberate, one-time-per-package
// steps that stand up OIDC publishing. Zero dependencies; run with the repo's Node.
//
// Publishing steps come in TWO separate acts (npm requires a package to *exist*
// before a trusted publisher can be attached to it):
//
//   1. reserve — publish a tiny placeholder so the name exists on the registry.
//                Uses your LOCAL npm auth (may prompt for 2FA). Run once per name.
//   2. trust   — attach this repo's release.yml as an OIDC trusted publisher, so
//                CI can publish with no long-lived token. Needs npm >= 11.15.0.
//
// After both, .github/workflows/release.yml publishes real versions over OIDC.
// The `publish` subcommand is the CI side of that (pack + `npm publish` a tarball).
//
// Subcommands:
//   list [--slugs]        list the publishable packages (name + slug, or bare slugs)
//   reserve [slug...]     placeholder-publish names not yet on the registry (local auth)
//   trust   [slug...]     attach the OIDC trusted publisher to each (npm >= 11.15.0)
//   publish               CI-only: pack each package and `npm publish` the tarball (OIDC)
//
// `reserve`/`trust`/`publish` default to ALL publishable packages when no slug is
// given. `reserve`/`trust` also accept `--dry-run`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const packagesDir = join(repoRoot, "packages");

// The workflow file that release.yml lives in — this is the identity npm ties the
// trusted publisher to (`npm trust github --file <this>`), so it must match exactly.
const WORKFLOW_FILE = "release.yml";
// Placeholder version for a name reservation. A prerelease sorts BELOW every real
// X.Y.Z release, so it can never collide with a future published version. It's
// published under a dedicated dist-tag (not `latest`) — npm requires a --tag for a
// prerelease anyway — so the first real CI release is what claims `latest`.
const RESERVE_VERSION = "0.0.0-reserve.0";
const RESERVE_TAG = "reserve";
// `npm trust` (the OIDC-config CLI) landed in this npm version.
const MIN_NPM_FOR_TRUST = "11.15.0";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

// --- package discovery -----------------------------------------------------

/**
 * Every packages/* that release.yml would publish: has a package.json and is not
 * `"private": true` (the --no-publish opt-out). Returns {slug, name, dir, access}.
 */
function listPublishable() {
  if (!existsSync(packagesDir)) return [];
  const out = [];
  for (const slug of readdirSync(packagesDir).sort()) {
    const pkgPath = join(packagesDir, slug, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private === true) continue; // --no-publish: pnpm/npm skip it
    out.push({
      slug,
      name: pkg.name,
      dir: join(packagesDir, slug),
      access: pkg.publishConfig?.access ?? "public",
      description: pkg.description ?? "",
      repository: pkg.repository,
    });
  }
  return out;
}

/** Resolve owner/repo (for `npm trust --repository`) from a package's repository url. */
function deriveRepoSlug(packages) {
  for (const p of packages) {
    const url = p.repository?.url ?? "";
    const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  // Fall back to the git remote.
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {}
  return fail("could not determine owner/repo for `npm trust --repository`");
}

/** Resolve the requested slugs (positional args) against the publishable set. */
function resolveTargets(slugs, publishable) {
  if (slugs.length === 0) return publishable;
  const bySlug = new Map(publishable.map((p) => [p.slug, p]));
  return slugs.map((s) => {
    const hit = bySlug.get(s) ?? bySlug.get(s.replace(/^.*\//, ""));
    if (!hit) fail(`"${s}" is not a publishable package (see \`npm-provision.mjs list\`)`);
    return hit;
  });
}

// --- helpers ---------------------------------------------------------------

/**
 * True if `name` has any published version. The `>=0.0.0-0` range is
 * prerelease-INCLUSIVE — a bare `npm view <name>` resolves `@*`, which excludes
 * prereleases like our `0.0.0-reserve.0` placeholder and would miss a reserved
 * name. Best-effort only: the npm registry read path is eventually consistent, so
 * a freshly reserved name can 404 here for a while even though it exists (the
 * website shows it immediately). Callers must not treat `false` as authoritative.
 */
function existsOnRegistry(name) {
  try {
    const out = execFileSync("npm", ["view", `${name}@>=0.0.0-0`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0;
  } catch {
    return false; // E404 (never published / not yet propagated) or offline
  }
}

/** Numeric semver-core compare of two X.Y.Z strings: -1 | 0 | 1. */
function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

function npmVersion() {
  return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

/**
 * A one-time 2FA code passed as `--otp=<code>`. npm's write endpoints (publish,
 * and *always* the `trust` endpoint) require 2FA when the account has it enabled;
 * a non-interactive spawn can't answer the prompt, so the caller supplies it here.
 * Only the `--otp=<code>` form is supported (unambiguous vs. positional slugs).
 */
function getOtp(args) {
  const hit = args.find((a) => a.startsWith("--otp="));
  return hit ? hit.slice("--otp=".length) : undefined;
}

// --- subcommands -----------------------------------------------------------

function cmdList(args) {
  const publishable = listPublishable();
  if (args.includes("--slugs")) {
    for (const p of publishable) process.stdout.write(`${p.slug}\n`);
    return;
  }
  for (const p of publishable) process.stdout.write(`${p.slug}\t${p.name}\t[${p.access}]\n`);
}

function cmdReserve(args) {
  const dryRun = args.includes("--dry-run");
  const otp = getOtp(args);
  const slugs = args.filter((a) => !a.startsWith("--"));
  const targets = resolveTargets(slugs, listPublishable());

  let reserved = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of targets) {
    if (existsOnRegistry(p.name)) {
      process.stdout.write(`• ${p.name} — already on the registry, skipping\n`);
      skipped++;
      continue;
    }
    process.stdout.write(`• ${p.name} — reserving ${RESERVE_VERSION} (${p.access})...\n`);

    // Publish a minimal placeholder from a throwaway dir so the working tree is
    // untouched. The real package is published later from CI at a real version.
    const staging = mkdtempSync(join(tmpdir(), `reserve-${p.slug}-`));
    try {
      const placeholder = {
        name: p.name,
        version: RESERVE_VERSION,
        description: `${p.description} (name-reservation placeholder — real releases are published from CI via trusted publishing).`,
        license: "MIT",
        repository: p.repository,
        publishConfig: { access: p.access },
      };
      writeFileSync(join(staging, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
      writeFileSync(
        join(staging, "README.md"),
        `# ${p.name}\n\nName-reservation placeholder. The real package is published from CI ` +
          `(\`.github/workflows/${WORKFLOW_FILE}\`) via npm trusted publishing.\n`,
      );
      const publishArgs = ["publish", "--access", p.access, "--tag", RESERVE_TAG];
      if (otp) publishArgs.push(`--otp=${otp}`);
      if (dryRun) publishArgs.push("--dry-run");
      // stdio: inherit so an npm 2FA/OTP prompt is visible and answerable.
      execFileSync("npm", publishArgs, { cwd: staging, stdio: "inherit" });
      reserved++;
    } catch {
      // Non-fatal: keep going so one package doesn't abort the batch. A common
      // benign cause on a re-run is the name already existing (EPUBLISHCONFLICT)
      // when the existence probe above hadn't yet caught up. npm's own message is
      // printed above (inherited stdio).
      process.stderr.write(`  ↳ publish failed for ${p.name} — see npm's output above.\n`);
      failed++;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    `\nreserve: ${reserved} ${dryRun ? "would be published" : "published"}, ${skipped} already present` +
      `${failed ? `, ${failed} failed` : ""}.\n` +
      (reserved > 0 && !dryRun
        ? `Next (separate step): attach the OIDC trusted publisher — \`pnpm npm:trust\`, or the\n` +
          `website if your npm account is passkey-only (see docs/guide/releasing.md).\n`
        : ""),
  );
  if (failed) process.exitCode = 1;
}

function cmdTrust(args) {
  const dryRun = args.includes("--dry-run");
  const otp = getOtp(args);
  const slugs = args.filter((a) => !a.startsWith("--"));
  const publishable = listPublishable();
  const targets = resolveTargets(slugs, publishable);
  const repoSlug = deriveRepoSlug(publishable);

  const ver = npmVersion();
  if (cmpVersion(ver.replace(/-.*$/, ""), MIN_NPM_FOR_TRUST) < 0) {
    process.stderr.write(
      `warning: npm ${ver} is older than the ${MIN_NPM_FOR_TRUST} the docs recommend for ` +
        `\`npm trust\`. Trying anyway; if it errors, run \`npm install -g npm@latest\` and retry.\n`,
    );
  }

  for (const p of targets) {
    // Best-effort heads-up only. We do NOT gate on this: the npm registry read
    // path is eventually consistent, so a just-reserved name can still 404 here
    // (yet be visible on npmjs.com). `npm trust` below talks to the registry and
    // is the real authority — if the name truly isn't there, it will say so.
    if (!existsOnRegistry(p.name)) {
      process.stderr.write(
        `note: couldn't confirm ${p.name} on the registry read API (it may still be ` +
          `propagating after reserve, or you're offline). Proceeding — \`npm trust\` will verify.\n`,
      );
    }
    process.stdout.write(
      `• ${p.name} — trusting ${repoSlug} · ${WORKFLOW_FILE} (--allow-publish)...\n`,
    );
    const trustArgs = [
      "trust",
      "github",
      p.name,
      "--file",
      WORKFLOW_FILE,
      "--repository",
      repoSlug,
      "--allow-publish",
      "-y",
    ];
    if (otp) trustArgs.push(`--otp=${otp}`);
    if (dryRun) trustArgs.push("--dry-run");
    try {
      execFileSync("npm", trustArgs, { stdio: "inherit" });
    } catch {
      process.stderr.write(
        `\n\`npm trust\` failed for ${p.name} (see npm's output above).\n` +
          `If it's a 403 / "two-factor authentication is required": the CLI can only answer 2FA\n` +
          `with a TOTP code (\`--otp=<code>\`), and npm no longer enrolls new TOTP authenticators.\n` +
          `Passkey-only accounts must configure this on the website instead:\n` +
          `  https://www.npmjs.com/package/${p.name}/access\n` +
          `  → Trusted Publisher → GitHub Actions → repo ${repoSlug}, workflow ${WORKFLOW_FILE}.\n`,
      );
      fail(`could not attach the trusted publisher for ${p.name}`);
    }
  }
  process.stdout.write(
    `\ntrust: configured ${targets.length} package(s). ` +
      `Releases via ${WORKFLOW_FILE} now publish over OIDC — no NPM_TOKEN needed.\n`,
  );
}

// CI-only: build has already run. Pack each publishable package (pnpm rewrites
// `workspace:^` -> the real version in the tarball), then `npm publish` the
// tarball over OIDC (trusted publishing supplies auth; provenance is automatic).
function cmdPublish() {
  const targets = listPublishable();
  const staging = mkdtempSync(join(tmpdir(), "npm-publish-"));
  for (const p of targets) {
    process.stdout.write(`\n=== ${p.name} ===\n`);
    const packOut = execFileSync("pnpm", ["pack", "--pack-destination", staging], {
      cwd: p.dir,
      encoding: "utf8",
    });
    // pnpm prints the tarball path as the last non-empty line of its output.
    const tarball = packOut
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".tgz"))
      .pop();
    if (!tarball || !existsSync(tarball)) fail(`could not locate packed tarball for ${p.name}`);
    execFileSync("npm", ["publish", tarball, "--provenance"], { stdio: "inherit" });
  }
  rmSync(staging, { recursive: true, force: true });
  process.stdout.write(`\npublished ${targets.length} package(s) over OIDC.\n`);
}

// --- CLI -------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "list":
    cmdList(rest);
    break;
  case "reserve":
    cmdReserve(rest);
    break;
  case "trust":
    cmdTrust(rest);
    break;
  case "publish":
    cmdPublish(rest);
    break;
  default:
    process.stderr.write(
      "usage: npm-provision.mjs <list [--slugs] | reserve [slug...] | trust [slug...] | publish> [--dry-run] [--otp=<code>]\n",
    );
    process.exit(2);
}
