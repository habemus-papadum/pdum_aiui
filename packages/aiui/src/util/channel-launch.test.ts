/**
 * channel-launch.test.ts — the two ways a channel starts must agree.
 *
 * `aiui claude` builds the channel's argv and hands it to Claude Code; `aiui mcp
 * serve` runs the same CLI directly. Only the first used to consult config, so a
 * standalone `serve` channel silently hosted no sidecars — no `/paint/` route,
 * because the channel mounts only what it is handed. These tests pin the shared
 * resolution and the flags it renders.
 */
import { describe, expect, it } from "vitest";
import {
  applyChannelLaunchArgs,
  type ChannelLaunch,
  channelLaunchFlags,
  isChannelLaunch,
  resolveChannelLaunch,
} from "./channel-launch";

const ROOT = "/proj";
// Keep the resolver off the real filesystem/node_modules: the descriptor's
// `module` is only ever an absolute path the channel will import().
const deps = { resolveModule: (specifier: string) => `/abs/${specifier}` };

const names = (launch: ChannelLaunch) => launch.sidecars.map((s) => s.name);

describe("resolveChannelLaunch", () => {
  it("defaults to loopback with the auto-detected sidecars", () => {
    const launch = resolveChannelLaunch({ root: ROOT, config: {} }, deps);
    expect(launch.bind).toBe("loopback");
    expect(names(launch)).toEqual(["paint"]); // paint auto-enables everywhere
  });

  it("takes bind from config, and a flag beats config", () => {
    const config = { channel: { bind: "host" as const } };
    expect(resolveChannelLaunch({ root: ROOT, config }, deps).bind).toBe("host");
    expect(resolveChannelLaunch({ root: ROOT, config, bind: "loopback" }, deps).bind).toBe(
      "loopback",
    );
  });

  it("honors `sidecars.paint: false` — the config knob a standalone channel never used to see", () => {
    const launch = resolveChannelLaunch(
      { root: ROOT, config: { sidecars: { paint: false } } },
      deps,
    );
    expect(names(launch)).toEqual([]);
  });

  it("lets a per-launch flag beat the durable sidecar setting, both ways", () => {
    // config says off, --aiui-sidecar paint turns it back on
    expect(
      names(
        resolveChannelLaunch(
          { root: ROOT, config: { sidecars: { paint: false } }, sidecar: ["paint"] },
          deps,
        ),
      ),
    ).toEqual(["paint"]);
    // config says on, --aiui-no-sidecar paint turns it off
    expect(
      names(
        resolveChannelLaunch(
          { root: ROOT, config: { sidecars: { paint: true } }, noSidecar: ["paint"] },
          deps,
        ),
      ),
    ).toEqual([]);
  });

  it("resolves each sidecar module to an absolute path for the channel to import", () => {
    const launch = resolveChannelLaunch({ root: ROOT, config: {} }, deps);
    expect(launch.sidecars[0]).toMatchObject({
      name: "paint",
      module: "/abs/@habemus-papadum/aiui-paint/sidecar",
      export: "paintSidecar",
      options: { root: ROOT },
    });
  });
});

describe("channelLaunchFlags", () => {
  it("renders bind plus the sidecar descriptors as JSON", () => {
    const launch = resolveChannelLaunch({ root: ROOT, config: {} }, deps);
    const flags = channelLaunchFlags(launch);
    expect(flags.slice(0, 2)).toEqual(["--bind", "loopback"]);
    expect(flags[2]).toBe("--sidecars");
    expect(JSON.parse(flags[3])).toEqual(launch.sidecars);
  });

  it("omits --sidecars entirely when there are none", () => {
    // The channel distinguishes "no descriptors" from "flag never passed" —
    // passing `[]` would be a different statement than passing nothing.
    const launch = resolveChannelLaunch(
      { root: ROOT, config: { sidecars: { paint: false } } },
      deps,
    );
    expect(channelLaunchFlags(launch)).toEqual(["--bind", "loopback"]);
  });
});

describe("applyChannelLaunchArgs", () => {
  const launch: ChannelLaunch = {
    bind: "host",
    sidecars: [{ name: "paint", module: "/abs/paint", export: "paintSidecar", options: {} }],
  };
  const sidecarsJson = JSON.stringify(launch.sidecars);

  it("configures `serve` — the bug: it used to forward verbatim and lose /paint/", () => {
    expect(applyChannelLaunchArgs(["serve", "--tag", "t", "--port", "49317"], launch)).toEqual([
      "serve",
      "--tag",
      "t",
      "--port",
      "49317",
      "--bind",
      "host",
      "--sidecars",
      sidecarsJson,
    ]);
  });

  it("configures a directly-launched `mcp` stdio server too", () => {
    expect(applyChannelLaunchArgs(["mcp"], launch)).toEqual([
      "mcp",
      "--bind",
      "host",
      "--sidecars",
      sidecarsJson,
    ]);
  });

  it("leaves subcommands that talk to someone else's channel verbatim", () => {
    for (const args of [["quick", "--message", "hi"], ["config"], ["--help"], []]) {
      expect(applyChannelLaunchArgs(args, launch)).toEqual(args);
    }
  });

  it("never overrides a flag the caller passed explicitly", () => {
    expect(applyChannelLaunchArgs(["serve", "--bind", "loopback"], launch)).toEqual([
      "serve",
      "--bind",
      "loopback",
      "--sidecars",
      sidecarsJson,
    ]);
    // `--x=v` is the same statement as `--x v`, and must suppress ours too —
    // otherwise commander sees the flag twice and last-wins picks ours.
    expect(applyChannelLaunchArgs(["serve", "--bind=loopback"], launch)).toEqual([
      "serve",
      "--bind=loopback",
      "--sidecars",
      sidecarsJson,
    ]);
    expect(applyChannelLaunchArgs(["serve", "--sidecars", "[]"], launch)).toEqual([
      "serve",
      "--sidecars",
      "[]",
      "--bind",
      "host",
    ]);
  });

  it("finds the subcommand past leading flags", () => {
    expect(applyChannelLaunchArgs(["--quiet", "serve"], launch)).toContain("--bind");
    expect(applyChannelLaunchArgs(["--quiet", "quick"], launch)).toEqual(["--quiet", "quick"]);
  });
});

describe("isChannelLaunch", () => {
  // The guard exists so `quick`/`config` never trigger sidecar module
  // resolution (which warns when a sidecar package is missing).
  it("is true exactly for the subcommands that start a channel", () => {
    expect(isChannelLaunch(["serve"])).toBe(true);
    expect(isChannelLaunch(["mcp", "--tag", "t"])).toBe(true);
    expect(isChannelLaunch(["quick", "--message", "hi"])).toBe(false);
    expect(isChannelLaunch(["config"])).toBe(false);
    expect(isChannelLaunch(["--help"])).toBe(false);
    expect(isChannelLaunch([])).toBe(false);
  });
});
