import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeAgents } from "./agents";
import { PageToolDirectory } from "./page-tools";
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

describe("page-tool MCP tools (wired to a directory with a fake page connection)", () => {
  /**
   * A directory holding one page connection whose handlers answer routed calls,
   * plus an MCP client/server pair whose server exposes that directory. Mirrors
   * what the `/tools` websocket would feed and what the agent would drive.
   */
  async function connectWithDirectory(handlers: Record<string, (args: unknown) => unknown> = {}) {
    const pageTools = new PageToolDirectory({ log: () => {}, newId: () => "fixed-id" });
    let clientId = "";
    clientId = pageTools.addConnection((msg) => {
      if (msg.type !== "call") {
        return;
      }
      queueMicrotask(() => {
        const fn = handlers[msg.name];
        pageTools.handleClientMessage(clientId, {
          v: 1,
          type: "result",
          callId: msg.callId,
          ok: true,
          value: fn ? fn(msg.args) : null,
        });
      });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3", { pageTools });
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    return { pageTools, clientId, mcp, client };
  }

  it("advertises the page-tool tools and lists directory entries", async () => {
    const { pageTools, clientId, mcp, client } = await connectWithDirectory();
    pageTools.handleClientMessage(clientId, {
      v: 1,
      type: "register",
      ns: "morpho",
      url: "http://localhost/morpho",
      hash: "h1",
      tools: [{ name: "set-params", description: "set params", inputSchema: { type: "object" } }],
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "channel_info",
        "page_tools_call",
        "page_tools_list",
      ]);

      const result = await client.callTool({ name: "page_tools_list" });
      const content = result.content as Array<{ type: string; text: string }>;
      const listed = JSON.parse(content[0].text);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        clientId,
        ns: "morpho",
        url: "http://localhost/morpho",
        tools: [{ name: "set-params", description: "set params", inputSchema: { type: "object" } }],
      });
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("routes page_tools_call to the page and returns its JSON value", async () => {
    const { pageTools, clientId, mcp, client } = await connectWithDirectory({
      greet: (args) => ({ hi: (args as { name: string }).name }),
    });
    pageTools.handleClientMessage(clientId, {
      v: 1,
      type: "register",
      ns: "morpho",
      hash: "h1",
      tools: [{ name: "greet", description: "greet" }],
    });
    try {
      const result = await client.callTool({
        name: "page_tools_call",
        arguments: { name: "greet", args: { name: "ada" } },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({ hi: "ada" });
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("surfaces a routing error (no page connected) as an isError result", async () => {
    const { mcp, client } = await connectWithDirectory();
    // The fake connection registered no namespaces, so nothing matches.
    try {
      const result = await client.callTool({
        name: "page_tools_call",
        arguments: { name: "nope" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toMatch(/no page tool "nope"/);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("omits the page-tool tools when no directory is supplied", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3");
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["channel_info"]);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

describe("channel_reload tool (wired through a real client/server pair)", () => {
  async function connect(reload?: () => Promise<unknown>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createChannelServer("1.2.3", reload ? { reload: reload as never } : {});
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    return { mcp, client };
  }

  it("is advertised only when a reload handle is supplied", async () => {
    const withReload = await connect(async () => ({
      reloaded: true,
      generation: 1,
      socketsDropped: 0,
    }));
    const without = await connect();
    try {
      expect((await withReload.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
        "channel_info",
        "channel_reload",
      ]);
      expect((await without.client.listTools()).tools.map((t) => t.name)).toEqual(["channel_info"]);
    } finally {
      await Promise.all([withReload.client.close(), without.client.close()]);
      await Promise.all([withReload.mcp.close(), without.mcp.close()]);
    }
  });

  it("drives the reload handle and returns its summary", async () => {
    let calls = 0;
    const { mcp, client } = await connect(async () => {
      calls += 1;
      return { reloaded: true, generation: calls, socketsDropped: 2 };
    });
    try {
      const result = await client.callTool({ name: "channel_reload" });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({
        reloaded: true,
        generation: 1,
        socketsDropped: 2,
      });
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("surfaces a reload failure as an isError result", async () => {
    const { mcp, client } = await connect(async () => {
      throw new Error("fresh code failed to load");
    });
    try {
      const result = await client.callTool({ name: "channel_reload" });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toMatch(/fresh code failed to load/);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
