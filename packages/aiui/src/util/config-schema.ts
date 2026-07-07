/**
 * The declarative schema for aiui's `config.json` — one table that drives
 * everything config-shaped:
 *
 *   - validation (util/config.ts walks these sections instead of hand-rolled
 *     per-key checks),
 *   - the `aiui config` commands (show/get/set/unset use it to resolve keys,
 *     parse CLI values, and report defaults),
 *   - the `aiui config tui` browser (docs, defaults, and enum choices all
 *     render from here).
 *
 * Because docs, defaults, and validation come from the same rows, they cannot
 * drift apart. `docs/guide/config.md` remains the long-form narrative; the
 * `doc` strings here are the terminal-sized versions.
 *
 * **How a component participates.** `CONFIG_SECTIONS` is the registry: a
 * section is plain data, so a future component that grows file-backed settings
 * (say, an `intent` section for the pipeline) joins by contributing one
 * `ConfigSectionSchema` object here and a matching optional section on
 * `AiuiConfig`. Nothing else — validation, show/get/set, and the TUI pick it
 * up from the table. (The intent pipeline's current config is deliberately
 * *not* here: it is per-app, passed as `aiuiDevOverlay({ intent: { … } })` in
 * the app's Vite config — see docs/guide/intent-overlay.md.)
 */

// The channel list lives with the launch code (aiui-util's browser module,
// whose RELEASE_CHANNELS map must stay exhaustive over it); re-exported here
// so the config table keeps being the one import surface for config shapes.
import { CHROME_CHANNELS } from "@habemus-papadum/aiui-util";

export { CHROME_CHANNELS, type ChromeChannel } from "@habemus-papadum/aiui-util";

export const FOR_TESTING_MODES = ["prompt", "auto", "off"] as const;
export type ForTestingMode = (typeof FOR_TESTING_MODES)[number];

export const CHROME_MODES = ["attach", "launch"] as const;
export type ChromeMode = (typeof CHROME_MODES)[number];

export const CHANNEL_BINDS = ["loopback", "host"] as const;
export type ChannelBind = (typeof CHANNEL_BINDS)[number];

/** Every config leaf is a JSON scalar; sections never nest further. */
export type ConfigValue = boolean | number | string;

export interface ConfigFieldSchema {
  /** Leaf key within its section, e.g. `"skipPermissions"`. */
  key: string;
  /** `"enum"` is a string constrained to {@link values}. */
  type: "boolean" | "number" | "string" | "enum";
  /** The allowed values when {@link type} is `"enum"`. */
  values?: readonly string[];
  /** The built-in default, when the fallback is a plain value. */
  default?: ConfigValue;
  /**
   * Human phrasing of the default when a bare value would mislead (dynamic
   * fallbacks, first-run prompts). Shown instead of {@link default}.
   */
  defaultText?: string;
  /** One-line summary — the TUI's list row. */
  summary: string;
  /** The rest of the documentation (terminal-sized; optional). */
  doc?: string;
  /**
   * Constraint beyond type/enum. Returns the "expected …" tail of the error
   * message, or undefined when the value is fine.
   */
  validate?: (value: ConfigValue) => string | undefined;
}

export interface ConfigSectionSchema {
  /** Top-level key in config.json, e.g. `"chrome"`. */
  name: string;
  /** One-line summary of what the section configures. */
  summary: string;
  fields: ConfigFieldSchema[];
}

