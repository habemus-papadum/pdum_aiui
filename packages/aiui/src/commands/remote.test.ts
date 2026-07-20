import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_BROWSER_PORT,
  DEFAULT_REMOTE_CHANNEL_PORT,
  remoteHostLabel,
  remoteInvocation,
  sshRemoteArgs,
} from "./remote";

describe("sshRemoteArgs", () => {
  it("builds one forward-only, fail-loud connection carrying both directions", () => {
    expect(sshRemoteArgs("dev-box", 9222, 61234, 49300)).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      "9222:localhost:61234",
      "-L",
      "49300:localhost:49300",
      "dev-box",
    ]);
  });

  it("keeps the channel forward symmetric (same port both ends)", () => {
    const args = sshRemoteArgs("h", DEFAULT_REMOTE_BROWSER_PORT, 1, DEFAULT_REMOTE_CHANNEL_PORT);
    expect(args).toContain(
      `${DEFAULT_REMOTE_CHANNEL_PORT}:localhost:${DEFAULT_REMOTE_CHANNEL_PORT}`,
    );
  });
});

describe("remoteInvocation", () => {
  it("prints the copy-pasteable remote command", () => {
    expect(remoteInvocation(DEFAULT_REMOTE_BROWSER_PORT)).toBe(
      "aiui claude --aiui-browser-url http://127.0.0.1:9222",
    );
  });
});

describe("remoteHostLabel", () => {
  it("drops the user part, keeps the host as display identity", () => {
    expect(remoteHostLabel("nehal@dev.example.com")).toBe("dev.example.com");
    expect(remoteHostLabel("dev-box")).toBe("dev-box");
  });
});
