import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { findExecutable } from "./agents.ts";
import { loadConfig, namedTarget, updateConfig } from "./config.ts";
import { browserExecutable, family, installations, installBrowser } from "./installations.ts";
import {
  type BrowserFamily,
  type BrowserSpec,
  type ExtensionSpec,
  endpoint,
  name,
  type Paths,
  type Profile,
  port,
} from "./model.ts";
import {
  createEndpointProfile,
  createProfile,
  editProfile,
  inspectProfiles,
  namedProfileDir,
  portAvailable,
  readProfile,
} from "./profiles.ts";
import { projectFiles, writeProject } from "./project.ts";
import { locked } from "./storage.ts";
import { type Prompts, requireTerminal, terminal } from "./ui.ts";

export async function chooseBrowser(p: Paths, ui = terminal): Promise<BrowserFamily> {
  requireTerminal(ui);
  const installed = await installations(p);
  return ui.choose(
    "Browser to install/use",
    (["chromium", "chrome-for-testing"] as const).map((value) => ({
      value,
      label: `${value === "chromium" ? "Chromium — snapshot builds" : "Chrome for Testing — stable releases"}${installed.some((b) => b.family === value && b.available) ? " (installed)" : " (not installed)"}`,
    })),
  );
}

export async function installWithFeedback(
  p: Paths,
  browser: BrowserFamily,
  build?: string,
  ui = terminal,
): Promise<string> {
  ui.note(
    `Installing ${browser}${build ? ` ${build}` : " (latest supported build)"}; this can take a few minutes…`,
  );
  const executable = await installBrowser(p, browser, build);
  ui.note(`Ready: ${executable}`);
  return executable;
}

/** Temporary mode selects only an already installed executable, without starting it. */
export async function temporaryBrowser(
  p: Paths,
  options: { browser?: string; executable?: string },
  ui = terminal,
): Promise<string> {
  if (options.browser && options.executable)
    throw new Error("Choose --browser or --executable, not both");
  if (options.executable) return findExecutable(options.executable);
  if (options.browser) return browserExecutable(p, { managed: family(options.browser) });
  const available: Array<{ value: string; label: string }> = [];
  for (const managed of ["chromium", "chrome-for-testing"] as const) {
    try {
      available.push({ value: await browserExecutable(p, { managed }), label: managed });
    } catch {
      /* Report/offer only usable selected installations. */
    }
  }
  if (!available.length)
    throw new Error(
      "No usable managed browser installed. Run aibr browser install, or specify --executable <path>",
    );
  if (available.length === 1) return available[0].value;
  if (!ui.interactive)
    throw new Error(
      "Multiple browser families installed; specify --browser chromium|cft or --executable <path>",
    );
  return ui.choose("Browser for temporary session", available);
}

export interface SetupOptions {
  browser?: string;
  executable?: string;
  debugPort?: number;
  headless?: boolean;
  media?: "development" | "standard";
  extension?: string[];
  chromeArg?: string[];
  clearExtensions?: boolean;
  clearChromeArgs?: boolean;
  userDataDir?: string;
  yes?: boolean;
  useHere?: string | boolean;
  format?: string;
  default?: boolean;
  remote?: boolean;
  endpoint?: string;
  host?: string;
  port?: number;
}

export function endpointInput(input: string, suppliedPort?: number): string {
  input = input.trim();
  if (/^\d+$/.test(input)) return endpoint(`http://localhost:${port(input)}`);
  if (input.includes("://")) {
    if (suppliedPort !== undefined)
      throw new Error("Supply an endpoint URL or hostname and port, not both");
    return endpoint(input);
  }
  const host = isIP(input) === 6 ? `[${input}]` : input;
  const url = new URL(`http://${host}`);
  const hasPort = /:\d+$/.test(host) && !host.endsWith("]");
  if (suppliedPort !== undefined && hasPort) throw new Error("Port was supplied twice");
  if (suppliedPort !== undefined) url.port = String(port(suppliedPort));
  else if (!hasPort) url.port = "9222";
  return endpoint(url.toString());
}

