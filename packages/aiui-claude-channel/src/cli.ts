import { buildProgram } from "./program";

// Executable entrypoint for the `aiui-claude-channel` bin. The `#!/usr/bin/env
// node` shebang is prepended to the built dist/cli.js by a rollup banner (see
// vite.config.ts), so this source stays valid TypeScript. This file is only ever
// executed, never imported — the testable logic lives in program.ts.
buildProgram()
  .parseAsync()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
