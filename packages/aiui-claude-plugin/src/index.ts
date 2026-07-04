/**
 * The aiui Claude Code plugin marketplace — library entry.
 *
 * Re-exports the helpers that locate the bundled `marketplace/` directory and
 * the plugins inside it, so consumers (like `aiui claude`) can pass plugin
 * directories to `claude --plugin-dir` without hardcoding install paths.
 *
 * @packageDocumentation
 */

export { listPlugins, marketplaceDir, pluginDir } from "./commands/path";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-claude-plugin";
