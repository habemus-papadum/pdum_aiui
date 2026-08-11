# @habemus-papadum/aiui-claude-plugin

The aiui Claude Code plugin **marketplace** — several plugins in one shipped directory, plus a
small CLI/library to locate them.

## The plugins

| Plugin              | What it carries                                                                                        | Loaded by `aiui claude`        |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `aiui`              | The `aiui-workflow` skill — live introspection of the running aiui system (channel, browser, config).  | Always                         |
| `aiui-architecture` | How an aiui app is architected — the four-layer playbook and design principles for aiui-viz frontends. | Always                         |
| `session-browser`   | Etiquette and mechanics for driving the **shared session browser** through the Chrome DevTools MCP.    | Only when the Chrome DevTools MCP is attached |

`aiui claude` loads plugins **directly**, with one `--plugin-dir` flag per plugin — no marketplace
install required. The `marketplace/.claude-plugin/marketplace.json` manifest makes the same
directory usable as a Claude Code plugin marketplace later.

## Layout

```
marketplace/
  .claude-plugin/marketplace.json
  plugins/
    aiui/                .claude-plugin/plugin.json + skills/
    aiui-architecture/   .claude-plugin/plugin.json + skills/
    session-browser/     .claude-plugin/plugin.json + skills/
```

### Doc links: relative in dev, bundled at pack time

Skill markdown links into the repo's docs (`docs/guide/`, `packages/*/docs/`) with ordinary
**relative links** — in a
checkout they are the live docs, so there is no build step and nothing to go stale (the same
source-first rule as the workspace's editable installs). Self-containment happens at **pack
time**: the package's `prepack` hook (`scripts/bundle-skill-docs.mjs pack`) finds every
relative link that escapes the package, copies its target into a `references/` folder beside
the linking file (markdown copies get a GENERATED banner), and rewrites the link — so the
shipped tarball's skills work with no repo around them. `postpack` restores the markdown;
nothing generated is ever committed (leftover `references/` folders after a local pack are
gitignored and wiped by the next pack). The links themselves are the manifest — add a relative
link, and packing bundles it. CI runs `pnpm skills:check` to catch links that don't resolve.

## Install

```sh
npm install @habemus-papadum/aiui-claude-plugin
```

## CLI

```sh
aiui-claude-plugin list                   # the bundled plugin names
aiui-claude-plugin path                   # absolute path to the marketplace/ directory
aiui-claude-plugin path session-browser   # one plugin's directory (for --plugin-dir)
```

```sh
claude --plugin-dir "$(aiui-claude-plugin path session-browser)"
```

## Library

```ts
import { listPlugins, marketplaceDir, pluginDir } from "@habemus-papadum/aiui-claude-plugin";

listPlugins(); // → ["aiui", "aiui-architecture", "session-browser"]
pluginDir("session-browser"); // → absolute plugin directory
```
