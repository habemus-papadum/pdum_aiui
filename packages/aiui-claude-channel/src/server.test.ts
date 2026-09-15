import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createChannelServer } from "./server";

describe("createChannelServer", () => {
  it("constructs an MCP server without throwing", () => {
    expect(createChannelServer("1.2.3")).toBeTruthy();
  });

  it("declares a static tools capability — no listChanged, nothing is ever pushed", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3");
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerCapabilities()?.tools).toEqual({});
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