export const CONFIG_SECTIONS: ConfigSectionSchema[] = [
  {
    name: "claude",
    summary: "how `aiui claude` launches Claude Code",
    fields: [
      {
        key: "skipPermissions",
        type: "boolean",
        default: true,
        defaultText: "true (unset: the first interactive launch asks, then persists the answer)",
        summary: "Launch Claude Code with --dangerously-skip-permissions.",
        doc:
          "A personal preference with real consequences (docs/guide/warning): every agent " +
          "action — shell commands, file writes, network, the browser — runs without asking " +
          "first. aiui works fine either way. The first interactive launch asks and persists " +
          "the answer at the user level; when unset, non-interactive sessions fall back to true.",
      },
      {
        key: "enterNudge",
        type: "boolean",
        default: true,
        defaultText: "true (unset: the first interactive launch asks, then persists the answer)",
        summary: "Auto-dismiss Claude Code's development-channel acknowledgement prompt.",
        doc:
          "aiui loads a custom development channel, so Claude Code shows a one-key " +
          "acknowledgement at every startup; this injects a single Enter keystroke into the " +
          "terminal to dismiss it (best-effort TIOCSTI on /dev/tty — platforms that forbid it " +
          "harmlessly do nothing). Saying no just means pressing Enter yourself each launch.",
      },
    ],
  },
  {
    name: "channel",
    summary: "the channel server's web backend",
    fields: [
      {
        key: "bind",
        type: "enum",
        values: CHANNEL_BINDS,
        default: "loopback",
        defaultText:
          '"loopback" (unset: the first interactive launch asks, then persists the answer)',
        summary: "Which interface the channel web server binds: loopback, or host (LAN).",
        doc:
          '"host" (0.0.0.0) makes the session\'s whole web surface — the iPad paint page, but ' +
          "also prompt injection, /debug, and every sidecar — reachable by anyone on your " +
          "network, UNAUTHENTICATED. That is the trusted-LAN posture (docs/guide/warning): " +
          'right on a network that is yours alone, wrong on shared Wi-Fi. "loopback" keeps ' +
          "everything this-machine-only; reaching the paint page from an iPad is then up to " +
          "you — tunnel the channel port however you like (Tailscale, `ssh -L`). The first " +
          "interactive launch asks and persists the answer at the user level. Per-launch " +
          "flag: --aiui-bind.",
      },
    ],
  },
  {
    name: "sidecars",
    summary: "which session sidecars `aiui claude` asks the channel to host",
    fields: [
      {
        key: "paint",
        type: "boolean",
        default: true,
        summary: "Host the iPad paint sidecar (on the channel's own port).",
        doc:
          "The iPad paint stream (docs/guide/paint-stream) rides the channel's one port — no " +
          "extra process, no extra listener — so it is on by default; false turns it off. " +
          "Whether an iPad can actually reach it is channel.bind's call (host, or a tunnel " +
          "you own). Per-launch flags win: --aiui-sidecar paint / --aiui-no-sidecar paint. " +
          "`aiui paint url` prints the URL to open on the iPad.",
      },
    ],
  },
  {
    name: "chrome",
    summary: "the agent's browser and the Chrome DevTools MCP",
    fields: [
      {
        key: "enabled",
        type: "boolean",
        default: true,
        summary: "Attach the Chrome DevTools MCP.",
        doc:
          "false turns it off everywhere; true restates the default and does NOT override the " +
          "CI default-off — only the --aiui-chrome flag forces it on under CI.",
      },
      {
        key: "mode",
        type: "enum",
        values: CHROME_MODES,
        default: "attach",
        summary: "How the MCP reaches a browser: shared session browser, or its own.",
        doc:
          '"attach" shares a user-visible session browser: an already-running one is ' +
          'discovered by profile, or an interactive launch starts one eagerly. "launch" is ' +
          "the hands-off mode: chrome-devtools-mcp launches its own private browser lazily, on " +
          "the agent's first browser tool call.",
      },
      {
        key: "browserUrl",
        type: "string",
        defaultText: "unset (manage a browser locally)",
        summary: "Attach to this DevTools endpoint instead of managing a browser at all.",
        doc:
          "The remote-development key (docs/guide/remote): the browser runs on another machine " +
          "(started there with `aiui browser`) and its debug port is tunneled over. Setting it " +
          'implies mode: "attach" and makes every local-browser setting (profile, ' +
          "executablePath, channel, forTesting…) irrelevant. Per-launch flag: --aiui-browser-url.",
        validate: (value) =>
          isHttpUrl(String(value))
            ? undefined
            : 'expected an http(s) URL like "http://127.0.0.1:9222"',
      },
      {
        key: "debugPort",
        type: "number",
        default: 0,
        defaultText: "0 (an OS-assigned free port)",
        summary: "Fixed DevTools debug port for session browsers aiui launches.",
        doc:
          "Pin it (e.g. 9222) when something external must find the port — an ssh tunnel, a " +
          "VS Code attach-to-Chrome launch config. 0 means an OS-assigned free port.",
        validate: (value) =>
          Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535
            ? undefined
            : "expected 0..65535",
      },
      {
        key: "profile",
        type: "string",
        default: "default",
        summary: "Named profile under .aiui-cache/chrome/.",
        doc: "Per-launch flag: --aiui-chrome-profile.",
      },
      {
        key: "dataDir",
        type: "string",
        defaultText: "unset (derived from chrome.profile)",
        summary: "Explicit Chrome user data dir; takes precedence over chrome.profile.",
        doc: "Per-launch flag: --aiui-chrome-data-dir.",
      },
      {
        key: "executablePath",
        type: "string",
        defaultText: "unset (managed Chrome for Testing when installed, else installed Chrome)",
        summary: "Chrome binary to launch — e.g. a Chrome for Testing install.",
        doc:
          "Chrome for Testing still honors --load-extension, so the aiui DevTools panel can " +
          "auto-load. Mutually exclusive with chrome.channel.",
      },
      {
        key: "channel",
        type: "enum",
        values: CHROME_CHANNELS,
        defaultText: 'unset ("stable" when launching an installed Chrome)',
        summary: "Installed Chrome release channel to launch.",
        doc: "Mutually exclusive with chrome.executablePath.",
      },
      {
        key: "forTesting",
        type: "enum",
        values: FOR_TESTING_MODES,
        default: "prompt",
        summary: "How `aiui claude` manages the recommended Chrome for Testing install.",
        doc:
          '"prompt" asks before installing or updating it — interactive sessions only, never ' +
          'under CI; "auto" installs/updates without asking; "off" never checks. Prompt ' +
          'answers ("automatically", "never ask again") persist here at the user level. ' +
          "Skipped entirely when executablePath or channel picks a browser explicitly.",
      },
      {
        key: "headless",
        type: "boolean",
        default: false,
        summary: "Launch Chrome with no UI.",
      },
      {
        key: "buildExtension",
        type: "boolean",
        default: true,
        summary: "Rebuild the aiui-devtools-extension whenever a browser starts in a dev checkout.",
        doc:
          "~0.3s of tsc so the auto-loaded DevTools panel is never stale. Only relevant in a " +
          "dev checkout of pdum_aiui.",
      },
    ],
  },
];

