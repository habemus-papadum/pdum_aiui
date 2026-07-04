# @habemus-papadum/aiui

ai ui frontends

## Install

```sh
npm install @habemus-papadum/aiui
```

## CLI

Installing the package provides an `aiui` command with two subcommands — thin launchers
for Claude and Vite (both are currently stubs):

```sh
aiui claude   # launch Claude
aiui vite     # launch Vite
aiui --help
```

Built with [commander](https://github.com/tj/commander.js) for the command tree and
[execa](https://github.com/sindresorhus/execa) to spawn the child processes. The command
implementations live in `src/commands/`.

During development, run the CLI straight from source (via `tsx`, no build) with the
`./aiui` launcher at the repo root:

```sh
./aiui claude
./aiui vite
./aiui --help
```

## Library usage

```ts
import { greet } from "@habemus-papadum/aiui";

greet("world"); // "Hello, world!"
```
