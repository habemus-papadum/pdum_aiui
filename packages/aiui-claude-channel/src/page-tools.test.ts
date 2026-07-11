import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatPageToolsChanged,
  PageToolDirectory,
  type PageToolDirectoryOptions,
  type ServerToClientMessage,
} from "./page-tools";

/** Fixed-clock, sequential-id directory with a captured change log — deterministic. */
function makeDirectory(options: Partial<PageToolDirectoryOptions> = {}) {
  const log: string[] = [];
  let n = 0;
  const dir = new PageToolDirectory({
    log: (line) => log.push(line),
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    newId: () => `id-${++n}`,
    ...options,
  });
  return { dir, log };
}

/** The `activation` message the extension's service worker would send. */
const activation = (
  dir: PageToolDirectory,
  clientId: string,
  tab: { chromeTabId?: number; windowId?: number },
  active: boolean,
) => dir.handleClientMessage(clientId, { v: 1, type: "activation", tab, active });

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

describe("PageToolDirectory tab activation", () => {
  it("flags the active tab's entries and sorts them first", () => {
    const { dir } = makeDirectory();
    const a = connectPage(dir);
    a.register("morpho", [{ name: "x", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1, title: "Morphogen" },
    });
    const b = connectPage(dir);
    b.register("aztec", [{ name: "y", description: "d" }], "h2", {
      tab: { chromeTabId: 11, windowId: 1, title: "Aztec" },
    });

    activation(dir, a.clientId, { chromeTabId: 11, windowId: 1 }, true);
    expect(dir.list().map((r) => [r.ns, r.activeTab])).toEqual([
      ["aztec", true],
      ["morpho", undefined],
    ]);

    // Activation moves to the other tab: exactly one entry is re-flagged.
    activation(dir, a.clientId, { chromeTabId: 10, windowId: 1 }, true);
    expect(dir.list().map((r) => [r.ns, r.activeTab])).toEqual([
      ["morpho", true],
      ["aztec", undefined],
    ]);
  });

  it("tracks one active tab per window", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "x", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    page.register("aztec", [{ name: "y", description: "d" }], "h2", {
      tab: { chromeTabId: 20, windowId: 2 },
    });

    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, true);
    activation(dir, page.clientId, { chromeTabId: 20, windowId: 2 }, true);
    expect(dir.list().every((r) => r.activeTab === true)).toBe(true);
  });

  it("ignores a stale deactivation but honors a current one", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "x", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });

    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, true);
    // A late deactivation for a tab that is no longer active must not clobber.
    activation(dir, page.clientId, { chromeTabId: 99, windowId: 1 }, false);
    expect(dir.list()[0].activeTab).toBe(true);

    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, false);
    expect(dir.list()[0].activeTab).toBeUndefined();
  });

  it("degrades to no flags when activation is never reported", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "x", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    expect(dir.list()[0].activeTab).toBeUndefined();
  });

  it("ignores malformed activation messages", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    expect(() =>
      dir.handleClientMessage(page.clientId, { v: 1, type: "activation", active: true }),
    ).not.toThrow();
    expect(() =>
      dir.handleClientMessage(page.clientId, {
        v: 1,
        type: "activation",
        tab: { chromeTabId: "ten" },
        active: true,
      }),
    ).not.toThrow();
  });

  it("prefers the active tab's registration on an otherwise ambiguous call", async () => {
    const { dir } = makeDirectory();
    const a = connectPage(dir, { report: () => "from-morpho" });
    a.register("morpho", [{ name: "report", description: "snapshot" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    const b = connectPage(dir, { report: () => "from-aztec" });
    b.register("aztec", [{ name: "report", description: "snapshot" }], "h2", {
      tab: { chromeTabId: 11, windowId: 1 },
    });

    activation(dir, a.clientId, { chromeTabId: 11, windowId: 1 }, true);
    await expect(dir.call({ name: "report" })).resolves.toBe("from-aztec");
    // Explicit narrowing still beats the active-tab preference.
    await expect(dir.call({ name: "report", ns: "morpho" })).resolves.toBe("from-morpho");
  });

  it("keeps the candidates error when the active tab doesn't single one out", async () => {
    const { dir } = makeDirectory();
    // Two namespaces in the SAME tab expose the same name: both are active.
    const page = connectPage(dir, { report: () => "either" });
    page.register("morpho", [{ name: "report", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    page.register("aztec", [{ name: "report", description: "d" }], "h2", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, true);

    await expect(dir.call({ name: "report" })).rejects.toThrow(/ambiguous tool "report"/);
    await expect(dir.call({ name: "report" })).rejects.toThrow(/"activeTab":true/);
  });
});

describe("PageToolDirectory change signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A directory with a change counter attached; debounce left at the default 500ms. */
  function makeObserved() {
    const made = makeDirectory();
    let changes = 0;
    const unsubscribe = made.dir.onChange(() => {
      changes += 1;
    });
    return { ...made, changes: () => changes, unsubscribe };
  }

  it("emits once, debounced, for a burst of registrations", () => {
    const { dir, changes } = makeObserved();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1");
    page.register("aztec", [{ name: "b", description: "d" }], "h2");
    expect(changes()).toBe(0); // nothing before the quiet period

    vi.advanceTimersByTime(500);
    expect(changes()).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(changes()).toBe(1); // no re-emission without a new change
  });

  it("stays silent for a same-hash re-registration", () => {
    const { dir, changes } = makeObserved();
    const page = connectPage(dir);
    const tools = [{ name: "a", description: "d" }];
    page.register("morpho", tools, "h1");
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(1);

    page.register("morpho", tools, "h1"); // HMR/reload churn
    vi.advanceTimersByTime(5000);
    expect(changes()).toBe(1);
  });

  it("stays silent when a reconnect restores the same set within the window", () => {
    const { dir, changes } = makeObserved();
    const a = connectPage(dir);
    a.register("morpho", [{ name: "a", description: "d" }], "h1");
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(1);

    // A channel/page reload: socket close, then a fresh connection re-registers
    // the identical set (same ns + hash, new clientId) inside the debounce.
    dir.removeConnection(a.clientId);
    const b = connectPage(dir);
    b.register("morpho", [{ name: "a", description: "d" }], "h1");
    vi.advanceTimersByTime(5000);
    expect(changes()).toBe(1); // net effect: nothing changed
  });

  it("emits when a connection close takes registrations with it", () => {
    const { dir, changes } = makeObserved();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1");
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(1);

    dir.removeConnection(page.clientId);
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(2);
  });

  it("emits on an activation flip that re-flags an entry, and only then", () => {
    const { dir, changes } = makeObserved();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1 },
    });
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(1);

    // Activation of a tab holding no registrations changes nothing observable.
    activation(dir, page.clientId, { chromeTabId: 99, windowId: 1 }, true);
    vi.advanceTimersByTime(5000);
    expect(changes()).toBe(1);

    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, true);
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(2);
  });

  it("stops notifying after unsubscribe", () => {
    const { dir, changes, unsubscribe } = makeObserved();
    unsubscribe();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1");
    vi.advanceTimersByTime(500);
    expect(changes()).toBe(0);
  });

  it("contains a throwing listener and still notifies the rest", () => {
    const { dir, log } = makeDirectory();
    dir.onChange(() => {
      throw new Error("listener boom");
    });
    let heard = 0;
    dir.onChange(() => {
      heard += 1;
    });
    const page = connectPage(dir);
    page.register("morpho", [{ name: "a", description: "d" }], "h1");
    vi.advanceTimersByTime(500);
    expect(heard).toBe(1);
    expect(log.some((line) => line.includes("listener boom"))).toBe(true);
  });
});

