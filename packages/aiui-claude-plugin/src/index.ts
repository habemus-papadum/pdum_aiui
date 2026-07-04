/**
 * The aiui Claude Code plugin — library entry.
 *
 * Re-exports the helper that locates the bundled `plugin/` directory, so
 * consumers can load the shipped plugin programmatically without hardcoding an
 * install path.
 *
 * @packageDocumentation
 */

export { pluginDir } from "./commands/path";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-plugin";
