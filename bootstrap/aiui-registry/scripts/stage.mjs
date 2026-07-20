/**
 * Staging for publish: assemble the per-platform binary packages and the main
 * package (with `optionalDependencies` injected) under dist-publish/. The
 * source package.json deliberately does NOT carry the optionalDependencies —
 * they'd break `pnpm install` before first publish and drag a ~60 MB binary
 * into every dev install — so they are injected here, at stage time, the way
 * esbuild's publish pipeline does it.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryName, platformPackageName, TARGETS } from "./targets.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readManifest() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

/** Stage one platform package; the target's binary must already be built. */
export function stagePlatformPackage(key, version) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`unknown target ${key}`);
  }
  const binary = join(root, "dist-bin", binaryName(key));
  if (!existsSync(binary)) {
    throw new Error(`missing ${binary} — run \`pnpm binaries --target ${key}\` first`);
  }
  const dir = join(root, "dist-publish", `host-${key}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: platformPackageName(key),
    version,
    description: `aiui-registry native-messaging host binary (${key})`,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/habemus-papadum/pdum_aiui.git",
      directory: "bootstrap/aiui-registry",
    },
    os: [target.os],
    cpu: [target.cpu],
    files: ["aiui-registry-host"],
    publishConfig: { access: "public" },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const staged = join(dir, "aiui-registry-host");
  copyFileSync(binary, staged);
  chmodSync(staged, 0o755);
  writeFileSync(
    join(dir, "README.md"),
    `# ${manifest.name}\n\nThe compiled aiui-registry native-messaging host for ${key}. ` +
      "Installed automatically (via optionalDependencies + os/cpu) by " +
      "`@habemus-papadum/aiui-registry` — not for direct use.\n",
  );
  return dir;
}

/** Stage the main package: dist/ + README + a publish-shaped package.json. */
export function stageMainPackage(keys = Object.keys(TARGETS)) {
  const pkg = readManifest();
  if (!existsSync(join(root, "dist", "index.js"))) {
    throw new Error("missing dist/ — run `pnpm build` first");
  }
  const dir = join(root, "dist-publish", "main");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest = { ...pkg };
  // Dev-only fields have no business in the published manifest; scripts must
  // go so the prepublishOnly guard doesn't block THIS (staged) publish.
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.optionalDependencies = Object.fromEntries(
    keys.map((key) => [platformPackageName(key), pkg.version]),
  );
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  copyFileSync(join(root, "README.md"), join(dir, "README.md"));
  return dir;
}
