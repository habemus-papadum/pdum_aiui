import { runClaude } from "./claude";

/**
 * `aiui setup-lsp` — configure this project's language servers with Claude
 * Code's help.
 *
 * This is not a batch tool: setting up a language server for an arbitrary
 * project (install the server, wire it to the project's venv/toolchain/compile
 * database, prove it speaks LSP) is exactly the kind of judgement a coding agent
 * is for. So `setup-lsp` launches an ordinary interactive Claude Code session
 * (via the same {@link runClaude} machinery as `aiui claude`) with a seed prompt
 * that tells Claude to run the `setup-lsp` skill against the current project.
 *
 * `claude` accepts a positional string as the initial prompt and stays
 * interactive, so the seed prompt is passed as the first passthrough arg and any
 * `extraArgs` (e.g. `--resume`, `--aiui-no-chrome`) forward after it.
 */
const SEED_PROMPT =
  "Set up language servers for this project: invoke the setup-lsp skill and follow it end to end. " +
  "Detect the languages, provision or hand-author a launcher for each, test every launcher with " +
  "`aiui lsp probe`, and only record servers whose probe passes. When done, summarize what was " +
  "configured, what was skipped and why, and how to re-run.";

export async function runSetupLsp(extraArgs: string[] = []): Promise<void> {
  await runClaude([SEED_PROMPT, ...extraArgs]);
}
