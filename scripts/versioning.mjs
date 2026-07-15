#!/usr/bin/env node
// Lockstep version engine for this pnpm monorepo. Zero dependencies — run with the
// repo's own Node. Versions are managed by CI (.github/workflows/release.yml);
// humans and agents should NOT run `set` by hand (see AGENTS.md).
//
// Lockstep covers TWO kinds of file: every package.json (which carries the full
// `X.Y.Z+dev` string) and the Chrome extension manifests (which carry only the
// semver CORE `X.Y.Z` — Chrome rejects a `-prerelease`/`+build` suffix). `set`
// keeps both in step; `current` verifies both.
//
// Subcommands:
//   current                  print the single shared version; exit 1 if packages
//                            disagree or an extension manifest is out of lockstep
//   latest-tag               print the highest vX.Y.Z git tag as X.Y.Z (or empty)
//   compute-release <bump>   print bump(latest-tag or 0.0.0, patch|minor|major)
//   set <version>            write <version> into every package.json's "version"
//                            field, and its semver core into each extension manifest

import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class VersionError extends Error {}

// --- workspace discovery ---------------------------------------------------

/** Parse the `packages:` globs out of pnpm-workspace.yaml (list form only). */
function workspaceGlobs() {
  let text;
  try {
    text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const globs = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
    if (match) {
      globs.push(match[1]);
    } else if (line.trim() !== "" && !/^\s/.test(line)) {
      inPackages = false;
    }
  }
  return globs;
}

/** Every package.json that carries the shared version: the root + each member. */
function versionFiles() {
  const files = [join(repoRoot, "package.json")];
  for (const glob of workspaceGlobs()) {
    for (const dir of globSync(glob, { cwd: repoRoot })) {
      const pkg = join(repoRoot, dir, "package.json");
      try {
        readFileSync(pkg);
        files.push(pkg);
      } catch {
        // directory without a package.json — skip it
      }
    }
  }
  return [...new Set(files)];
}

// --- extension manifests ---------------------------------------------------
//
// Chrome manifests carry their OWN `version`, and it must be plain dotted
// integers (1–4 parts, no `-prerelease`/`+build`) — so they cannot hold the
// `X.Y.Z+dev` the package.jsons carry between releases. They track the semver
// CORE instead: `set 0.5.0+dev` and `set 0.5.0` both stamp them `0.5.0`. Listed
// explicitly because none are package.json files (two are TS source, one is
// static JSON) and the workspace globs never reach them — a new extension's
// manifest belongs in this list.
const MANIFEST_FILES = [
  "packages/aiui-intent-client/src/ext/manifest.ts",
  "packages/aiui-extension/manifest.config.ts",
  "packages/aiui-devtools-extension/extension/manifest.json",
];

