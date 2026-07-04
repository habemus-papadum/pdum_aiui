# @habemus-papadum/aiui-claude-plugin

The aiui Claude Code plugin (skills, commands, scripts), plus a small CLI to
locate the bundled plugin directory.

## Install

```sh
npm install @habemus-papadum/aiui-claude-plugin
```

## CLI

```sh
# print the absolute path to the bundled plugin/ directory
aiui-claude-plugin path
```

The `path` command resolves the shipped `plugin/` directory whether the package
is installed from npm or run from source, so tooling can pass it to
`claude --plugin-dir "$(aiui-claude-plugin path)"` without hardcoding a path.

## Library

```ts
import { pluginDir } from "@habemus-papadum/aiui-claude-plugin";

pluginDir(); // → absolute path to the bundled plugin/ directory
```
