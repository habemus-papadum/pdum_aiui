import { resolve } from "node:path";
import { Command } from "commander";
import {
  agentName,
  buildAgentPlan,
  defaultAgentArgs,
  execPlan,
  findExecutable,
  mcpEntry,
  requireExecve,
  temporaryMcpEntry,
  validateAgentArgs,
  YOLO_FLAGS,
} from "./agents.ts";
import { browserStatus, openUrl, removeStoppedProfile, stopBrowser } from "./browser.ts";
import {
  loadConfig,
  namedTarget,
  type SelectOptions,
  selectTarget,
  updateConfig,
} from "./config.ts";
import { diagnose, formatDiagnosis, offerSetup } from "./doctor.ts";
import { family, installations, latestBuild } from "./installations.ts";
import { formatInstallations, formatProfiles, profileInventory } from "./inventory.ts";
import {
  type Agent,
  type Config,
  name,
  type Paths,
  parseTarget,
  port,
  redactEndpoint,
  type Selection,
} from "./model.ts";
import {
  editProfile,
  inspectProfiles,
  namedProfileDir,
  profileDir,
  readProfile,
} from "./profiles.ts";
import { writeProject } from "./project.ts";
import { discover } from "./providers.ts";
import {
  chooseBrowser,
  editProfileSetup,
  installWithFeedback,
  setupProfile,
  temporaryBrowser,
} from "./setup.ts";
import { paths } from "./storage.ts";
import { listTargets, resolveTarget } from "./targets.ts";
import { pickProfile, pickTarget, terminal } from "./ui.ts";
import { VERSION } from "./version.ts";

interface SelectionOptions extends Omit<SelectOptions, "profile"> {
  profile?: string | boolean;
  pick?: boolean;
  cwd?: string;
}
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const collect = (value: string, previous: string[] = []) => [...previous, value];

function selectors(command: Command): Command {
  return command
    .option("--profile [name]", "local or endpoint profile; omit its name to choose")
    .option("--user-data-dir <path>", "explicit local user-data directory")
    .option("--target <name>", "saved target or local profile name")
    .option("--endpoint <url>", "HTTP(S) or WS(S) CDP endpoint")
    .option(
      "--connect-port <port>",
      "loopback port on THIS machine (including forwarded ports)",
      (v) => port(v),
    )
    .option(
      "--auto-connect",
      "attach through DevToolsActivePort; requires --profile or --user-data-dir",
    )
    .option("--pick", "interactively select a profile or discovered target")
    .option("--cwd <path>", "working directory for project selection and the agent");
}

async function selection(
  p: Paths,
  config: Config,
  options: SelectionOptions,
  cwd: string,
): Promise<Selection> {
  if (options.pick) {
    if (
      [
        options.profile,
        options.userDataDir,
        options.target,
        options.endpoint,
        options.connectPort,
        options.autoConnect,
      ].some((v) => v !== undefined)
    )
      throw new Error("--pick cannot be combined with another browser selector");
    return pickTarget(p, config);
  }
  if (options.profile === true) {
    // Validate conflicts before opening a chooser.
    await selectTarget(config, { ...options, profile: "picker" }, cwd);
    return selectTarget(config, { ...options, profile: await pickProfile(p, config) }, cwd);
  }
  return selectTarget(
    config,
    { ...options, profile: typeof options.profile === "string" ? options.profile : undefined },
    cwd,
  );
}

async function localDir(
  p: Paths,
  key: string | undefined,
  options: { userDataDir?: string; profile?: string | boolean },
): Promise<string> {
  if ([key, options.profile, options.userDataDir].filter((v) => v !== undefined).length > 1)
    throw new Error("Choose a profile name, --profile or --user-data-dir, not more than one");
  if (options.userDataDir) return resolve(options.userDataDir);
  const config = await loadConfig(p);
  if (key === undefined && options.profile === undefined) {
    const { target } = await selectTarget(config, {});
    if ("profile" in target) return namedProfileDir(p, target.profile, config);
    if ("dataDir" in target) return target.dataDir;
    throw new Error("The selected default is remote; choose a local --profile for this command");
  }
  const selected =
    options.profile === true
      ? await pickProfile(p, config, terminal, true)
      : typeof options.profile === "string"
        ? options.profile
        : (key ?? "default");
  return namedProfileDir(p, selected, config);
}

