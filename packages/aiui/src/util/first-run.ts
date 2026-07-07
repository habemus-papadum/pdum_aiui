/**
 * First-run choices: settings that deserve a deliberate answer, not a silent
 * default.
 *
 * Three of `aiui claude`'s behaviors are pure personal preference with real
 * consequences: whether to launch with `--dangerously-skip-permissions`,
 * whether to auto-dismiss the development-channel acknowledgement prompt by
 * typing into the user's terminal, and whether to host the iPad paint surface
 * (an unauthenticated LAN listener). None should be something the user
 * "tagged along" with because a default existed — so the first interactive
 * launch asks (definitively: the prompts have no Enter-through default), and
 * the answers persist to the **user-level** config, after which nothing asks
 * again. Non-interactive sessions never prompt; unset values fall back to the
 * documented defaults (skip: true, nudge: true, paint: false).
 */
import { type AiuiConfig, updateUserConfig } from "./config";
import { type Choice, choose } from "./prompt";
import { printNote } from "./ui";

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (question: string, choices: Choice[]) => Promise<string>;

const SKIP_PERMISSIONS_QUESTION =
  "One-time setup — how should aiui launch Claude Code?\n" +
  "With --dangerously-skip-permissions, every agent action (shell commands, file writes,\n" +
  "network, the browser) runs without asking you first. Fast, and dangerous. It's a personal\n" +
  "preference — aiui works fine either way. Saved as claude.skipPermissions in your user\n" +
  "config; edit or delete it there to change your mind.";

const PAINT_SIDECAR_QUESTION =
  "One-time setup — host the iPad paint surface?\n" +
  "With sidecars.paint on, every `aiui claude` session also serves the iPad paint stream: a\n" +
  "SEPARATE, UNAUTHENTICATED listener on your LAN (the channel itself stays loopback-only).\n" +
  "Anyone on your network who finds it can watch the shared browser and draw into your armed\n" +
  "prompt — fine on a home network, not on café Wi-Fi. `aiui paint url` prints the URL to open\n" +
  "on the iPad. Saved as sidecars.paint in your user config; per-launch flags\n" +
  "(--aiui-sidecar/--aiui-no-sidecar paint) always win.";

const ENTER_NUDGE_QUESTION =
  "One-time setup — auto-dismiss Claude Code's channel prompt?\n" +
  "aiui loads a custom development channel, so Claude Code shows a one-key acknowledgement\n" +
  "prompt at every startup. aiui can dismiss it for you: shortly after launch it injects a\n" +
  "single Enter keystroke into this terminal (a best-effort TIOCSTI ioctl on /dev/tty — it\n" +
  'literally "types" the Enter for you; on platforms that forbid that, nothing happens and\n' +
  "you press it yourself). Saying no just means pressing Enter once per launch. Saved as\n" +
  "claude.enterNudge in your user config.";

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

  if (updated.claude?.skipPermissions === undefined) {
    const answer = await ask(SKIP_PERMISSIONS_QUESTION, [
      { key: "y", label: "yes — skip permissions; nothing asks before acting" },
      { key: "n", label: "no — keep Claude Code's own permission prompts" },
    ]);
    updated = persist(updated, "skipPermissions", answer === "y");
  }

  if (updated.claude?.enterNudge === undefined) {
    const answer = await ask(ENTER_NUDGE_QUESTION, [
      { key: "y", label: "yes — press Enter for me at startup" },
      { key: "n", label: "no — I'll press it myself each launch" },
    ]);
    updated = persist(updated, "enterNudge", answer === "y");
  }

  if (updated.sidecars?.paint === undefined) {
    const answer = await ask(PAINT_SIDECAR_QUESTION, [
      { key: "y", label: "yes — host the iPad paint surface on my (trusted) LAN" },
      { key: "n", label: "no — I'll pass --aiui-sidecar paint when I want it" },
    ]);
    updated = persistSidecar(updated, "paint", answer === "y");
  }

  return updated;
}

function persist(
  config: AiuiConfig,
  key: "skipPermissions" | "enterNudge",
  value: boolean,
): AiuiConfig {
  const file = updateUserConfig((c) => {
    c.claude = { ...c.claude, [key]: value };
  });
  printNote(`wrote claude.${key}: ${value} to ${file}`);
  return { ...config, claude: { ...config.claude, [key]: value } };
}

function persistSidecar(config: AiuiConfig, key: "paint", value: boolean): AiuiConfig {
  const file = updateUserConfig((c) => {
    c.sidecars = { ...c.sidecars, [key]: value };
  });
  printNote(`wrote sidecars.${key}: ${value} to ${file}`);
  return { ...config, sidecars: { ...config.sidecars, [key]: value } };
}
