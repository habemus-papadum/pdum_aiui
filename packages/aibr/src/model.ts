export type BrowserFamily = "chromium" | "chrome-for-testing";
export type BrowserSpec = { managed: BrowserFamily } | { executable: string };
export const DEVELOPMENT_MEDIA_ARGS = [
  "--auto-accept-camera-and-microphone-capture",
  "--auto-accept-this-tab-capture",
  "--autoplay-policy=no-user-gesture-required",
];
export type ExtensionSpec = { path: string } | { package: string; directory: string };

export interface Profile {
  schemaVersion: 1;
  id: string;
  name: string;
  browser: BrowserSpec;
  launch: {
    debugPort: number;
    headless: boolean;
    mediaPreset: "development" | "standard";
    extensions: ExtensionSpec[];
    extraArgs: string[];
  };
}

export type Target =
  | { profile: string; autoConnect?: boolean }
  | { dataDir: string; autoConnect?: boolean }
  | { endpoint: string }
  | { provider: string; id: string };

export interface Provider {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface Config {
  schemaVersion: 1;
  defaultTarget: string;
  targets: Record<string, Target>;
  providers: Record<string, Provider>;
  serverName: string;
  agents: Record<Agent, { args: string[]; yolo: boolean }>;
}

export type Agent = "claude" | "codex";

export interface Paths {
  config: string;
  data: string;
  cache: string;
  state: string;
}

export interface Selection {
  target: Target;
  label: string;
  source: string;
}

export interface Connection {
  endpoint: string;
  wsEndpoint: string;
  browserVersion: string;
  autoConnectDir?: string;
}

export interface Runtime {
  schemaVersion: 1;
  profileId: string;
  pid: number;
  processIdentity: string;
  executable: string;
  startedAt: string;
  launch: Profile["launch"];
  connection: Connection;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without NUL characters`);
  }
  return value;
}

export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.includes("\0"))) {
    throw new Error(`${label} must be an array of strings without NUL characters`);
  }
  return value;
}

export function name(value: unknown): string {
  const result = string(value, "Name");
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(result) ||
    ["__proto__", "constructor", "prototype"].includes(result)
  ) {
    throw new Error(
      `Invalid name ${result}: use lowercase letters, digits, hyphens or underscores`,
    );
  }
  return result;
}

export function port(value: unknown, allowZero = false): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) {
    throw new Error(`Port must be an integer from ${allowZero ? 0 : 1} to 65535`);
  }
  return n;
}

export function endpoint(value: unknown): string {
  const input = string(value, "Endpoint");
  const url = new URL(input);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Endpoint must be an HTTP(S) or WS(S) URL without userinfo or a fragment");
  }
  if (url.protocol.startsWith("http") && url.search) {
    throw new Error("Use a WebSocket endpoint for connections with query parameters");
  }
  return url.toString().replace(/\/$/, "");
}

export function redactEndpoint(value: string): string {
  const url = new URL(value);
  if (url.search) url.search = "[redacted]";
  return url.toString();
}

export function parseTarget(value: unknown): Target {
  const v = object(value, "Target");
  if ("profile" in v) {
    fields(v, ["profile", "autoConnect"], "target");
    if (v.autoConnect !== undefined && typeof v.autoConnect !== "boolean")
      throw new Error("autoConnect must be boolean");
    return { profile: name(v.profile), ...(v.autoConnect ? { autoConnect: true } : {}) };
  }
  if ("dataDir" in v) {
    fields(v, ["dataDir", "autoConnect"], "target");
    if (v.autoConnect !== undefined && typeof v.autoConnect !== "boolean")
      throw new Error("autoConnect must be boolean");
    return {
      dataDir: string(v.dataDir, "dataDir"),
      ...(v.autoConnect ? { autoConnect: true } : {}),
    };
  }
  if ("endpoint" in v) {
    fields(v, ["endpoint"], "target");
    return { endpoint: endpoint(v.endpoint) };
  }
  fields(v, ["provider", "id"], "target");
  return { provider: name(v.provider), id: string(v.id, "Provider target ID") };
}

export function parseBrowser(value: unknown): BrowserSpec {
  const v = object(value, "Browser");
  if ("managed" in v) {
    fields(v, ["managed"], "browser");
    if (v.managed !== "chromium" && v.managed !== "chrome-for-testing")
      throw new Error("Unknown browser family");
    return { managed: v.managed };
  }
  fields(v, ["executable"], "browser");
  return { executable: string(v.executable, "Browser executable") };
}

export function parseProfile(value: unknown): Profile {
  const v = object(value, "Profile");
  fields(v, ["schemaVersion", "id", "name", "browser", "launch"], "profile");
  if (v.schemaVersion !== 1) throw new Error("Unsupported profile schemaVersion");
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(string(v.id, "Profile ID"))) {
    throw new Error("Profile ID must be a UUID");
  }
  const launch = object(v.launch, "Launch options");
  fields(launch, ["debugPort", "headless", "mediaPreset", "extensions", "extraArgs"], "launch");
  if (typeof launch.headless !== "boolean") throw new Error("headless must be boolean");
  if (launch.mediaPreset !== "development" && launch.mediaPreset !== "standard")
    throw new Error("Unknown media preset");
  if (!Array.isArray(launch.extensions)) throw new Error("extensions must be an array");
  const extensions = launch.extensions.map((entry): ExtensionSpec => {
    const ext = object(entry, "Extension");
    if ("path" in ext) {
      fields(ext, ["path"], "extension");
      return { path: string(ext.path, "Extension path") };
    }
    fields(ext, ["package", "directory"], "extension");
    return {
      package: string(ext.package, "Extension package"),
      directory: string(ext.directory, "Extension directory"),
    };
  });
  const extraArgs = strings(launch.extraArgs, "extraArgs");
  const reserved =
    /^--(?:user-data-dir|remote-debugging[^=]*|headless|load-extension|disable-extensions[^=]*|auto-accept-camera-and-microphone-capture|auto-accept-this-tab-capture|autoplay-policy)(?:=|$)/;
  if (extraArgs.some((arg) => !arg.startsWith("--") || reserved.test(arg))) {
    throw new Error(
      "extraArgs must be --flags; profile, debugging, headless, media and extension flags use structured settings",
    );
  }
  return {
    schemaVersion: 1,
    id: string(v.id, "Profile ID"),
    name: name(v.name),
    browser: parseBrowser(v.browser),
    launch: {
      debugPort: port(launch.debugPort, true),
      headless: launch.headless,
      mediaPreset: launch.mediaPreset,
      extensions,
      extraArgs,
    },
  };
}