/** A field paired with its section — what key-resolution hands back. */
export interface ResolvedField {
  section: ConfigSectionSchema;
  field: ConfigFieldSchema;
  /** The dotted path, e.g. `"chrome.mode"`. */
  path: string;
}

/** Every field in schema order, with dotted paths. */
export function allConfigFields(): ResolvedField[] {
  return CONFIG_SECTIONS.flatMap((section) =>
    section.fields.map((field) => ({ section, field, path: `${section.name}.${field.key}` })),
  );
}

/** Resolve a dotted path like `"chrome.mode"`; undefined when unknown. */
export function findConfigField(path: string): ResolvedField | undefined {
  return allConfigFields().find((entry) => entry.path === path);
}

/** The `typeof` a field's values (enums are strings). */
export function fieldRuntimeType(field: ConfigFieldSchema): "boolean" | "number" | "string" {
  return field.type === "enum" ? "string" : field.type;
}

/**
 * Constraint check beyond the runtime type: enum membership, then the field's
 * own `validate`. Returns the "expected …" tail for the error, or undefined.
 */
export function invalidReason(field: ConfigFieldSchema, value: ConfigValue): string | undefined {
  if (field.type === "enum" && !(field.values ?? []).includes(String(value))) {
    return `expected one of: ${(field.values ?? []).join(", ")}`;
  }
  return field.validate?.(value);
}

/**
 * Parse a CLI-provided string into the field's type and validate it — how
 * `aiui config set` and the TUI turn text into a config value.
 */
export function parseFieldValue(
  field: ConfigFieldSchema,
  raw: string,
): { value: ConfigValue } | { error: string } {
  let value: ConfigValue;
  switch (fieldRuntimeType(field)) {
    case "boolean": {
      if (raw !== "true" && raw !== "false") {
        return { error: "expected true or false" };
      }
      value = raw === "true";
      break;
    }
    case "number": {
      value = Number(raw);
      if (raw.trim() === "" || Number.isNaN(value)) {
        return { error: "expected a number" };
      }
      break;
    }
    default:
      value = raw;
  }
  const reason = invalidReason(field, value);
  return reason ? { error: reason } : { value };
}

/** Render a value the way config.json would hold it (strings quoted). */
export function formatConfigValue(value: ConfigValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** The default, phrased for humans: `defaultText` wins, then the value, then "unset". */
export function describeDefault(field: ConfigFieldSchema): string {
  if (field.defaultText) {
    return field.defaultText;
  }
  return field.default === undefined ? "unset" : formatConfigValue(field.default);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