async function interviewEndpoint(
  options: SetupOptions,
  current: string | undefined,
  interactive: boolean,
  ui: Prompts,
): Promise<string> {
  if (options.endpoint !== undefined) {
    if (options.host !== undefined || options.port !== undefined)
      throw new Error("Choose --endpoint or --host/--port, not both");
    return endpoint(options.endpoint);
  }
  if (options.host !== undefined || options.port !== undefined) {
    if (current) {
      const url = new URL(current);
      if (options.host !== undefined) {
        const host = options.host;
        url.hostname = isIP(host) === 6 ? `[${host}]` : host;
        if (
          url.hostname !== host &&
          url.hostname !== `[${host}]` &&
          url.hostname !== host.toLowerCase()
        )
          throw new Error(
            "--host must be a hostname or IP address; use --endpoint for a complete URL",
          );
      }
      if (options.port !== undefined) url.port = String(port(options.port));
      return endpoint(url.toString());
    }
    return endpointInput(options.host ?? "localhost", options.port);
  }
  if (!interactive) {
    if (current) return current;
    throw new Error("Supply --endpoint <url> or --host <hostname> --port <port>");
  }
  const address = await ui.text(
    "Endpoint URL, hostname, or localhost port",
    current ?? "localhost",
    (v) => {
      endpointInput(v);
    },
  );
  if (
    address.includes("://") ||
    /^\d+$/.test(address) ||
    new URL(endpointInput(address)).hostname !== address
  )
    return endpointInput(address);
  const number = await ui.text("Endpoint port", "9222", (v) => {
    port(v);
  });
  return endpointInput(address, port(number));
}

async function entries(ui: Prompts, label: string): Promise<string[]> {
  const result: string[] = [];
  while (true) {
    const value = await ui.text(`${label} (blank to finish)`);
    if (!value) return result;
    result.push(value);
  }
}

async function editList<T>(
  ui: Prompts,
  label: string,
  current: T[],
  replacement: () => Promise<T[]>,
): Promise<T[]> {
  ui.note(`${label}: ${current.length ? JSON.stringify(current) : "none"}`);
  const action = await ui.choose(
    label,
    [
      { value: "keep", label: "Keep current values" },
      { value: "replace", label: "Replace values" },
      { value: "clear", label: "Clear all" },
    ],
    "keep",
  );
  return action === "keep" ? current : action === "clear" ? [] : replacement();
}

async function interviewLaunch(
  options: SetupOptions,
  current: Profile["launch"] | undefined,
  interactive: boolean,
  ui: Prompts,
) {
  let debugPort = options.debugPort ?? current?.debugPort;
  let headless = options.headless ?? current?.headless ?? false;
  let mediaPreset = options.media ?? current?.mediaPreset ?? "development";
  let extensions: ExtensionSpec[] = options.clearExtensions
    ? []
    : (options.extension?.map((path) => ({ path: resolve(path) })) ?? current?.extensions ?? []);
  let extraArgs = options.clearChromeArgs ? [] : (options.chromeArg ?? current?.extraArgs ?? []);
  if (options.clearExtensions && options.extension)
    throw new Error("Choose --extension or --clear-extensions");
  if (options.clearChromeArgs && options.chromeArg)
    throw new Error("Choose --chrome-arg or --clear-chrome-args");
  if (interactive) {
    if (options.debugPort === undefined) {
      const answer = await ui.text(
        "Debug port: enter a port number, auto for a free fixed port, or 0 for ephemeral",
        current ? String(current.debugPort) : "auto",
        (v) => {
          if (v !== "auto") port(v, true);
        },
      );
      debugPort = answer === "auto" ? undefined : port(answer, true);
    }
    if (options.headless === undefined)
      headless = await ui.choose(
        "Browser mode",
        [
          { value: false, label: "Not headless" },
          { value: true, label: "Headless" },
        ],
        headless,
      );
    if (options.media === undefined)
      mediaPreset = await ui.choose(
        "Camera, microphone, tab capture and autoplay",
        [
          {
            value: "development",
            label: "Development — automatically allow requests and autoplay",
          },
          { value: "standard", label: "Standard — let the browser ask for permission" },
        ],
        mediaPreset,
      );
    const extensionEntries = async () =>
      (await entries(ui, "Unpacked extension directory")).map((path) => ({ path: resolve(path) }));
    if (options.extension === undefined && !options.clearExtensions)
      extensions = current
        ? await editList(ui, "Extensions", extensions, extensionEntries)
        : await extensionEntries();
    const argumentEntries = () =>
      entries(ui, "Extra Chrome argument, one --flag or --flag=value per entry");
    if (options.chromeArg === undefined && !options.clearChromeArgs)
      extraArgs = current
        ? await editList(ui, "Extra arguments", extraArgs, argumentEntries)
        : await argumentEntries();
  }
  return { debugPort, headless, mediaPreset, extensions, extraArgs };
}

