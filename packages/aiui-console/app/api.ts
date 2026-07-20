/**
 * The channel facts the dashboard renders, and how it reads them. Everything is
 * same-origin JSON off the channel this page is served from — `/debug/api/info`
 * (channel identity + how it launched) and `/health` (the bind + live summaries)
 * — so the page needs no port, no discovery, no configuration.
 */

/** The connected Chrome, as the launcher recorded it (`launch.chromeDevtools`). */
export interface ChromeInfo {
  enabled?: boolean;
  connection?: "attach" | "launch";
  browserUrl?: string;
  userDataDir?: string;
  executablePath?: string;
  channel?: string;
  headless?: boolean;
  extensionDirs?: string[];
}

/** How the MCP server was launched (`/debug/api/info` → `launch`). */
export interface LaunchInfo {
  launcher?: string;
  chromeDevtools?: ChromeInfo;
  openaiKey?: string;
  geminiKey?: string;
}

/** `GET /debug/api/info` — this channel's own identity, plus the launch garnish. */
export interface ChannelInfo {
  tag?: string;
  pid?: number;
  ppid?: number;
  port?: number;
  cwd?: string;
  startedAt?: string;
  generation?: number;
  session?: string;
  debug?: boolean;
  launch?: LaunchInfo;
}

/** `GET /health` — the bind and the live client summaries. */
export interface HealthInfo {
  host?: string;
  /** Non-internal IPv4 interfaces — the LAN addresses a host-bound channel is
   *  reachable on. The dashboard renders a copy button per entry. */
  interfaces?: Array<{ name: string; address: string }>;
  pageTools?: { clients?: number; namespaces?: number; tools?: number };
  session?: { clients?: number; slots?: number; roles?: string[] };
}

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

export const fetchChannelInfo = (): Promise<ChannelInfo | undefined> =>
  getJson<ChannelInfo>("/debug/api/info");

export const fetchHealth = (): Promise<HealthInfo | undefined> => getJson<HealthInfo>("/health");