// The sole `version: "..."` / `"version": "..."` field (quoted or bare key),
// captured so it can be read or rewritten while leaving the rest of the file
// byte-for-byte intact. `("?)` + the `\2` backref match a quoted OR bare key
// symmetrically; anchoring `version` to the start of the (trimmed) line is what
// keeps it from matching `manifest_version`. Non-global on purpose: the first
// match is the real one.
const MANIFEST_VERSION_RE = /^(\s*)("?)version\2:(\s*)"([^"]*)"/m;

/** Semver core (drop `-prerelease` and `+build`): `0.4.0+dev` -> `0.4.0`. */
function semverCore(version) {
  const core = String(version).split("+")[0].split("-")[0];
  if (!/^\d+(\.\d+){0,3}$/.test(core)) {
    throw new VersionError(
      `cannot derive a Chrome manifest version from "${version}" (need 1–4 dotted integers)`,
    );
  }
  return core;
}

/** A manifest's declared version, or undefined if the file or field is absent. */
function readManifestVersion(rel) {
  let text;
  try {
    text = readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    return undefined; // a manifest that moved/renamed surfaces in the caller
  }
  const match = MANIFEST_VERSION_RE.exec(text);
  return match ? match[4] : undefined;
}

/** Write the semver core of `version` into every extension manifest. */
function setManifestVersions(version) {
  const core = semverCore(version);
  for (const rel of MANIFEST_FILES) {
    const file = join(repoRoot, rel);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // A manifest that isn't there is a real problem (renamed? deleted?), but a
      // missing FILE must not wedge a release — warn loudly and carry on.
      process.stderr.write(`warning: extension manifest ${rel} not found — skipped\n`);
      continue;
    }
    if (!MANIFEST_VERSION_RE.test(text)) {
      throw new VersionError(`no version field found in extension manifest ${rel}`);
    }
    const next = text.replace(
      MANIFEST_VERSION_RE,
      (_m, indent, quote, gap) => `${indent}${quote}version${quote}:${gap}"${core}"`,
    );
    if (next !== text) {
      writeFileSync(file, next);
    }
  }
}

// --- read / write ----------------------------------------------------------

function readVersion(file) {
  return JSON.parse(readFileSync(file, "utf8")).version;
}

/** The single shared version; throws VersionError if the tree disagrees. */
function currentVersion() {
  const seen = new Map();
  for (const file of versionFiles()) {
    seen.set(file, readVersion(file));
  }
  const distinct = new Set(seen.values());
  if (distinct.size !== 1) {
    const detail = [...seen]
      .map(([file, version]) => `  ${file.replace(`${repoRoot}/`, "")}: ${version}`)
      .join("\n");
    throw new VersionError(`packages are not in lockstep:\n${detail}`);
  }
  const shared = [...distinct][0];
  // The extension manifests are lockstep too, at the semver core (Chrome forbids
  // the `+dev` the packages carry). A drifted manifest is a lockstep failure.
  const core = semverCore(shared);
  const drift = [];
  for (const rel of MANIFEST_FILES) {
    const version = readManifestVersion(rel);
    if (version === undefined) {
      drift.push(`  ${rel}: (no version field found)`);
    } else if (version !== core) {
      drift.push(`  ${rel}: ${version} (expected ${core})`);
    }
  }
  if (drift.length > 0) {
    throw new VersionError(
      `extension manifests are out of lockstep (expected ${core}):\n${drift.join("\n")}`,
    );
  }
  return shared;
}

/** Write `version` into every package.json and its core into every manifest. */
function setVersion(version) {
  for (const file of versionFiles()) {
    const text = readFileSync(file, "utf8");
    const pkg = JSON.parse(text);
    pkg.version = version;
    const trailing = text.endsWith("\n") ? "\n" : "";
    writeFileSync(file, JSON.stringify(pkg, null, 2) + trailing);
  }
  setManifestVersions(version);
}

// --- semver (hand-rolled, X.Y.Z only) --------------------------------------

function bump(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new VersionError(`cannot bump non-release version "${version}" (expected X.Y.Z)`);
  }
  let [major, minor, patch] = match.slice(1).map(Number);
  if (level === "major") {
    [major, minor, patch] = [major + 1, 0, 0];
  } else if (level === "minor") {
    [minor, patch] = [minor + 1, 0];
  } else if (level === "patch") {
    patch += 1;
  } else {
    throw new VersionError(`unknown bump level "${level}" (expected patch|minor|major)`);
  }
  return `${major}.${minor}.${patch}`;
}

// --- git tag as truth ------------------------------------------------------

function latestTag() {
  let out;
  try {
    out = execFileSync("git", ["tag", "--list", "v[0-9]*", "--sort=-version:refname"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // don't leak git's stderr when there's no repo yet
    });
  } catch {
    return "";
  }
  for (const line of out.split(/\r?\n/)) {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return "";
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "current":
      process.stdout.write(`${currentVersion()}\n`);
      break;
    case "latest-tag":
      process.stdout.write(`${latestTag()}\n`);
      break;
    case "compute-release":
      if (!arg) {
        throw new VersionError("compute-release needs a bump level (patch|minor|major)");
      }
      process.stdout.write(`${bump(latestTag() || "0.0.0", arg)}\n`);
      break;
    case "set":
      if (!arg) {
        throw new VersionError("set needs a version");
      }
      setVersion(arg);
      process.stdout.write(`${arg}\n`);
      break;
    default:
      process.stderr.write(
        "usage: versioning.mjs <current | latest-tag | compute-release <bump> | set <version>>\n",
      );
      process.exit(2);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof VersionError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
