# ⚠️ Read before running

::: danger This codebase is dangerous to run
It launches Claude Code in ways that trade safety for velocity, deliberately. Read this page
before running anything, and prefer **reading the code to running it**.
:::

## 1. Skipping permissions is a choice — make it deliberately

Your first interactive `aiui claude` asks whether to launch Claude Code with
`--dangerously-skip-permissions`, and saves the answer (`claude.skipPermissions` in
[config.json](./config)). With it on, every action the agent takes (shell commands, file writes,
network, the browser) runs without asking you first. That's the author's personal preference, not
a recommendation — aiui works perfectly well with Claude's own permission prompts left in charge;
there's no reason you can't use these tools without it.

The honest warning: one-time setup prompts are easy to wave through without reading. If you
answered on autopilot, you may now be running an unrestricted agent without ever deciding to.
Check what you chose (`~/.cache/aiui/config.json`), edit it to change your mind, or delete the
key to be asked again. One asymmetry to know: non-interactive launches (`-p`, scripts) with no
saved answer still default to skipping — set the key explicitly for headless use.

## 2. The custom channel requires total trust

The whole point of this project is a **custom channel** that injects externally-supplied prompts
into your live, permission-skipping Claude Code session (loaded via
`--dangerously-load-development-channels`). Think about what that means:

- Anything that can reach the channel's local web backend can steer your agent.
- The [iPad paint stream](./paint-stream) rides the same port (its sidecar is on by default —
  it costs nothing until something connects).
- **Who can reach that port is your `channel.bind` choice** — asked at first run, never silently
  widened. `loopback` (the default) keeps the whole surface this-machine-only; using the iPad then
  means tunneling the port yourself (Tailscale, `ssh -L`). `host` binds `0.0.0.0`: one port, and
  everything on it — prompt injection, `/debug`, the paint page — is reachable by
  **anyone on your network, unauthenticated**. That's the deliberate trusted-LAN posture: the
  boundary is your network, so choose it only where the network is genuinely yours alone (a home
  LAN — not café Wi-Fi, not an office network shared with other people).
- The channel code itself runs inside your session's trust boundary. If you don't understand what
  this code does, **the custom channel could do anything to your computer**.

You are placing a lot of trust in the author. Don't do that casually.

## 3. The agent gets a browser by default

`aiui claude` also attaches the
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) unless you opt out
(`--aiui-no-chrome`, or `chrome.enabled: false` in [config](./config); it's off automatically
under CI). Combined with skipped permissions, that means the agent can drive a real Chrome —
navigate anywhere, click, fill forms, run JavaScript in pages — without asking. Two things to
understand about how it's wired:

- By default the agent shares a **session browser** with you: one visible Chrome window,
  deliberately — the agent acts in the tabs you're looking at. It uses a project-local profile
  (`.aiui-cache/chrome/`), so it starts logged out of everything; but anything you log into
  *inside that browser* persists in the profile and is reachable by the agent in later sessions.
- The sharing works over Chrome's **DevTools debug port, which is unauthenticated**: any process
  that can reach it has full control of that browser. It binds to loopback only, so "any process"
  means anything running on your machine — and if you tunnel it for
  [remote development](./remote), anything on the remote machine too.
- The session browser also launches with **media prompts pre-answered**
  (`--auto-accept-camera-and-microphone-capture`, `--auto-accept-this-tab-capture`): any page
  open in it can capture the microphone, the camera, and its own tab **without a permission
  dialog**. This exists so the intent tool's dictation and screenshots don't re-prompt per
  dev-server port — but it applies to every page in that browser, so don't browse the open web
  in it.

Details: [The Agent's Browser](./chrome).

## The actual recommendation

**Read this code rather than use it.** It's a working reference for a real workflow — channel
registry, prompt injection, session discovery, TUI test harness — and its best use for most people
is as parts and patterns for building *your own* system, with *your own* trust decisions.

If you run it anyway: run it in a sandbox or a machine/account you can afford to lose, with
credentials you can revoke.

## Roadmap for softening this

- [x] Make skipping permissions an explicit, persisted choice (first-run prompt +
      `claude.skipPermissions` in [config.json](./config)). Choosing a specific
      `--permission-mode` is still open.
- [ ] Document the channel's exact attack surface (what listens where, who can connect).
- [ ] Narrow the channel backend to authenticated clients (partially done: it binds to
      `127.0.0.1` unless `channel.bind: "host"` deliberately widens it).
