#!/usr/bin/env node
/**
 * Eviction: take an `apps/*` package out of this repo and make it standalone.
 *
 * `apps/*` holds products rather than illustrations — things meant to end up in
 * their own repository, depending on `@habemus-papadum/*` through published
 * version ranges instead of `workspace:^`. They live here for now because
 * source-first linking is what makes iteration fast; eviction is the scripted,
 * repeatable step that undoes that.
 *
 * The valuable part is not the file copy. It is the **check**: an app can only
 * leave if every workspace package it depends on is either evicted alongside it
 * or already published to npm. Run that check in CI and "this app can still
 * stand alone" becomes a property the repo maintains, rather than a discovery
 * made on the day someone tries.
 *
 * (It has already earned its keep: `cc-miner` depended on
 * `@habemus-papadum/aiui-journal`, which is unpublished and — as it turned out —
 * never imported. The check is what makes that kind of thing loud.)
 *
 *   node scripts/evict.mjs --check                 # verify every app can leave
 *   node scripts/evict.mjs cc-miner cc-assay --out /tmp/cc   # produce the tree
 *   node scripts/evict.mjs cc-miner cc-assay --out /tmp/cc --history
 *
 * Flags:
 *   --check      report only; exit non-zero if anything is blocked (default
 *                when no app names are given, and the CI entry point)
 *   --out DIR    write the evicted tree to DIR (must be empty or absent)
 *   --history    additionally carry the git history for the evicted paths,
 *                via `git filter-repo`
 *   --scope S    npm scope for the rewritten deps (default @habemus-papadum)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(repoRoot, "apps");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SCOPE = value("--scope", "@habemus-papadum");
const OUT = value("--out", null);
const names = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const listApps = () =>
  readdirSync(APPS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(APPS, e.name, "package.json")))
    .map((e) => e.name);

/** Every workspace package name → its directory, so deps can be classified. */
function workspaceIndex() {
  const index = new Map();
  for (const dir of ["packages", "demos", "apps"]) {
    const root = join(repoRoot, dir);
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const manifest = join(root, e.name, "package.json");
      if (e.isDirectory() && existsSync(manifest)) {
        index.set(read(manifest).name, { dir: `${dir}/${e.name}`, manifest });
      }
    }
  }
  return index;
}

/**
 * Is this package name on npm, and at what version?
 *
 * Deliberately a real registry lookup rather than a guess from the local
 * version: the local one is the lockstep `X.Y.Z+dev`, which is precisely NOT
 * what an evicted app can depend on.
 */
function npmVersion(name) {
  const r = spawnSync("npm", ["view", name, "version"], { encoding: "utf8" });
  const v = r.status === 0 ? r.stdout.trim() : "";
  return v || null;
}

/**
 * Classify one app's workspace dependencies.
 *
 * `internal` — also being evicted, so it stays `workspace:^` in the new repo.
 * `published` — resolvable from npm; the range gets rewritten.
 * `blocked`   — neither. This is what makes eviction fail, loudly and by name.
 */
function classify(appName, evicting, index) {
  const manifest = join(APPS, appName, "package.json");
  const pkg = read(manifest);
  const out = { pkg, manifest, internal: [], published: [], blocked: [] };
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[section] ?? {})) {
      if (!String(range).startsWith("workspace:")) continue;
      const home = index.get(dep);
      const evictedToo = home && evicting.some((n) => home.dir === `apps/${n}`);
      if (evictedToo) out.internal.push({ dep, section });
      else {
        const v = npmVersion(dep);
        if (v) out.published.push({ dep, section, version: v });
        else out.blocked.push({ dep, section, dir: home?.dir ?? "(not in this workspace)" });
      }
    }
  }
  return out;
}

