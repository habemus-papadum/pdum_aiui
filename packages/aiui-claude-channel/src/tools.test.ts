import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";
import { createChannelServer } from "./server";
import { collectChannelInfo } from "./tools";

function server(overrides: Partial<RunningServer>): RunningServer {
  return {
    tag: "t",
    pid: 1,
    ppid: 100,
    port: 4000,
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    file: "/x.json",
    ...overrides,
  };
}

describe("collectChannelInfo (list utility)", () => {
  it("merges each entry with its session and drops the on-disk file path", () => {
    const agents = parseClaudeAgents(
      JSON.stringify([
        {
          pid: 100,
          cwd: "/repo",
          kind: "interactive",
          startedAt: 1,
          sessionId: "s-1",
          name: "sess-a",
          status: "idle",
        },
      ]),
    );
    const info = collectChannelInfo(
      [server({ tag: "t1", ppid: 100 }), server({ tag: "t2", ppid: 999 })],
      agents,
    );

    expect(info[0]).toEqual({
      tag: "t1",
      pid: 1,
      ppid: 100,
      port: 4000,
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00.000Z",
      session: {
        sessionId: "s-1",
        name: "sess-a",
        status: "idle",
        kind: "interactive",
        cwd: "/repo",
        startedAt: 1,
      },
    });
    expect(info[1]).not.toHaveProperty("session");
    expect(info[0]).not.toHaveProperty("file");
  });
});

describe("channel_info tool (wired through a real client/server pair)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3");
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    return { mcp, client };
  }

  it("advertises only channel_info and returns this server's own entry", async () => {
    // Write our own registry entry into an isolated cache, as registerServer would.
    // ppid is deliberately absent from any real `claude agents` output, so there's
    // no session to attach and the result is deterministic.
    const cache = mkdtempSync(join(tmpdir(), "aiui-tool-"));
    vi.stubEnv("AIUI_CACHE", cache);
    mkdirSync(join(cache, "mcp"), { recursive: true });
    const entry = {
      tag: "self-tag",
      pid: process.pid,
      ppid: 999_999,
      port: 4321,
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(join(cache, "mcp", `${process.pid}.json`), JSON.stringify(entry));

    const { mcp, client } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["channel_info"]);

      const result = await client.callTool({ name: "channel_info" });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(entry);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("reports unregistered when this process has no registry entry", async () => {
    vi.stubEnv("AIUI_CACHE", mkdtempSync(join(tmpdir(), "aiui-tool-")));
    const { mcp, client } = await connect();
    try {
      const result = await client.callTool({ name: "channel_info" });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({ registered: false, pid: process.pid });
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