async function projectDirectory(
  options: SetupOptions,
  interactive: boolean,
  ui: Prompts,
): Promise<string | undefined> {
  let directory = options.useHere;
  if (
    directory === undefined &&
    interactive &&
    (await ui.confirm("Use this profile for a project directory?"))
  )
    directory = await ui.text("Project directory", process.cwd());
  if (!directory) return undefined;
  const dir = resolve(typeof directory === "string" ? directory : process.cwd());
  if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const files = await projectFiles(dir);
  if (files.length)
    throw new Error(
      `Project config already exists: ${files.join(", ")}. Edit it to change the target.`,
    );
  if (!["yaml", "yml", "json"].includes(options.format ?? "yaml"))
    throw new Error("Format must be yaml, yml or json");
  return dir;
}

export function rejectRemoteLaunchOptions(options: SetupOptions): void {
  if (
    [
      options.browser,
      options.executable,
      options.debugPort,
      options.headless,
      options.media,
      options.extension,
      options.chromeArg,
      options.userDataDir,
      options.clearExtensions,
      options.clearChromeArgs,
    ].some((v) => v !== undefined)
  )
    throw new Error(
      "Endpoint profiles only store a connection URL; browser and launch settings belong on the browser host",
    );
}

export interface SetupResult {
  name: string;
  dir?: string;
  profile?: Profile;
  endpoint?: string;
  project?: string;
}

/** Shared setup interview, with CLI values prefilled and no browser started. */
export async function setupProfile(
  p: Paths,
  inputName: string | undefined,
  options: SetupOptions,
  adopt = false,
  ui = terminal,
): Promise<SetupResult> {
  const interactive = ui.interactive && !options.yes;
  if (!inputName && !interactive)
    throw new Error("Supply a profile name, or run profile create in an interactive terminal");
  const key = name(
    inputName ??
      (await ui.text("Profile name", "default", (v) => {
        name(v);
      })),
  );
  const config = await loadConfig(p);
  if (Object.hasOwn(config.targets, key))
    throw new Error(`A saved target named ${key} already exists; choose another profile name`);
  const explicitRemote =
    options.remote ||
    options.endpoint !== undefined ||
    options.host !== undefined ||
    options.port !== undefined;
  const hasLocalOptions = [
    options.browser,
    options.executable,
    options.debugPort,
    options.headless,
    options.media,
    options.extension,
    options.chromeArg,
    options.userDataDir,
  ].some((v) => v !== undefined);
  const kind = explicitRemote
    ? "endpoint"
    : adopt || hasLocalOptions || !interactive
      ? "local"
      : await ui.choose(
          "Profile type",
          [
            { value: "local", label: "Local browser — persistent cookies and launch settings" },
            { value: "endpoint", label: "Endpoint — connect to an existing browser" },
          ],
          "local",
        );
  let result: SetupResult;
  if (kind === "endpoint") {
    if (adopt) throw new Error("profile adopt requires a local browser directory");
    rejectRemoteLaunchOptions(options);
    const url = await interviewEndpoint(options, undefined, interactive, ui);
    const projectDir = await projectDirectory(options, interactive, ui);
    await createEndpointProfile(p, key, url);
    result = {
      name: key,
      endpoint: url,
      project: projectDir ? await writeProject(projectDir, key, options.format) : undefined,
    };
  } else {
    if (options.browser && options.executable)
      throw new Error("Choose --browser or --executable, not both");
    let browser: BrowserSpec;
    if (options.executable) browser = { executable: await findExecutable(options.executable) };
    else if (options.browser) browser = { managed: family(options.browser) };
    else if (interactive) {
      const choice = await ui.choose(
        "Browser for this profile",
        [
          { value: "chromium", label: "Chromium — managed snapshot builds" },
          { value: "chrome-for-testing", label: "Chrome for Testing — managed stable releases" },
          { value: "custom", label: "An existing browser executable" },
        ],
        "chromium",
      );
      browser =
        choice === "custom"
          ? { executable: await findExecutable(await ui.text("Browser executable path")) }
          : { managed: family(choice) };
    } else browser = { managed: "chromium" };
    const dataDir =
      options.userDataDir ??
      (interactive
        ? (await ui.text(
            adopt
              ? "Existing user-data directory"
              : "User-data directory (blank for aibr's managed location)",
          )) || undefined
        : undefined);
    if (adopt && !dataDir) throw new Error("profile adopt needs --user-data-dir <path>");
    const launch = await interviewLaunch(options, undefined, interactive, ui);
    const projectDir = await projectDirectory(options, interactive, ui);
    const created = await createProfile(p, key, {
      browser,
      dataDir,
      adopt,
      debugPort: launch.debugPort,
      headless: launch.headless,
      mediaPreset: launch.mediaPreset,
      extensions: launch.extensions.map((e) => ("path" in e ? e.path : "")),
      extraArgs: launch.extraArgs,
    });
    result = {
      name: key,
      ...created,
      project: projectDir ? await writeProject(projectDir, key, options.format) : undefined,
    };
  }
  if (options.default)
    await updateConfig(p, (value) => {
      value.defaultTarget = key;
    });
  return result;
}

