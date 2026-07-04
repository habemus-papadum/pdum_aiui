/**
 * Test harness for driving a real `aiui claude` session end-to-end.
 *
 * The custom MCP channel only delivers events to an *interactive* Claude Code
 * session (print/`-p` mode never surfaces them), and that session is a full
 * terminal UI. So the harness runs `aiui claude` inside a `tmux` pane — which
 * gives Claude a real PTY and lets us both drive it (send keystrokes to clear
 * the startup prompts) and scrape it (`capture-pane` reads Claude's alternate-
 * screen UI, which `screen`'s `hardcopy` can't).
 *
 * This file lives under test/ (outside src/) so it's neither built nor
 * typechecked with the package — it's test-only support.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const AIUI_CLI = join(REPO_ROOT, "packages", "aiui", "src", "cli.ts");

const tmux = (args) =>
  execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function commandOnPath(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
export const tmuxAvailable = () => commandOnPath("tmux");
export const claudeAvailable = () => commandOnPath("claude");

/** A subscription login lets us drop a (possibly invalid) ambient API key. */
function subscriptionAuthAvailable() {
  return (
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    existsSync(join(homedir(), ".claude", ".credentials.json"))
  );
}

/**
 * Launch `aiui claude` (Haiku, no browser) in a detached tmux pane, clear the
 * startup prompts, and resolve once the channel server has registered.
 */
export async function launchClaudeSession(opts) {
  const model = opts.model ?? "haiku";
  const sessionName = opts.session ?? `aiui-e2e-${opts.tag}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 45_000;
  const cacheDir = mkdtempSync(join(tmpdir(), "aiui-e2e-cache-"));

  // The library helpers (sendPromptByTag/listMcpServers) resolve the registry
  // from process.env.AIUI_CACHE — point them at this session's isolated cache.
  const prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = cacheDir;

  // Preseed the first-run choices (the isolated cache has no user config, and
  // the launcher would otherwise prompt on the tmux TTY and stall the run):
  // permissions skipped — the TUI flow under test — and the enter nudge on,
  // with the harness's own send-keys rules as the fallback dismisser.
  writeFileSync(
    join(cacheDir, "config.json"),
    `${JSON.stringify({ claude: { skipPermissions: true, enterNudge: true } })}\n`,
  );

  // IS_SANDBOX skips the first-run --dangerously-skip-permissions confirmation.
  // If a subscription login exists, drop any ambient ANTHROPIC_API_KEY so Claude
  // authenticates via the subscription (CI sets CLAUDE_CODE_OAUTH_TOKEN instead).
  const unset = subscriptionAuthAvailable() ? "-u ANTHROPIC_API_KEY " : "";
  // Two distinct Chrome opt-outs: `--aiui-no-chrome` keeps the Chrome DevTools
  // MCP out of the session (no npx download or browser launch in e2e — CI would
  // skip it anyway, but be deterministic locally too), and Claude's own
  // `--no-chrome` (forwarded as passthrough) skips the browser-detection prompt
  // that would otherwise block this headless session.
  const cmd =
    `cd ${REPO_ROOT} && env ${unset}AIUI_CACHE=${cacheDir} IS_SANDBOX=1 ` +
    `${TSX} ${AIUI_CLI} claude --aiui-tag ${opts.tag} --aiui-no-chrome --no-chrome --model ${model}`;

  try {
    tmux(["kill-session", "-t", sessionName]);
  } catch {}
  tmux(["new-session", "-d", "-s", sessionName, "-x", "220", "-y", "50", cmd]);

  const capture = () => {
    try {
      return tmux(["capture-pane", "-t", sessionName, "-p", "-S", "-3000"]);
    } catch {
      return "";
    }
  };
  const findServer = () => {
    const dir = join(cacheDir, "mcp");
    if (!existsSync(dir)) return undefined;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (e.tag === opts.tag) return e;
      } catch {}
    }
    return undefined;
  };
  const waitForText = async (pattern, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (pattern.test(capture())) return true;
      await sleep(400);
    }
    return false;
  };
  const stop = async () => {
    try {
      tmux(["kill-session", "-t", sessionName]);
    } catch {}
    if (prevCache === undefined) delete process.env.AIUI_CACHE;
    else process.env.AIUI_CACHE = prevCache;
    // Give the channel server a moment to remove its own registry file.
    await sleep(2500);
  };
  const dispose = async () => {
    try {
      tmux(["kill-session", "-t", sessionName]);
    } catch {}
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {}
  };

  // Clear startup prompts until the channel server registers. Each rule fires
  // once: the dev-channels confirmation, and (on a fresh CI checkout) folder
  // trust — both are dismissed by confirming the default with Enter.
  const rules = [
    // Fresh-home first-run theme picker (Dark mode is the highlighted default, so
    // Enter accepts it). CI presets a theme in ~/.claude/settings.json to skip this
    // step entirely; this rule is the fallback for a fresh local checkout.
    { re: /run \/theme|dark mode.*light mode/i, keys: "Enter", fired: false },
    { re: /development channels|local development/i, keys: "Enter", fired: false },
    { re: /do you trust|trust the files|trust this folder/i, keys: "Enter", fired: false },
  ];
  const deadline = Date.now() + readyTimeoutMs;
  let entry = findServer();
  while (!entry && Date.now() < deadline) {
    const pane = capture();
    for (const rule of rules) {
      if (!rule.fired && rule.re.test(pane)) {
        tmux(["send-keys", "-t", sessionName, rule.keys]);
        rule.fired = true;
      }
    }
    await sleep(400);
    entry = findServer();
  }
  if (!entry) {
    const pane = capture();
    await dispose();
    throw new Error(`channel never registered within ${readyTimeoutMs}ms.\nLast pane:\n${pane}`);
  }

  return {
    tag: opts.tag,
    cacheDir,
    port: entry.port,
    capture,
    waitForText,
    findServer,
    stop,
    dispose,
  };
}
