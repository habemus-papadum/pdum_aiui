/**
 * Locate the compiled native-messaging host binary at RUNTIME, from an
 * installed `@habemus-papadum/aiui-registry`. The binaries ship as per-platform
 * npm packages (`…-host-<platform>-<arch>`, the esbuild pattern) listed in this
 * package's `optionalDependencies` — the package manager fetches only the one
 * matching `os`/`cpu`, and this module resolves it as a sibling in
 * node_modules. In a source checkout (no platform packages installed) it
 * resolves nothing — callers fall back or fail loud, their choice.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The binary's filename inside a platform package. */
export const HOST_BINARY_NAME = "aiui-registry-host";

/** The published platform targets (keys are `<platform>-<arch>`). */
export const HOST_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

/** The platform-package name for this machine, or undefined when unsupported. */
export function hostBinaryPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const key = `${platform}-${arch}`;
  return (HOST_TARGETS as readonly string[]).includes(key)
    ? `@habemus-papadum/aiui-registry-host-${key}`
    : undefined;
}

export interface ResolveHostBinaryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Module-path resolver override (tests). Throws like `require.resolve`. */
  resolvePath?: (spec: string) => string;
}

/**
 * Absolute path to the host binary for this machine, or undefined when the
 * platform is unsupported or the platform package isn't installed.
 */
export function resolveHostBinary(options: ResolveHostBinaryOptions = {}): string | undefined {
  const pkg = hostBinaryPackage(options.platform, options.arch);
  if (!pkg) {
    return undefined;
  }
  const resolvePath = options.resolvePath ?? createRequire(import.meta.url).resolve;
  try {
    // The platform package has no `exports` field, so its package.json is a
    // resolvable subpath; the binary sits next to it.
    return join(dirname(resolvePath(`${pkg}/package.json`)), HOST_BINARY_NAME);
  } catch {
    return undefined;
  }
}
