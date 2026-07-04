import { describe, expect, it } from "vitest";
import { CHANNEL_CONFIG } from "./commands/config";
import { createChannelServer } from "./server";

describe("createChannelServer", () => {
  it("constructs an MCP server without throwing", () => {
    expect(createChannelServer("1.2.3")).toBeTruthy();
  });
});

describe("CHANNEL_CONFIG", () => {
  it("describes a one-way aiui channel", () => {
    expect(CHANNEL_CONFIG).toEqual({
      name: "aiui-claude-channel",
      channel: { source: "aiui", mode: "one-way" },
      server: {},
    });
  });
});
