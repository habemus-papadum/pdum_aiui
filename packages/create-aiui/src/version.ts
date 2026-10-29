// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guards are no-ops in the built CLI (where the define replaces each with a
// literal) but keep this working anywhere the define isn't applied — a source
// checkout run through tsx, or this package's own tests.
declare const __CREATE_AIUI_VERSION__: string;
declare const __AIUI_DEPENDENCY_VERSIONS__: Record<string, string>;

/** This build's version. */
export const VERSION =
  typeof __CREATE_AIUI_VERSION__ === "string" ? __CREATE_AIUI_VERSION__ : "0.0.0+dev";

/**
 * The version of each aiui package the template depends on, read from that
 * package's workspace manifest when this package was built: `X.Y.Z+dev`
 * between releases, so the scaffolder pins `^X.Y.Z`, that package's last
 * release. Every package releases on its own, so the lines differ. Empty when
 * nothing was baked (then the scaffolder writes `latest`).
 */
export const DEPENDENCY_VERSIONS: Readonly<Record<string, string>> =
  typeof __AIUI_DEPENDENCY_VERSIONS__ === "object" ? __AIUI_DEPENDENCY_VERSIONS__ : {};
