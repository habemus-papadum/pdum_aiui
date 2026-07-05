import { describe, expect, it } from "vitest";
import { PageToolDirectory, type ServerToClientMessage } from "./page-tools";

/** Fixed-clock, sequential-id directory with a captured change log — deterministic. */
function makeDirectory() {
  const log: string[] = [];
  let n = 0;
  const dir = new PageToolDirectory({
    log: (line) => log.push(line),
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    newId: () => `id-${++n}`,
  });
  return { dir, log };
}

/**
 * Attach a page connection whose named handlers answer the calls the directory
 * routes to it (mirroring what the browser bridge does). A handler returning the
 * `NO_REPLY` sentinel simulates a page that never answers (for timeout tests).
 */
const NO_REPLY = Symbol("no-reply");
function connectPage(
  dir: PageToolDirectory,
  handlers: Record<string, (args: unknown) => unknown> = {},
) {
  let clientId = "";
  const sent: ServerToClientMessage[] = [];
  clientId = dir.addConnection((msg) => {
    sent.push(msg);
    if (msg.type !== "call") {
      return;
    }
    queueMicrotask(() => {
      const fn = handlers[msg.name];
      try {
        const value = fn ? fn(msg.args) : null;
        if (value === NO_REPLY) {
          return;
        }
        dir.handleClientMessage(clientId, {
          v: 1,
          type: "result",
          callId: msg.callId,
          ok: true,
          value,
        });
      } catch (err) {
        dir.handleClientMessage(clientId, {
          v: 1,
          type: "result",
          callId: msg.callId,
          ok: false,
          error: (err as Error).message,
        });
      }
    });
  });
  const register = (
    ns: string,
    tools: unknown[],
    hash = "h1",
    extra: Record<string, unknown> = {},
  ) => dir.handleClientMessage(clientId, { v: 1, type: "register", ns, hash, tools, ...extra });
  return { clientId, sent, register };
}

describe("PageToolDirectory registration", () => {
  it("records a namespace, lists it, and acks the client", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register(
      "morpho",
      [{ name: "set-params", description: "set params", inputSchema: { type: "object" } }],
      "h1",
      { url: "http://localhost/morpho", tab: { title: "morpho" }, source: { root: "/repo" } },
    );

    expect(dir.list()).toEqual([
      {
        clientId: page.clientId,
        ns: "morpho",
        url: "http://localhost/morpho",
        tab: { title: "morpho" },
        source: { root: "/repo" },
        hash: "h1",
        tools: [{ name: "set-params", description: "set params", inputSchema: { type: "object" } }],
        registeredAt: "2026-07-05T00:00:00.000Z",
      },
    ]);
    expect(page.sent).toContainEqual({ v: 1, type: "registered", ns: "morpho", hash: "h1" });
    expect(dir.summary()).toEqual({ clients: 1, namespaces: 1, tools: 1 });
  });

  it("logs only when the tool-set hash changes (reloads are silent)", () => {
    const { dir, log } = makeDirectory();
    const page = connectPage(dir);
    const tools = [{ name: "a", description: "d" }];
    page.register("morpho", tools, "h1");
    page.register("morpho", tools, "h1"); // same hash: an HMR/reload re-register
    page.register("morpho", tools, "h2"); // changed set

    expect(log).toHaveLength(2);
    expect(log[0]).toContain("h1");
    expect(log[1]).toContain("h2");
  });

  it("replaces a namespace's set on re-registration", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1");
    page.register("morpho", [{ name: "b", description: "e" }], "h2");
    const entries = dir.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].tools.map((t) => t.name)).toEqual(["b"]);
  });
});

describe("PageToolDirectory.call routing", () => {
  it("round-trips a value to the matching page and back", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir, { greet: (args) => ({ hi: (args as { name: string }).name }) });
    page.register("morpho", [{ name: "greet", description: "greet" }]);

    await expect(dir.call({ name: "greet", args: { name: "ada" } })).resolves.toEqual({
      hi: "ada",
    });
  });

  it("rejects with the page's error message", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir, {
      boom: () => {
        throw new Error("kaboom");
      },
    });
    page.register("morpho", [{ name: "boom", description: "explode" }]);

    await expect(dir.call({ name: "boom" })).rejects.toThrow("kaboom");
  });

  it("times out when the page never answers", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir, { hang: () => NO_REPLY });
    page.register("morpho", [{ name: "hang", description: "never returns" }]);

    await expect(dir.call({ name: "hang", timeoutMs: 30 })).rejects.toThrow(/timed out after 30ms/);
  });

  it("rejects in-flight calls when the page disconnects", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir, { hang: () => NO_REPLY });
    page.register("morpho", [{ name: "hang", description: "never returns" }]);

    const pending = dir.call({ name: "hang", timeoutMs: 1000 });
    dir.removeConnection(page.clientId);
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  it("errors clearly when no page is connected", async () => {
    const { dir } = makeDirectory();
    await expect(dir.call({ name: "greet" })).rejects.toThrow(/no page connected/);
  });

  it("errors when a page exists but no tool matches", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "greet", description: "greet" }]);
    await expect(dir.call({ name: "missing" })).rejects.toThrow(/no page tool "missing"/);
  });

  it("reports ambiguity across pages and disambiguates by ns", async () => {
    const { dir } = makeDirectory();
    const a = connectPage(dir, { report: () => "morpho-report" });
    a.register("morpho", [{ name: "report", description: "snapshot" }]);
    const b = connectPage(dir, { report: () => "aztec-report" });
    b.register("aztec", [{ name: "report", description: "snapshot" }]);

    await expect(dir.call({ name: "report" })).rejects.toThrow(/ambiguous tool "report"/);
    await expect(dir.call({ name: "report", ns: "morpho" })).resolves.toBe("morpho-report");
    await expect(dir.call({ name: "report", clientId: b.clientId })).resolves.toBe("aztec-report");
  });

  it("ignores stray results and malformed messages", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    // None of these should throw.
    expect(() => dir.handleClientMessage(page.clientId, null)).not.toThrow();
    expect(() => dir.handleClientMessage(page.clientId, { type: "nope" })).not.toThrow();
    expect(() =>
      dir.handleClientMessage(page.clientId, { v: 1, type: "result", callId: "ghost", ok: true }),
    ).not.toThrow();
    expect(() => dir.handleClientMessage("no-such-client", { type: "register" })).not.toThrow();
  });

  it("uses only newly registered tools after a namespace swap", async () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir, { v: (a) => `got ${JSON.stringify(a)}` });
    page.register("morpho", [{ name: "v", description: "old" }], "h1");
    // Re-register the same name under a new hash — call must still route.
    page.register("morpho", [{ name: "v", description: "new" }], "h2");
    await expect(dir.call({ name: "v", args: { x: 1 } })).resolves.toBe('got {"x":1}');
  });
});
