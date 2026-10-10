#!/usr/bin/env node
// npm provisioning helpers. Releases authenticate with the NPM_TOKEN secret
// (see AGENTS.md → Releasing), so a new package's first publish needs NO
// setup — the only live provisioning act here is the optional `reserve`.
// Zero dependencies; run with the repo's Node.
//
// Subcommands:
//   list [--slugs]        list the publishable packages (name + slug, or bare slugs)
//   reserve [slug...]     OPTIONAL: placeholder-publish names not yet on the registry,
//                         claiming them ahead of their first real release (local auth;
//                         may prompt for 2FA)
//   publish [--tag <t>]   pack each package and `npm publish` the tarball with ambient
//                         auth. The workflow publishes via `pnpm -r publish` instead;
//                         kept as the per-tarball alternative.
//
// `reserve`/`publish` default to ALL publishable packages when no slug is
// given. `reserve` also accepts `--dry-run`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const packagesDir = join(repoRoot, "packages");

// Placeholder version for a name reservation. A prerelease sorts BELOW every real
// X.Y.Z release, so it can never collide with a future published version. It's
// published under a dedicated dist-tag (not `latest`) — npm requires a --tag for a
// prerelease anyway — so the first real CI release is what claims `latest`.
const RESERVE_VERSION = "0.0.0-reserve.0";
const RESERVE_TAG = "reserve";

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

/**
 * A one-time 2FA code passed as `--otp=<code>`. npm's publish endpoint requires
 * 2FA when the account has it enabled; a non-interactive spawn can't answer the
 * prompt, so the caller supplies it here. Only the `--otp=<code>` form is
 * supported (unambiguous vs. positional slugs).
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
        description: `${p.description} (name-reservation placeholder — real releases are published from CI).`,
        license: "MIT",
        repository: p.repository,
        publishConfig: { access: p.access },
      };
      writeFileSync(join(staging, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
      writeFileSync(
        join(staging, "README.md"),
        `# ${p.name}\n\nName-reservation placeholder. The real package is published from CI ` +
          `(\`.github/workflows/release.yml\`).\n`,
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
        ? `Done — no further setup: the next release publishes real versions over the\n` +
          `NPM_TOKEN secret (see AGENTS.md → Releasing).\n`
        : ""),
  );
  if (failed) process.exitCode = 1;
}

// Pack each publishable package (pnpm rewrites `workspace:^` -> the real
// version in the tarball), then `npm publish` the tarball with ambient auth +
// --provenance. Build must have run first. The workflow uses `pnpm -r publish`
// instead; this remains as the per-tarball alternative.
function cmdPublish(args = []) {
  const targets = listPublishable();
  // A dist-tag, for canary builds. npm defaults to `latest`, which is exactly
  // what a prerelease must NOT become: `npm i @habemus-papadum/aiui-viz` would
  // start handing people a canary.
  const tagIdx = args.findIndex((a) => a === "--tag" || a.startsWith("--tag="));
  const distTag = tagIdx < 0 ? null : (args[tagIdx].split("=")[1] ?? args[tagIdx + 1]);
  if (tagIdx >= 0 && !distTag) fail("--tag needs a value, e.g. --tag canary");
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
    execFileSync(
      "npm",
      ["publish", tarball, "--provenance", ...(distTag ? ["--tag", distTag] : [])],
      { stdio: "inherit" },
    );
  }
  rmSync(staging, { recursive: true, force: true });
  process.stdout.write(
    `\npublished ${targets.length} package(s)${distTag ? ` under dist-tag "${distTag}"` : ""}.\n`,
  );
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
  case "publish":
    cmdPublish(rest);
    break;
  default:
    process.stderr.write(
      "usage: npm-provision.mjs <list [--slugs] | reserve [slug...] | publish [--tag <t>]> [--dry-run] [--otp=<code>]\n",
    );
    process.exit(2);
}