function checkOnly(evicting, index) {
  let blocked = 0;
  for (const name of evicting) {
    const c = classify(name, evicting, index);
    const flagged = c.blocked.length > 0;
    blocked += c.blocked.length;
    console.log(`\n${flagged ? "✗" : "✓"} apps/${name}  (${c.pkg.name})`);
    for (const d of c.internal) console.log(`    workspace  ${d.dep}  — evicted alongside`);
    for (const d of c.published) console.log(`    npm        ${d.dep} → ^${d.version}`);
    for (const d of c.blocked)
      console.log(`    BLOCKED    ${d.dep}  — not published, and not being evicted (${d.dir})`);
  }
  if (blocked) {
    console.error(
      `\n${blocked} dependency(ies) block eviction. Publish them, evict them too, or drop them.`,
    );
    process.exit(1);
  }
  console.log("\nAll apps can stand alone.");
}

/**
 * Rewrite one manifest for life outside this repo: published ranges for what
 * stays behind, and a real semver in place of the `+dev` lockstep marker.
 */
function rewriteManifest(c, evicting) {
  const pkg = structuredClone(c.pkg);
  for (const { dep, section, version } of c.published) {
    pkg[section][dep] = `^${version}`;
  }
  // The lockstep version belongs to this repo's release train (AGENTS.md). The
  // evicted repo owns its own line, so start it at the current number without
  // the `+dev` marker rather than inventing one.
  pkg.version = String(pkg.version).replace(/\+dev$/, "");
  // Names that were qualified by their old home are now the whole identity.
  pkg.private = true; // publishing is the new repo's decision, not this one's
  void evicting;
  return pkg;
}

/**
 * The new repo's workspace file: its members, plus the root settings that are
 * invisible to a package and load-bearing anyway.
 */
function evictedWorkspaceYaml(evicting) {
  const root = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  // Lift whole blocks rather than re-deriving them: they are hand-maintained
  // and commented, and the comments are the reason they exist.
  const block = (name) => {
    const m = root.match(new RegExp(`^${name}:\\n(?:[ \\t].*\\n|#.*\\n)*`, "m"));
    return m ? m[0] : "";
  };
  return (
    `# Generated by scripts/evict.mjs from pdum_aiui.\n` +
    `packages:\n${evicting.map((n) => `  - "${evictedDir(n)}"\n`).join("")}\n` +
    // `catalog:`/`catalogs:` travel too: evicted manifests keep their
    // `catalog:` references, and the definitions live only in the root
    // workspace file — without them pnpm cannot resolve the specifier at
    // all. Same class as overrides: root state a package copy leaves behind.
    [block("catalog"), block("catalogs"), block("overrides"), block("allowBuilds")]
      .filter(Boolean)
      .join("\n")
  );
}

/**
 * Fix the references that assumed a repo two levels up.
 *
 * `apps/<name>/` sits two directories below the root; `<name>/` in the evicted
 * repo sits one. Anything spelled `../../` therefore points one level too far.
 * Found by running the eviction and watching BOTH `tsc` and vite's esbuild fail
 * on the same unresolvable `extends` — a copy-only eviction produces a tree
 * that installs cleanly and then cannot compile.
 */
/**
 * The directory an app gets in the evicted repo.
 *
 * Its own package name, unscoped — NOT the `apps/` directory name. The two are
 * allowed to differ, and for pdum-cc-miner they do: it is staged in
 * `apps/cc-miner` (matching the repo it is destined for) while calling itself
 * `pdum-cc-miner`. A standalone repo should be laid out by what the packages
 * are called, so `pnpm -C <dir>` and `pnpm --filter <name>` agree.
 *
 * @param {string} appName directory under apps/
 * @returns {string}
 */
