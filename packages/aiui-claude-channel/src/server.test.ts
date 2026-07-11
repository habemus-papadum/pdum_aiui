import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CHANNEL_CONFIG } from "./commands/config";
import { createChannelServer } from "./server";

describe("createChannelServer", () => {
  it("constructs an MCP server without throwing", () => {
    expect(createChannelServer("1.2.3")).toBeTruthy();
  });

  it("declares the tools listChanged capability", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3");
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("refuses to send list_changed before a transport is connected", async () => {
    // The mcp command only subscribes the directory listener after connect();
    // this pins the failure mode that ordering (plus its try/catch) guards.
    await expect(createChannelServer("1.2.3").sendToolListChanged()).rejects.toThrow(
      /Not connected/,
    );
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