/** Edits preserve browser identity, cookies and process lifetime. Reject concurrent changes. */
export async function editProfileSetup(
  p: Paths,
  key: string,
  options: SetupOptions,
  ui = terminal,
): Promise<void> {
  const config = await loadConfig(p);
  const target = namedTarget(config, key);
  const interactive = ui.interactive && !options.yes;
  if ("endpoint" in target) {
    rejectRemoteLaunchOptions(options);
    const url = await interviewEndpoint(options, target.endpoint, interactive, ui);
    await updateConfig(p, (value) => {
      if (
        JSON.stringify(value.targets[key]) !== JSON.stringify(config.targets[key]) ||
        JSON.stringify(namedTarget(value, key)) !== JSON.stringify(target)
      )
        throw new Error("Profile changed during editing; run edit again");
      value.targets[key] = { endpoint: url };
    });
    return;
  }
  if ("provider" in target)
    throw new Error(
      "Provider profiles are configured with aibr target add --provider and aibr provider commands",
    );
  if (options.remote || options.endpoint || options.host || options.port !== undefined)
    throw new Error(
      "A local profile cannot change into an endpoint profile; create another profile",
    );
  if (options.browser || options.executable || options.userDataDir)
    throw new Error(
      "A profile's browser identity and directory cannot change; create another profile",
    );
  const dir = namedProfileDir(p, key, config);
  const original = await readProfile(dir);
  if (interactive)
    ui.note(
      `Editing ${key}\nBrowser: ${"managed" in original.browser ? original.browser.managed : original.browser.executable}\nDirectory: ${dir}\nBrowser identity and directory stay fixed; Enter keeps each current value.`,
    );
  const launch = await interviewLaunch(options, original.launch, interactive, ui);
  await locked(join(p.state, "profiles"), async () => {
    const used = new Set(
      (await inspectProfiles(p, await loadConfig(p))).flatMap((row) =>
        row.profile && row.profile.id !== original.id ? [row.profile.launch.debugPort] : [],
      ),
    );
    let debugPort = launch.debugPort;
    if (debugPort === undefined) {
      debugPort = 9222;
      while (debugPort <= 65535 && (used.has(debugPort) || !(await portAvailable(debugPort))))
        debugPort++;
    }
    if (
      debugPort !== original.launch.debugPort &&
      debugPort !== 0 &&
      (used.has(debugPort) || !(await portAvailable(debugPort)))
    )
      throw new Error(`Port ${debugPort} is already assigned or in use`);
    const savedPort = port(debugPort, true);
    await editProfile(dir, (value) => {
      if (JSON.stringify(value) !== JSON.stringify(original))
        throw new Error("Profile changed during editing; run edit again");
      value.launch = { ...launch, debugPort: savedPort };
    });
  });
}
