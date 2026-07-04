import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_PORT,
  remoteAttachCommand,
  sanitizeHostKey,
  sshTunnelArgs,
  tunnelProfileDir,
} from "./browser";

let prevCache: string | undefined;

beforeEach(() => {
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = "/user-cache";
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
});

describe("sshTunnelArgs", () => {
  it("builds a forward-only, fail-loud reverse tunnel", () => {
    expect(sshTunnelArgs("dev-box", 9222, 61234)).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      "9222:localhost:61234",
      "dev-box",
    ]);
  });
});

describe("sanitizeHostKey", () => {
  it("drops the user part and keeps hostnames readable", () => {
    expect(sanitizeHostKey("nehal@dev.example.com")).toBe("dev.example.com");
    expect(sanitizeHostKey("dev-box")).toBe("dev-box");
  });

  it("makes odd targets filesystem-safe", () => {
    expect(sanitizeHostKey("user@[fe80::1]")).toBe("-fe80--1-");
    expect(sanitizeHostKey("@")).toBe("remote");
  });
});

describe("tunnelProfileDir", () => {
  it("keys the user-cache profile by host, or by an explicit profile name", () => {
    expect(tunnelProfileDir("nehal@dev-box")).toBe(
      join("/user-cache", "browser-profiles", "dev-box"),
    );
    expect(tunnelProfileDir("nehal@dev-box", "work")).toBe(
      join("/user-cache", "browser-profiles", "work"),
    );
  });
});

describe("remoteAttachCommand", () => {
  it("prints the copy-pasteable remote invocation", () => {
    expect(remoteAttachCommand(DEFAULT_REMOTE_PORT)).toBe(
      "aiui claude --aiui-browser-url http://127.0.0.1:9222",
    );
  });
});