function evictedDir(appName) {
  const pkg = read(join(APPS, appName, "package.json"));
  return String(pkg.name).replace(/^@[^/]+\//, "");
}

/**
 * Copy the files git TRACKS under `prefix` into `dest`, preserving structure.
 *
 * Deliberately not a recursive copy with an ignore list. The first version was
 * exactly that, and it carried 427 MB of `release/`, 37 MB of `.aiui-cache/`,
 * plus `out/` and `.cache/` into the evicted tree — where Biome then tried to
 * format Electron's own JSON and failed the lint gate. Any denylist would have
 * needed extending for the next build directory somebody adds.
 *
 * Asking git is self-maintaining and states the right rule outright: a new repo
 * should contain what is under version control, and nothing else.
 *
 * @param {string} prefix repo-relative, e.g. "apps/cc-miner"
 * @param {string} dest
 */
function copyTracked(prefix, dest) {
  const files = execFileSync("git", ["ls-files", "-z", "--", prefix], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
  if (!files.length) {
    console.error(`nothing tracked under ${prefix} — is it committed?`);
    process.exit(1);
  }
  for (const rel of files) {
    const target = join(dest, rel.slice(prefix.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, rel), target);
  }
}

function reparent(dest) {
  // EVERY tsconfig, not just the base one. `apps/<name>/` is two levels below
  // the repo root; `<name>/` in the evicted repo is one. Missing a single file
  // here is silent until `tsc` reports it cannot read a path in /tmp — which is
  // exactly how apps/cc-miner/tsconfig.node.json was found after it was added.
  for (const f of readdirSync(dest)) {
    if (!/^tsconfig.*\.json$/.test(f)) continue;
    const p = join(dest, f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/\.\.\/\.\.\//g, "../"));
  }
  // `../../bin/aiui` is this repo's source-run shim. The evicted package has
  // `@habemus-papadum/aiui` as a real dependency, so the bin is on PATH.
  const manifest = join(dest, "package.json");
  const pkg = read(manifest);
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
    if (typeof v === "string" && v.includes("../../bin/aiui")) {
      pkg.scripts[k] = v.replace(/\.\.\/\.\.\/bin\/aiui/g, "aiui");
    }
  }
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
}

function produce(evicting, index, out) {
  if (existsSync(out) && readdirSync(out).length) {
    console.error(`--out ${out} is not empty; refusing to write into it.`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });

  for (const name of evicting) {
    const c = classify(name, evicting, index);
    if (c.blocked.length) {
      console.error(`apps/${name} is blocked; run --check for the list.`);
      process.exit(1);
    }
    // Hoisted to the root of the new repo: `apps/` was a staging area in this
    // one, and means nothing in a repo that contains only these.
    const dir = evictedDir(name);
    if (dir !== name) console.log(`  apps/${name} → ${dir}/  (by package name)`);
    const dest = join(out, dir);
    copyTracked(join("apps", name), dest);
    writeFileSync(
      join(dest, "package.json"),
      `${JSON.stringify(rewriteManifest(c, evicting), null, 2)}\n`,
    );
    reparent(dest);
  }

  // A workspace of its own, so co-evicted siblings still resolve to source —
  // AND carrying the root settings the packages silently depend on. Found the
  // hard way: without them the evicted tree failed to install
  // (ERR_PNPM_IGNORED_BUILDS on esbuild), and would then have typechecked
  // against two copies of duckdb-wasm, because Mosaic pins an exact older one
  // and only the `overrides` entry collapses them. Both settings live in the
  // root workspace file here, so neither travels with a package copy.
  writeFileSync(join(out, "pnpm-workspace.yaml"), evictedWorkspaceYaml(evicting));
  // Shared root config the packages extend by relative path. Without these the
  // tree installs and then fails to compile — see `reparent`.
  // .nvmrc travels because the generated workflows pin Node with
  // `node-version-file: .nvmrc` — without it CI fails at setup-node, before it
  // has run a single gate.
  for (const f of ["tsconfig.base.json", "biome.json", ".nvmrc"]) {
    if (existsSync(join(repoRoot, f))) cpSync(join(repoRoot, f), join(out, f));
  }
  // A root manifest, because the monorepo root's devDependencies are hoisted
  // and therefore invisible to a package copy. cc-assay compiled here and
  // failed there on `Cannot find type definition file for 'node'` — @types/node
  // was never its dependency, it was the root's. Carried wholesale rather than
  // guessed at: this is a superset to prune, which is the safe direction.
  const rootPkg = read(join(repoRoot, "package.json"));
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify(
      {
        name: `${SCOPE}/${evicting.join("-")}-workspace`,
        private: true,
        type: rootPkg.type,
        packageManager: rootPkg.packageManager,
        scripts: {
          typecheck: "pnpm -r typecheck",
          test: "pnpm -r test",
          lint: "biome check .",
        },
        devDependencies: rootPkg.devDependencies,
      },
      null,
      2,
    )}\n`,
  );

  // biome.json sets `vcs.useIgnoreFile`, so lint hard-errors without one; and
  // a repo that is about to hold a gitignored 110 MB data directory wants this
  // regardless. The per-package ignores (e.g. src/data/.gitignore) travel with
  // the copy, so this only needs the root-level entries.
  writeFileSync(join(out, ".gitignore"), "node_modules/\ndist/\n.DS_Store\n*.log\n");

  writeFileSync(
    join(out, "README.md"),
    `# ${evicting.join(" + ")}\n\nEvicted from \`pdum_aiui\` by \`scripts/evict.mjs\`.\n` +
      `Depends on \`${SCOPE}/*\` through published npm ranges; see each package's\n` +
      `manifest for the versions it was cut against.\n\n` +
      `The root \`devDependencies\` are copied wholesale from the source repo and\n` +
      `are a superset — prune them once the toolchain here settles.\n`,
  );
  // CI, from templates rather than from strings in this file — they are real
  // YAML, reviewable in place, and the evicted repo is the only place they can
  // actually run. scripts/_skeleton/ established the convention.
  const templates = join(repoRoot, "scripts", "_evicted");
  if (existsSync(templates)) cpSync(templates, out, { recursive: true });

  // `git init` LAST, and not merely as a convenience. biome.json sets
  // `vcs.useIgnoreFile`, and with no repository Biome walks UP looking for one
  // — out of /tmp and into whatever encloses it. Measured: an evicted tree at
  // /tmp/cc-evict linted files inside the source checkout and failed on
  // Electron's own bundled JSON. A repo of its own is what stops that.
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: out, encoding: "utf8" });
  if (git.status !== 0) console.error(`  (git init failed: ${git.stderr?.trim()})`);

  console.log(`\nWrote ${evicting.length} package(s) to ${out}`);
  console.log("Next:");
  console.log(`  cd ${out} && pnpm install && pnpm lint && pnpm typecheck && pnpm test`);
  console.log("  then: git add -A && git commit, and push to the new remote.");
}

