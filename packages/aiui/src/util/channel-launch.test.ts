/**
 * channel-launch.test.ts — the two ways a channel starts must agree on `--bind`.
 *
 * `aiui claude` builds the channel's argv and hands it to Claude Code; `aiui mcp
 * serve` runs the same CLI directly. Only the first used to consult config, so a
 * standalone `serve` channel silently bound differently than the user asked.
 * These tests pin the shared bind resolution and the flags it renders. (Sidecars
 * are no longer resolved here — the channel hosts its own standard set.)
 */
import { describe, expect, it } from "vitest";
import {
  applyChannelLaunchArgs,
  type ChannelLaunch,
  channelLaunchFlags,
  isChannelLaunch,
  resolveChannelLaunch,
} from "./channel-launch";

describe("resolveChannelLaunch", () => {
  it("defaults to loopback", () => {
    expect(resolveChannelLaunch({ config: {} }).bind).toBe("loopback");
  });

  it("takes bind from config, and a flag beats config", () => {
    const config = { channel: { bind: "host" as const } };
    expect(resolveChannelLaunch({ config }).bind).toBe("host");
    expect(resolveChannelLaunch({ config, bind: "loopback" }).bind).toBe("loopback");
  });
});

describe("channelLaunchFlags", () => {
  it("renders just the bind pair", () => {
    expect(channelLaunchFlags(resolveChannelLaunch({ config: {} }))).toEqual([
      "--bind",
      "loopback",
    ]);
    expect(channelLaunchFlags({ bind: "host" })).toEqual(["--bind", "host"]);
  });
});

describe("applyChannelLaunchArgs", () => {
  const launch: ChannelLaunch = { bind: "host" };

  it("configures `serve` — the bug: it used to forward verbatim and lose the bind", () => {
    expect(applyChannelLaunchArgs(["serve", "--tag", "t", "--port", "49317"], launch)).toEqual([
      "serve",
      "--tag",
      "t",
      "--port",
      "49317",
      "--bind",
      "host",
    ]);
  });

  it("configures a directly-launched `mcp` stdio server too", () => {
    expect(applyChannelLaunchArgs(["mcp"], launch)).toEqual(["mcp", "--bind", "host"]);
  });

  it("leaves subcommands that talk to someone else's channel verbatim", () => {
    for (const args of [["quick", "--message", "hi"], ["config"], ["--help"], []]) {
      expect(applyChannelLaunchArgs(args, launch)).toEqual(args);
    }
  });

  it("never overrides a bind the caller passed explicitly", () => {
    expect(applyChannelLaunchArgs(["serve", "--bind", "loopback"], launch)).toEqual([
      "serve",
      "--bind",
      "loopback",
    ]);
    // `--x=v` is the same statement as `--x v`, and must suppress ours too —
    // otherwise commander sees the flag twice and last-wins picks ours.
    expect(applyChannelLaunchArgs(["serve", "--bind=loopback"], launch)).toEqual([
      "serve",
      "--bind=loopback",
    ]);
  });

  it("finds the subcommand past leading flags", () => {
    expect(applyChannelLaunchArgs(["--quiet", "serve"], launch)).toContain("--bind");
    expect(applyChannelLaunchArgs(["--quiet", "quick"], launch)).toEqual(["--quiet", "quick"]);
  });
});

describe("isChannelLaunch", () => {
  it("is true exactly for the subcommands that start a channel", () => {
    expect(isChannelLaunch(["serve"])).toBe(true);
    expect(isChannelLaunch(["mcp", "--tag", "t"])).toBe(true);
    expect(isChannelLaunch(["quick", "--message", "hi"])).toBe(false);
    expect(isChannelLaunch(["config"])).toBe(false);
    expect(isChannelLaunch(["--help"])).toBe(false);
    expect(isChannelLaunch([])).toBe(false);
  });
});
