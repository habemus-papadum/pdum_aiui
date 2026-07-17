/**
 * First-run choices: settings that deserve a deliberate answer, not a silent
 * default.
 *
 * Two of `aiui claude`'s behaviors are pure personal preference with real
 * consequences: whether to auto-dismiss the development-channel acknowledgement
 * prompt by typing into the user's terminal, and whether the channel's web
 * server binds loopback-only or the host interface (the trusted-LAN posture
 * that makes the whole unauthenticated surface — iPad paint page included —
 * reachable from the network). Neither should be something the user "tagged
 * along" with because a default existed — so the first interactive launch asks
 * (definitively: the prompts have no Enter-through default), and the answers
 * persist to the **user-level** config, after which nothing asks again.
 * Non-interactive sessions never prompt; unset values fall back to the
 * documented defaults (nudge: true, bind: loopback).
 *
 * (Whether to pass `--dangerously-skip-permissions` is no longer a first-run
 * question: it lives in `claude.args`, opt-in via `aiui config set-dsp`, and is
 * never added by default — see docs/guide/warning.)
 */
import { type AiuiConfig, type ChannelBind, updateUserConfig } from "./config";
import { type Choice, choose } from "./prompt";
import { printNote } from "./ui";

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (question: string, choices: Choice[]) => Promise<string>;

const CHANNEL_BIND_QUESTION =
  "One-time setup — where should the channel's web server bind?\n" +
  "Binding the HOST interface puts the session's whole web surface on your network,\n" +
  "UNAUTHENTICATED — the iPad paint page (`aiui paint url` prints its URL), but also prompt\n" +
  "injection, /debug, and every sidecar. That's the simple, single-port way to use the iPad —\n" +
  "on a network that is yours alone (a home LAN), not on café Wi-Fi. LOOPBACK keeps everything\n" +
  "this-machine-only; reaching it from an iPad is then up to you — tunnel the channel port\n" +
  "however you like (Tailscale, `ssh -L`). Saved as channel.bind in your user config;\n" +
  "--aiui-bind wins per launch.";

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

  if (updated.claude?.enterNudge === undefined) {
    const answer = await ask(ENTER_NUDGE_QUESTION, [
      { key: "y", label: "yes — press Enter for me at startup" },
      { key: "n", label: "no — I'll press it myself each launch" },
    ]);
    updated = persist(updated, "enterNudge", answer === "y");
  }

  if (updated.channel?.bind === undefined) {
    const answer = await ask(CHANNEL_BIND_QUESTION, [
      { key: "h", label: "host — reachable on my (trusted) network; the iPad just works" },
      { key: "l", label: "loopback — this machine only; I'll tunnel when I want the iPad" },
    ]);
    updated = persistBind(updated, answer === "h" ? "host" : "loopback");
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

function persistBind(config: AiuiConfig, value: ChannelBind): AiuiConfig {
  const file = updateUserConfig((c) => {
    c.channel = { ...c.channel, bind: value };
  });
  printNote(`wrote channel.bind: ${value} to ${file}`);
  return { ...config, channel: { ...config.channel, bind: value } };
}