describe("formatPageToolsChanged", () => {
  it("names every tool and the active tab", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("morpho", [{ name: "set-params", description: "d" }], "h1", {
      tab: { chromeTabId: 10, windowId: 1, title: "Morphogen" },
    });
    page.register("aztec", [{ name: "report", description: "d" }], "h2", {
      tab: { chromeTabId: 11, windowId: 1 },
      url: "http://localhost/aztec",
    });
    activation(dir, page.clientId, { chromeTabId: 10, windowId: 1 }, true);

    expect(formatPageToolsChanged(dir.list())).toBe(
      "page tools changed: morpho/set-params, aztec/report (active tab: Morphogen)",
    );
  });

  it("falls back to the url and degrades without an active tab", () => {
    const { dir } = makeDirectory();
    const page = connectPage(dir);
    page.register("aztec", [{ name: "report", description: "d" }], "h1", {
      tab: { chromeTabId: 11, windowId: 1, url: "http://localhost/aztec" },
    });
    expect(formatPageToolsChanged(dir.list())).toBe("page tools changed: aztec/report");

    activation(dir, page.clientId, { chromeTabId: 11, windowId: 1 }, true);
    expect(formatPageToolsChanged(dir.list())).toBe(
      "page tools changed: aztec/report (active tab: http://localhost/aztec)",
    );
  });

  it("says so when the directory empties", () => {
    expect(formatPageToolsChanged([])).toBe("page tools changed: none registered");
  });
});
