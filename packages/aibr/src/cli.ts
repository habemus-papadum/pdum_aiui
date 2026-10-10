import { runCli } from "./program.ts";

try {
  await runCli();
} catch (error) {
  console.error(`aibr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
