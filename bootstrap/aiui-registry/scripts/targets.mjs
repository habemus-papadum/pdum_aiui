/**
 * The compile/publish target matrix, shared by build-binaries.mjs and the
 * staging/publish scripts. macOS + Linux only, like the installer.
 */

/** target key → { bun: bun --target value, os/cpu: npm manifest fields } */
export const TARGETS = {
  "darwin-arm64": { bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  "darwin-x64": { bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  "linux-x64": { bun: "bun-linux-x64", os: "linux", cpu: "x64" },
  "linux-arm64": { bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
};

/** The binary's filename inside dist-bin/ for a target key. */
export function binaryName(key) {
  return `aiui-registry-host-${key}`;
}

/** The npm platform-package name for a target key. */
export function platformPackageName(key) {
  return `@habemus-papadum/aiui-registry-host-${key}`;
}

/** The target key for the machine running this script (or undefined). */
export function currentTargetKey() {
  const key = `${process.platform}-${process.arch}`;
  return TARGETS[key] ? key : undefined;
}