function nativeSelectionCwd(agent: Agent, args: string[], base: string): string {
  if (agent !== "codex") return base;
  let cwd = base;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === "-C" || args[i] === "--cd") {
      if (!args[i + 1]) throw new Error(`${args[i]} needs a directory`);
      cwd = resolve(base, args[++i]);
    } else if (args[i].startsWith("--cd=")) cwd = resolve(base, args[i].slice(5));
  }
  return cwd;
}

export function createProgram(p: Paths = paths()): Command {
  const program = new Command()
    .name("aibr")
    .version(VERSION)
    .description("Shared persistent browsers, with exec-based Claude Code and Codex launchers")
    .addHelpText(
      "after",
      "\nStart here: aibr doctor\nSet up a project: aibr init --profile\nChoose a browser profile: aibr claude --profile\nList what is available: aibr browser list · aibr profile list\n",
    )
    .enablePositionalOptions();
  program
    .command("init")
    .description(
      "Write a directory's browser selection to .aiui.yaml (or JSON); no browser is started",
    )
    .argument("[directory]", "project directory", ".")
    .option("--profile [name]", "existing profile; omit its name to choose")
    .option("--target <name>", "saved local or remote target instead of a profile")
    .option("--format <format>", "yaml, yml or json", "yaml")
    .action(async (directory: string, options) => {
      if (options.profile !== undefined && options.target !== undefined)
        throw new Error("Choose --profile or --target, not both");
      const config = await loadConfig(p);
      const key =
        options.target ??
        (typeof options.profile === "string" ? options.profile : await pickProfile(p, config));
      const target = namedTarget(config, key);
      if ("profile" in target) await readProfile(namedProfileDir(p, target.profile, config));
      else if ("dataDir" in target) await readProfile(target.dataDir);
      else if ("provider" in target && !Object.hasOwn(config.providers, target.provider))
        throw new Error(`Unknown provider ${target.provider}`);
      console.log(`Created ${await writeProject(directory, key, options.format)} → ${key}`);
    });
  selectors(
    program
      .command("mcp")
      .description(
        "Exec the pinned MCP server against an already-running browser (for global agent config)",
      ),
  ).action(async (options) => {
    requireExecve();
    const config = await loadConfig(p);
    const cwd = resolve(options.cwd ?? process.cwd());
    const selected = await selection(p, config, options, cwd);
    const entry = await mcpEntry(await resolveTarget(p, config, selected.target, false));
    await execPlan({ executable: entry.command, args: entry.args, cwd });
  });
  for (const agent of ["claude", "codex"] as const) {
    selectors(
      program.command(agent).description(`Exec ${agent} with the selected browser MCP server`),
    )
      .option("--dry-run", "print a plan without starting browsers, tunnels or agents")
      .option("--temp", "MCP launches an isolated temporary browser")
      .option("--temp-headless", "MCP launches an isolated headless temporary browser")
      .option("--browser <family>", "temporary mode: installed chromium or cft")
      .option("--executable <path>", "temporary mode: explicit browser executable")
      .option("--headless", "one-launch headless override for a local browser")
      .option("--no-headless", "one-launch not-headless override for a local browser")
      .option("--exclusive-mcp", "Claude only: load only the supplied browser MCP server")
      .option("--no-default-args", "ignore saved agent arguments and saved YOLO setting")
      .option("--yolo", "enable the agent's YOLO flag for this launch")
      .option("--no-yolo", "disable the saved YOLO flag for this launch")
      .argument("[agentArgs...]", "native agent arguments after --")
      .addHelpText(
        "after",
        `\nExample: aibr ${agent} --profile research -- --model <model>\nSaved options: aibr config args ${agent} -- <arguments>\nOne-time YOLO setup: aibr config yolo on\n`,
      )
      .action(async (agentArgs: string[], options) => {
        requireExecve();
        const executable = await findExecutable(agent);
        const cwd = resolve(options.cwd ?? process.cwd());
        if (
          agentArgs.includes("--help") ||
          agentArgs.includes("--version") ||
          agentArgs.includes("-h")
        ) {
          await execPlan({ executable, args: agentArgs, cwd });
          return;
        }
        if (agent === "codex" && options.exclusiveMcp)
          throw new Error("--exclusive-mcp is a Claude Code option");
        const config = await loadConfig(p);
        const defaults = defaultAgentArgs(config, agent, options);
        validateAgentArgs(agent, defaults, config.serverName);
        validateAgentArgs(agent, agentArgs, config.serverName);
        const temporary = options.temp || options.tempHeadless;
        if (temporary) {
          if (options.temp && options.tempHeadless)
            throw new Error("Choose --temp or --temp-headless, not both");
          if (
            [
              options.profile,
              options.target,
              options.userDataDir,
              options.endpoint,
              options.connectPort,
              options.autoConnect,
              options.pick,
            ].some((v) => v !== undefined)
          )
            throw new Error(
              "Temporary mode cannot be combined with --profile or another browser selector",
            );
          if (options.tempHeadless && options.headless === false)
            throw new Error("--temp-headless conflicts with --no-headless");
          const headless = options.tempHeadless || options.headless === true;
          const browser = await temporaryBrowser(p, options);
          const entry = await temporaryMcpEntry(browser, headless);
          const plan = buildAgentPlan(agent, executable, entry, config, agentArgs, {
            ...options,
            cwd,
          });
          if (options.dryRun)
            json({
              selection: {
                mode: "temporary",
                executable: browser,
                headless,
                lifecycle: "MCP-owned",
              },
              plan: redactPlan(plan),
            });
          else {
            process.stderr.write(
              `aibr: temporary ${headless ? "headless" : "not headless"} browser; MCP owns startup and cleanup\n`,
            );
            await execPlan(plan);
          }
          return;
        }
        if (options.browser || options.executable)
          throw new Error(
            "--browser and --executable require --temp or --temp-headless; persistent profiles save their browser identity",
          );
        const selected = await selection(
          p,
          config,
          options,
          nativeSelectionCwd(agent, [...defaults, ...agentArgs], cwd),
        );
        const connection = await resolveTarget(p, config, selected.target, !options.dryRun, {
          headless: options.headless,
        });
        const plan = buildAgentPlan(
          agent,
          executable,
          await mcpEntry(connection),
          config,
          agentArgs,
          { ...options, cwd },
        );
        if (options.dryRun) {
          json({
            selection: selected,
            connection: redactConnection(connection),
            plan: redactPlan(plan),
          });
          return;
        }
        process.stderr.write(
          `aibr: ${selected.label} (${selected.source}) → ${redactEndpoint(connection.endpoint)}\n`,
        );
        await execPlan(plan);
      });
  }
  selectors(
    program
      .command("explain")
      .description("Show selection and launch configuration without starting anything")
      .argument("[agent]", "claude or codex", "codex"),
  ).action(async (agentInput: string, options) => {
    const agent = agentName(agentInput);
    const config = await loadConfig(p);
    const cwd = resolve(options.cwd ?? process.cwd());
    const selected = await selection(p, config, options, cwd);
    let readiness: unknown;
    let plan: unknown;
    try {
      const connection = await resolveTarget(p, config, selected.target, false);
      readiness = redactConnection(connection);
      plan = redactPlan(
        buildAgentPlan(agent, await findExecutable(agent), await mcpEntry(connection), config, [], {
          cwd,
        }),
      );
    } catch (error) {
      readiness = { error: error instanceof Error ? error.message : String(error) };
    }
    json({ paths: p, selection: selected, agentDefaults: config.agents[agent], readiness, plan });
  });
  selectors(
    program.command("open").argument("<url>").description("Open a tab in the selected browser"),
  ).action(async (url: string, options) => {
    const config = await loadConfig(p);
    const selected = await selection(p, config, options, resolve(options.cwd ?? process.cwd()));
    await openUrl(await resolveTarget(p, config, selected.target), url);
  });
  program
    .command("status")
    .description("List known browser targets and managed installations")
    .option("--discover", "also query discovery providers")
    .option("--json", "machine-readable output")
    .action(async (options) => {
      const targets = await listTargets(p, await loadConfig(p), options.discover);
      const installed = await installations(p);
      if (options.json) json({ targets, installations: installed });
      else {
        for (const row of targets) console.log(`${row.label}\t${row.status}\t${row.detail ?? ""}`);
        for (const item of installed)
          console.log(`${item.family}\t${item.buildId}\t${item.executable}`);
        if (!targets.length)
          console.log(
            "No profiles yet. Run: aibr browser install chromium && aibr profile create default",
          );
      }
    });

  const browser = program
    .command("browser")
    .description("Manage independent browser processes and installations");
  browser
    .command("list")
    .description("List downloaded builds, selected versions and executable paths (no network)")
    .option("--json", "machine-readable inventory")
    .action(async (options) => {
      const rows = await installations(p);
      if (options.json) json(rows);
      else console.log(formatInstallations(rows));
    });
  for (const action of ["install", "update"] as const)
    browser
      .command(action)
      .description(
        action === "install"
          ? "Download and select a browser; choose a family if omitted"
          : "Download and select a newer build; existing browsers keep running",
      )
      .argument("[family]", "chromium or chrome-for-testing (cft); omit to choose")
      .option("--build <id>", "specific build instead of latest")
      .action(async (value: string | undefined, options) => {
        const selected = value ? family(value) : await chooseBrowser(p);
        console.log(await installWithFeedback(p, selected, options.build));
      });
  browser
    .command("check")
    .argument("[family]")
    .description("Check for updates without installing them")
    .action(async (value?: string) => {
      const installed = await installations(p);
      const families = value ? [family(value)] : (["chromium", "chrome-for-testing"] as const);
      for (const item of families)
        json({
          family: item,
          latest: await latestBuild(item),
          installed: installed.filter((b) => b.family === item),
        });
    });
  browser
    .command("start")
    .description("Start or reuse a profile's independent browser; it survives agent exit")
    .argument("[profile]")
    .option("--profile [name]", "profile name; omit its value to choose")
    .option("--user-data-dir <path>")
    .option("--headless", "one-launch headless override; do not change the saved profile")
    .option("--no-headless", "one-launch not-headless override; do not change the saved profile")
    .action(async (key: string | undefined, options) =>
      json(
        await resolveTarget(
          p,
          await loadConfig(p),
          { dataDir: await localDir(p, key, options) },
          true,
          { headless: options.headless },
        ),
      ),
    );
  browser
    .command("stop")
    .argument("[profile]")
    .option("--profile [name]", "profile name; omit its value to choose")
    .option("--user-data-dir <path>")
    .description("Explicitly close this profile's browser for all users and agents")
    .action(async (key: string | undefined, options) =>
      stopBrowser(p, await localDir(p, key, options)),
    );
  browser
    .command("status")
    .description("Inspect one profile's browser process and endpoint without starting it")
    .argument("[profile]")
    .option("--profile [name]", "profile name; omit its value to choose")
    .option("--user-data-dir <path>")
    .action(async (key: string | undefined, options) =>
      json(await browserStatus(p, await localDir(p, key, options))),
    );

  const profile = program
    .command("profile")
    .description("Manage local browser settings and endpoint profiles");
  for (const action of ["create", "adopt"] as const) {
    profile
      .command(action)
      .description(
        action === "create"
          ? "Create a persistent profile with guided settings in a terminal"
          : "Associate an existing data directory with a browser, keeping its cookies",
      )
      .argument("[name]", "profile name; prompted if omitted")
      .option("--browser <family>", "chromium or chrome-for-testing (cft)")
      .option("--executable <path>", "existing browser executable instead of a managed build")
      .option("--user-data-dir <path>", "external directory; required when adopting")
      .option("--remote", "create an endpoint profile; prompt for its connection URL")
      .option("--endpoint <url>", "create an endpoint profile using this URL")
      .option("--host <hostname>", "endpoint hostname (default: localhost with --port)")
      .option("--port <port>", "endpoint port; saved as part of its URL", (v) => port(v))
      .option("--debug-port <port>", "saved port; default: free fixed port; 0: ephemeral", (v) =>
        port(v, true),
      )
      .option("--headless", "hide the browser window")
      .option("--no-headless", "show the browser window")
      .option("--media <preset>", "development: auto-allow media; standard: browser prompts")
      .option("--extension <path>", "unpacked extension directory (repeatable)", collect)
      .option(
        "--chrome-arg <argument>",
        "extra Chrome argument (repeatable; use --chrome-arg=--flag)",
        collect,
      )
      .option("--yes", "use defaults for unspecified settings without prompting")
      .option(
        "--use-here [directory]",
        "also write a project config here or in the supplied directory",
      )
      .option("--format <format>", "project config format: yaml, yml or json", "yaml")
      .option("--default", "also save this profile as the user default")
      .option("--json", "print the created profile as JSON; implies --yes")
      .action(async (key: string | undefined, options) => {
        const result = await setupProfile(
          p,
          key,
          { ...options, yes: options.yes || options.json },
          action === "adopt",
        );
        if (options.json) json(result);
        else {
          console.log(`Created profile ${result.name}`);
          console.log(
            formatProfiles(
              (await profileInventory(p, await loadConfig(p))).filter(
                (row) => row.name === result.name,
              ),
            ),
          );
          if (result.project) console.log(`Directory config: ${result.project}`);
          console.log(
            result.endpoint
              ? `Connect: aibr claude --profile ${result.name}`
              : `Start it: aibr browser start ${result.name}`,
          );
        }
      });
  }
  profile
    .command("list")
    .description("List all profiles, paths, launch settings and browser status")
    .option("--json", "machine-readable inventory")
    .action(async (options) => {
      const config = await loadConfig(p);
      const rows = await profileInventory(p, config);
      if (options.json) json(rows);
      else console.log(formatProfiles(rows, config.defaultTarget));
    });
  profile
    .command("show")
    .description("Show a readable profile summary, including saved settings and running mode")
    .argument("[name]")
    .option("--profile [name]", "profile name; omit its value to choose")
    .option("--user-data-dir <path>")
    .option("--json", "print raw local metadata or the saved endpoint/provider reference")
    .action(async (key: string | undefined, options) => {
      const config = await loadConfig(p);
      if (options.userDataDir) {
        const dir = await localDir(p, key, options);
        const value = await readProfile(dir);
        if (options.json) json(value);
        else
          console.log(
            formatProfiles(
              await profileInventory(p, {
                ...config,
                targets: { [value.name]: { dataDir: dir } },
              }).then((rows) => rows.filter((r) => r.name === value.name)),
            ),
          );
        return;
      }
      if (key && options.profile !== undefined)
        throw new Error("Choose a name or --profile, not both");
      const selected = await selection(
        p,
        config,
        { profile: key ?? options.profile },
        process.cwd(),
      );
      const row = (await inspectProfiles(p, config)).find((r) => r.name === selected.label);
      if (!row) throw new Error(`Unknown profile ${selected.label}`);
      if (options.json) json(row.profile ?? { name: row.name, ...row.target });
      else
        console.log(
          formatProfiles(
            (await profileInventory(p, config)).filter((r) => r.name === row.name),
            config.defaultTarget,
          ),
        );
    });
  profile
    .command("edit")
    .description(
      "Edit a local or endpoint profile with current values prefilled; omit name to choose",
    )
    .argument("[name]")
    .option("--profile [name]", "profile to edit; omit its value to choose")
    .option("--debug-port <port>", "saved debugging port for a local profile", (v) => port(v, true))
    .option("--headless", "save headless mode")
    .option("--no-headless", "save not-headless mode")
    .option("--media <preset>", "development or standard")
    .option("--extension <path>", "replace extensions (repeatable)", collect)
    .option("--clear-extensions", "clear all extensions")
    .option("--chrome-arg <argument>", "replace extra arguments (repeatable)", collect)
    .option("--clear-chrome-args", "clear all extra arguments")
    .option("--endpoint <url>", "replace an endpoint profile's URL")
    .option("--host <hostname>", "replace an endpoint hostname")
    .option("--port <port>", "endpoint port", (v) => port(v))
    .option("--yes", "apply supplied flags only; keep other values without prompts")
    .option("--json", "machine-readable result; implies --yes")
    .action(async (key: string | undefined, options) => {
      if (key && options.profile !== undefined)
        throw new Error("Choose a name or --profile, not both");
      const config = await loadConfig(p);
      const selected =
        key ??
        (typeof options.profile === "string" ? options.profile : await pickProfile(p, config));
      await editProfileSetup(p, selected, { ...options, yes: options.yes || options.json });
      const rows = (await profileInventory(p, await loadConfig(p))).filter(
        (r) => r.name === selected,
      );
      if (options.json) json(rows[0]);
      else console.log(formatProfiles(rows, config.defaultTarget));
    });
  profile
    .command("set")
    .description("Change saved launch settings; a running browser needs an explicit restart")
    .argument("[name]")
    .option("--profile [name]", "profile name; omit its value to choose")
    .option("--user-data-dir <path>")
    .option("--debug-port <port>", "saved debug port", (v) => port(v, true))
    .option("--headless")
    .option("--no-headless")
    .option("--media <preset>", "development or standard")
    .option("--extension <path>", "replace extensions", collect)
    .option("--clear-extensions")
    .option("--chrome-arg <argument>", "replace extra arguments (use --chrome-arg=--flag)", collect)
    .action(async (key: string | undefined, options) =>
      json(
        await editProfile(await localDir(p, key, options), (value) => {
          if (options.debugPort !== undefined) value.launch.debugPort = options.debugPort;
          if (options.headless !== undefined) value.launch.headless = options.headless;
          if (options.media !== undefined) value.launch.mediaPreset = options.media;
          if (options.clearExtensions) value.launch.extensions = [];
          if (options.extension)
            value.launch.extensions = options.extension.map((path: string) => ({
              path: resolve(path),
            }));
          if (options.chromeArg) value.launch.extraArgs = options.chromeArg;
        }),
      ),
    );
  profile
    .command("remove")
    .description("Delete stopped managed data, or forget an endpoint/external profile reference")
    .argument("<name>")
    .requiredOption("--yes", "permanently remove this stopped profile, including cookies")
    .action(async (key: string) => {
      if (Object.hasOwn((await loadConfig(p)).targets, name(key))) {
        await updateConfig(p, (value) => {
          delete value.targets[key];
        });
        console.log(`Removed saved profile ${key}; browser data and processes were kept`);
      } else await removeStoppedProfile(p, profileDir(p, key));
    });

  const target = program
    .command("target")
    .description("Save named local or remote browser targets");
  target
    .command("add")
    .description("Save or replace a named endpoint, profile or provider reference")
    .argument("<name>")
    .option("--profile [name]", "saved profile; omit its name to choose")
    .option("--endpoint <url>")
    .option("--user-data-dir <path>")
    .option("--provider <name>")
    .option("--id <id>")
    .action(async (key: string, options) => {
      if (
        [options.profile, options.endpoint, options.userDataDir, options.provider].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        throw new Error("Choose exactly one target source");
      if (options.profile === true) options.profile = await pickProfile(p, await loadConfig(p));
      const raw = options.profile
        ? { profile: options.profile }
        : options.endpoint
          ? { endpoint: options.endpoint }
          : options.userDataDir
            ? { dataDir: resolve(options.userDataDir) }
            : { provider: options.provider, id: options.id };
      await updateConfig(p, (config) => {
        config.targets[name(key)] = parseTarget(raw);
      });
    });
  target
    .command("remove")
    .description("Forget a saved target without deleting its browser data")
    .argument("<name>")
    .action(async (key: string) =>
      updateConfig(p, (config) => {
        delete config.targets[name(key)];
      }),
    );
  target
    .command("list")
    .description("List local and saved targets; optionally discover provider targets")
    .option("--discover")
    .action(async (options) => json(await listTargets(p, await loadConfig(p), options.discover)));

  const provider = program
    .command("provider")
    .description("Configure external discovery and tunnel adapters");
  provider
    .command("add")
    .description("Register a discovery/tunnel command with literal arguments (no shell)")
    .argument("<name>")
    .requiredOption("--command <executable>")
    .option("--cwd <path>")
    .argument("[args...]", "provider arguments after --")
    .action(async (key: string, args: string[], options) => {
      const command = await findExecutable(options.command);
      await updateConfig(p, (config) => {
        config.providers[name(key)] = {
          command,
          args,
          cwd: options.cwd ? resolve(options.cwd) : undefined,
        };
      });
    });
  provider
    .command("remove")
    .description("Forget a provider without stopping its tunnels")
    .argument("<name>")
    .action(async (key: string) =>
      updateConfig(p, (config) => {
        delete config.providers[name(key)];
      }),
    );
  provider
    .command("list")
    .description("Show configured provider commands and arguments")
    .action(async () => json((await loadConfig(p)).providers));
  provider
    .command("discover")
    .description("Ask a provider for available browsers; do not create a tunnel")
    .argument("<name>")
    .action(async (key: string) => {
      const config = await loadConfig(p);
      if (!Object.hasOwn(config.providers, name(key))) throw new Error(`Unknown provider ${key}`);
      json(await discover(config.providers[key]));
    });

  const config = program
    .command("config")
    .description("One-time user configuration; never changes the agents' own config files");
  config
    .command("show")
    .description("Print user defaults, saved targets and provider definitions")
    .action(async () => json({ path: p.config, ...(await loadConfig(p)) }));
  config
    .command("default")
    .description("Save the target used when no explicit selector or project config applies")
    .argument("<target>")
    .action(async (key: string) =>
      updateConfig(p, (value) => {
        value.defaultTarget = name(key);
      }),
    );
  config
    .command("server-name")
    .argument("<name>")
    .description("Match your existing global browser MCP server name")
    .action(async (key: string) =>
      updateConfig(p, (value) => {
        value.serverName = name(key);
      }),
    );
  config
    .command("args")
    .description("Replace saved native arguments for an agent; omit arguments to clear")
    .argument("<agent>")
    .argument("[args...]", "replace saved native arguments; use -- before them")
    .action(async (input: string, args: string[]) => {
      const agent = agentName(input);
      await updateConfig(p, (value) => {
        validateAgentArgs(agent, args, value.serverName);
        value.agents[agent].args = args;
      });
      console.log(`Saved ${agent} default arguments`);
    });
  config
    .command("yolo")
    .argument("[mode]", "on or off", "on")
    .option("--agent <agent>", "claude, codex, or both", "both")
    .description("Persist permission bypass defaults for future aibr launches")
    .action(async (mode: string, options) => {
      if (!["on", "off"].includes(mode)) throw new Error("YOLO mode must be on or off");
      const agents: Agent[] =
        options.agent === "both" ? ["claude", "codex"] : [agentName(options.agent)];
      await updateConfig(p, (value) => {
        for (const agent of agents) {
          value.agents[agent].yolo = mode === "on";
          if (mode === "off")
            value.agents[agent].args = value.agents[agent].args.filter(
              (arg) => arg !== YOLO_FLAGS[agent],
            );
        }
      });
      for (const agent of agents)
        console.log(`${agent}: YOLO ${mode}${mode === "on" ? ` (${YOLO_FLAGS[agent]})` : ""}`);
    });
  program
    .command("doctor")
    .description("Inspect browsers, profiles, tools and defaults; offer setup in a terminal")
    .option("--json", "machine-readable report; never prompt or change anything")
    .option("--no-prompt", "report only; never install or create anything")
    .option("--cwd <path>", "directory whose project selection to diagnose")
    .action(async (options) => {
      const cwd = resolve(options.cwd ?? process.cwd());
      const report = await diagnose(p, cwd);
      if (options.json) json(report);
      else {
        console.log(formatDiagnosis(report));
        if (options.prompt !== false && terminal.interactive && (await offerSetup(p)))
          console.log(`\nAfter setup:\n${formatDiagnosis(await diagnose(p, cwd))}`);
      }
    });
  return program;
}

function redactConnection<T extends { endpoint: string; wsEndpoint: string }>(connection: T): T {
  return {
    ...connection,
    endpoint: redactEndpoint(connection.endpoint),
    wsEndpoint: redactEndpoint(connection.wsEndpoint),
  };
}
function redactPlan<T extends { args: string[] }>(plan: T): T {
  return {
    ...plan,
    args: plan.args.map((arg) =>
      arg.replace(/wss?:\/\/[^\s"\\]+\?[^\s"\\]+/g, (url) => redactEndpoint(url)),
    ),
  };
}
export async function runCli(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}
