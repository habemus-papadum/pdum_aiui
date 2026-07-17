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

/**
 * Which browser aiui downloads and manages for you when config names none
 * explicitly. Both honor `--load-extension` (so the intent client auto-loads)
 * and take the media auto-accept flags; the trade-off is Chromium's open-source
 * build dodges the "verify you're human" reCAPTCHA that Google serves to the
 * Chrome-for-Testing automation build, at the cost of Widevine/DRM + proprietary
 * codecs and Google account sign-in. Chromium is the default; flip the global
 * default with `chrome.managed`.
 */
export const MANAGED_FLAVORS = ["chromium", "chrome-for-testing"] as const;
export type ManagedFlavor = (typeof MANAGED_FLAVORS)[number];

/** The preferred managed browser when config doesn't say otherwise. */
export const DEFAULT_MANAGED_FLAVOR: ManagedFlavor = "chromium";

/**
 * How aggressively `aiui claude` keeps the managed browser installed/current.
 * (Formerly `chrome.forTesting`, back when Chrome for Testing was the only
 * managed flavor — that key still works as a deprecated alias.)
 */
export const MANAGE_MODES = ["prompt", "auto", "off"] as const;
export type ManageMode = (typeof MANAGE_MODES)[number];

/** @deprecated Use {@link MANAGE_MODES}. Kept for the `chrome.forTesting` alias. */
export const FOR_TESTING_MODES = MANAGE_MODES;
/** @deprecated Use {@link ManageMode}. */
export type ForTestingMode = ManageMode;

export const CHROME_MODES = ["attach", "launch"] as const;
export type ChromeMode = (typeof CHROME_MODES)[number];

export const CHANNEL_BINDS = ["loopback", "host"] as const;
export type ChannelBind = (typeof CHANNEL_BINDS)[number];

/**
 * A config leaf is a JSON scalar, or — for list-valued keys like `claude.args`
 * — an array of strings. Sections never nest further.
 */
export type ConfigValue = boolean | number | string | string[];

export interface ConfigFieldSchema {
  /** Leaf key within its section, e.g. `"args"`. */
  key: string;
  /** `"enum"` is a string constrained to {@link values}; `"string[]"` is a list of strings. */
  type: "boolean" | "number" | "string" | "enum" | "string[]";
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
        key: "args",
        type: "string[]",
        defaultText: "unset (no extra arguments)",
        summary: "Extra arguments passed verbatim to `claude` on every launch.",
        doc:
          "An argv list prepended to the `claude` invocation on every `aiui claude`, ahead of " +
          "any per-launch passthrough. This is how --dangerously-skip-permissions is applied " +
          "now — there is no separate skipPermissions flag. Add that flag with `aiui config " +
          "set-dsp`, or replace the whole list with `aiui config set claude.args` (a JSON " +
          "array). With --dangerously-skip-permissions every agent action — shell commands, " +
          "file writes, network, the browser — runs without asking first (docs/guide/warning); " +
          "it is opt-in and never added by default.",
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
        defaultText: "unset (the managed browser — see chrome.managed — else installed Chrome)",
        summary: "Explicit browser binary to launch — e.g. a Chrome for Testing install.",
        doc:
          "Overrides chrome.managed. Chrome for Testing and Chromium both honor " +
          "--load-extension, so the intent client auto-loads. Mutually exclusive with " +
          "chrome.channel.",
      },
      {
        key: "channel",
        type: "enum",
        values: CHROME_CHANNELS,
        defaultText: 'unset ("stable" when launching an installed Chrome)',
        summary: "Installed Chrome release channel to launch.",
        doc: "Overrides chrome.managed. Mutually exclusive with chrome.executablePath.",
      },
      {
        key: "managed",
        type: "enum",
        values: MANAGED_FLAVORS,
        default: DEFAULT_MANAGED_FLAVOR,
        summary: "Which browser aiui downloads and manages: Chromium, or Chrome for Testing.",
        doc:
          '"chromium" (default) is the open-source build — it dodges the "verify you\'re ' +
          'human" reCAPTCHA that Google serves to the Chrome-for-Testing automation build, ' +
          "at the cost of Widevine DRM, some proprietary codecs, and Google account sign-in. " +
          '"chrome-for-testing" is Google\'s branded automation build. Both auto-load the ' +
          "intent client and take the media auto-accept flags. Ignored when executablePath or " +
          "channel names a browser explicitly. Each flavor keeps its own project profile " +
          "under .aiui-cache/chrome/<flavor>/.",
      },
      {
        key: "manage",
        type: "enum",
        values: MANAGE_MODES,
        default: "prompt",
        summary: "How `aiui claude` keeps the managed browser (chrome.managed) installed/current.",
        doc:
          '"prompt" asks before installing or updating it — interactive sessions only, never ' +
          'under CI; "auto" installs/updates without asking; "off" never checks. Prompt ' +
          'answers ("automatically", "never ask again") persist here at the user level. ' +
          "Skipped entirely when executablePath or channel picks a browser explicitly. " +
          "(Was chrome.forTesting.)",
      },
      {
        key: "forTesting",
        type: "enum",
        values: MANAGE_MODES,
        defaultText: "unset (deprecated alias for chrome.manage)",
        summary: "DEPRECATED — old name for chrome.manage; still honored when manage is unset.",
        doc:
          "Renamed to chrome.manage now that Chromium is also a managed flavor. Old configs " +
          "keep working: when chrome.manage is unset, this value is used.",
      },
      {
        key: "headless",
        type: "boolean",
        default: false,
        summary: "Launch Chrome with no UI.",
      },
      // NOTE: `chrome.buildExtension` and `chrome.autoCapture` were removed here
      // (owner, 2026-07-17) — both had long been parsed-and-ignored (the DevTools
      // extension is deleted; page-side getDisplayMedia capture is gone). A config
      // still carrying either is tolerated and dropped by validation, not a hard
      // error — see DEPRECATED_FIELDS in util/config.ts.
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

/** True when the field holds a list of strings rather than a scalar. */
export function isArrayField(field: ConfigFieldSchema): boolean {
  return field.type === "string[]";
}

/**
 * The `typeof` a scalar field's values (enums are strings). Array fields have no
 * single `typeof`, so callers must guard with {@link isArrayField} first.
 */
export function fieldRuntimeType(field: ConfigFieldSchema): "boolean" | "number" | "string" {
  if (field.type === "boolean" || field.type === "number") {
    return field.type;
  }
  return "string"; // "string", "enum" — and, when guarded away, "string[]"
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
  if (isArrayField(field)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: 'expected a JSON array of strings, e.g. ["--foo", "--bar"]' };
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return { error: 'expected a JSON array of strings, e.g. ["--foo", "--bar"]' };
    }
    const list = parsed as string[];
    const reason = invalidReason(field, list);
    return reason ? { error: reason } : { value: list };
  }
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

/** Render a value the way config.json would hold it (strings quoted, arrays as JSON). */
export function formatConfigValue(value: ConfigValue): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
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
