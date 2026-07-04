# @habemus-papadum/aiui-claude-plugin

The aiui Claude Code plugin **marketplace** — several plugins in one shipped directory, plus a
small CLI/library to locate them.

## The plugins

| Plugin            | What it carries                                                                                        | Loaded by `aiui claude`        |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `aiui`            | Workflow slash commands (`/aiui:aiui-status`, `/aiui:aiui-scaffold`), a placeholder skill, a helper script. | Always                         |
| `frontend-design` | Frontend-for-agents design principles for scientific/technical UI code. **Stub** — proposed content is parked in `drafts/` pending review. | Always                         |
| `session-browser` | Etiquette for driving the **shared session browser** through the Chrome DevTools MCP. **Stub** — proposed content (announce-before-acting, preserve the user's tabs; later, in-page visual indication tools) is parked in `drafts/` pending review. | Only when the Chrome DevTools MCP is attached |

The `drafts/` directory at the package root holds the full proposed skill texts; they ship
nowhere and load nowhere until they're reviewed and folded back into the plugins.

`aiui claude` loads plugins **directly**, with one `--plugin-dir` flag per plugin — no marketplace
install required. The `marketplace/.claude-plugin/marketplace.json` manifest makes the same
directory usable as a Claude Code plugin marketplace later.

## Layout

```
marketplace/
  .claude-plugin/marketplace.json
  plugins/
    aiui/               .claude-plugin/plugin.json + commands/ + skills/ + scripts/
    frontend-design/    .claude-plugin/plugin.json + skills/
    session-browser/    .claude-plugin/plugin.json + skills/
```

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

listPlugins(); // → ["aiui", "frontend-design", "session-browser"]
pluginDir("session-browser"); // → absolute plugin directory
```
