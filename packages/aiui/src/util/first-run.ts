/**
 * First-run choices: settings that deserve a deliberate answer, not a silent
 * default.
 *
 * One of `aiui claude`'s behaviors is pure personal preference with no danger
 * either way: whether to auto-dismiss the development-channel acknowledgement
 * prompt by typing into the user's terminal. It shouldn't be something the user
 * "tagged along" with because a default existed — so the first interactive
 * launch asks (definitively: the prompt has no Enter-through default), and the
 * answer persists to the **user-level** config, after which nothing asks again.
 * Non-interactive sessions never prompt; an unset value falls back to the
 * documented default (nudge: true). While the nudge mechanism is disabled
 * (ENTER_NUDGE_ENABLED), its question is skipped — an answer nothing acts on is
 * worse than not asking.
 *
 * The channel's bind is deliberately NOT a first-run question: it defaults to
 * loopback (this-machine-only) with no prompt, and the ONLY opt-in to the
 * unauthenticated LAN posture (`channel.bind: host`) is the explicit, warned
 * `aiui config yolo` — which also flips `--dangerously-skip-permissions`. We do
 * not make picking host easy on first run (see docs/guide/warning).
 */
import { type AiuiConfig, updateUserConfig } from "./config";
import { ENTER_NUDGE_ENABLED } from "./enter-nudge";
import { type Choice, choose, type Prompt } from "./prompt";
import { printNote } from "./ui";

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (prompt: Prompt, choices: Choice[]) => Promise<string>;

const ENTER_NUDGE_PROMPT: Prompt = {
  title: "Auto-dismiss Claude Code's channel acknowledgement each launch?",
  detail:
    "aiui loads a custom development channel, so Claude Code shows a one-key acknowledgement " +
    "at every startup. aiui can press it for you — shortly after launch it injects a single " +
    "Enter into this terminal (a best-effort TIOCSTI ioctl on /dev/tty; where the OS forbids " +
    "that, nothing happens and you press it yourself). Saved as claude.enterNudge.",
};

/**
 * Ask (once, ever) for any first-run choice that isn't already configured, and
 * return the config with the answers applied. Call only from an interactive
 * session.
 */
export async function ensureLaunchChoices(
  config: AiuiConfig,
  ask: Ask = choose,
): Promise<AiuiConfig> {
  let updated = config;

  if (ENTER_NUDGE_ENABLED && updated.claude?.enterNudge === undefined) {
    const answer = await ask(ENTER_NUDGE_PROMPT, [
      { key: "y", label: "yes — press Enter for me at startup" },
      { key: "n", label: "no — I'll press it myself each launch" },
    ]);
    updated = persist(updated, "enterNudge", answer === "y");
  }

  return updated;
}

function persist(config: AiuiConfig, key: "enterNudge", value: boolean): AiuiConfig {
  const file = updateUserConfig((c) => {
    c.claude = { ...c.claude, [key]: value };
  });
  printNote(`wrote claude.${key}: ${value} to ${file}`);
  return { ...config, claude: { ...config.claude, [key]: value } };
}