/**
 * Carry the commits, not just the files.
 *
 * `git subtree split` only handles one prefix; `filter-repo` handles several
 * and can hoist them in the same pass, which is why it is the dependency. It is
 * not bundled with git, so this fails with the install line rather than a
 * confusing "command not found".
 */
function withHistory(evicting, out) {
  const probe = spawnSync("git", ["filter-repo", "--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error(
      "--history needs `git filter-repo` (not bundled with git).\n" +
        "  brew install git-filter-repo   # or: pipx install git-filter-repo",
    );
    process.exit(1);
  }
  const gitDir = join(out, ".git-history");
  execFileSync("git", ["clone", "--no-local", repoRoot, gitDir], { stdio: "inherit" });
  execFileSync(
    "git",
    [
      "-C",
      gitDir,
      "filter-repo",
      ...evicting.flatMap((n) => ["--path", `apps/${n}`]),
      "--path-rename",
      "apps/:",
    ],
    { stdio: "inherit" },
  );
  console.log(`\nHistory for ${evicting.join(", ")} is in ${gitDir}.`);
  console.log("It is a separate clone on purpose — inspect it before merging the trees.");
}

const index = workspaceIndex();
const evicting = names.length ? names : listApps();
for (const n of evicting) {
  if (!existsSync(join(APPS, n, "package.json"))) {
    console.error(`apps/${n} is not an app in this repo.`);
    process.exit(1);
  }
}

if (!OUT || flag("--check")) checkOnly(evicting, index);
else {
  produce(evicting, index, OUT);
  if (flag("--history")) withHistory(evicting, OUT);
}
