/**
 * Deciding whether — and where — to open this channel's dashboard as a tab in
 * the session browser.
 *
 * `aiui claude` launches the session browser and points the Chrome DevTools MCP
 * at it, but only the CHANNEL knows the port its web server bound, so the
 * dashboard tab (the console served at `/`) is opened here at boot, not baked
 * into the browser's launch. This is the pure decision — kept out of the mcp
 * command so it is testable without standing a server up.
 */
import type { ChromeDevtoolsInfo } from "./launch-info";

/** Whether a browser URL is loopback — the guard for opening our (loopback)
 * dashboard in it, so a remote/tunneled endpoint doesn't get an unreachable
 * tab. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The dashboard tab to open, or `undefined` when we shouldn't — i.e. unless the
 * launcher opened a LOCAL session browser this run: a loopback `browserUrl`
 * (so the dashboard is reachable) AND a `userDataDir` we manage (which a remote
 * `--aiui-browser-url` attach lacks). Launch-mode (no `browserUrl`) and the
 * no-browser modes fall out naturally.
 */
export function dashboardTabTarget(
  chrome: ChromeDevtoolsInfo | undefined,
  channelPort: number,
): { browserUrl: string; dashboardUrl: string } | undefined {
  if (!chrome?.browserUrl || !chrome.userDataDir || !isLoopbackUrl(chrome.browserUrl)) {
    return undefined;
  }
  return { browserUrl: chrome.browserUrl, dashboardUrl: `http://127.0.0.1:${channelPort}/` };
}
