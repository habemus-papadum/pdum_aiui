// @vitest-environment jsdom
/**
 * tools-link.test.ts — the panel's page-tools bridge: one socket per
 * tab-with-tools, lifecycle-by-disconnect, call round trips, activation on
 * tab change. Driven through the FakeBus (page events in) and a fake socket
 * factory (the channel side observed).
 */
import { describe, expect, it } from "vitest";
import { fakeBus } from "./fake-bus";
import { createToolsLink, type ToolsSocket } from "./tools-link";

interface FakeSocket extends ToolsSocket {
  url: string;
  sent: string[];
  closed: boolean;
  /** Drive the server side. */
  emit(type: "open" | "message" | "close", event?: unknown): void;
}

function fakeSockets(): { all: FakeSocket[]; factory: (url: string) => ToolsSocket } {
  const all: FakeSocket[] = [];
  return {
    all,
    factory: (url) => {
      const handlers = new Map<string, Array<(event: unknown) => void>>();
      const socket: FakeSocket = {
        url,
        sent: [],
        closed: false,
        send: (data) => socket.sent.push(data),
        close: () => {
          socket.closed = true;
          socket.emit("close");
        },
        addEventListener: (type, handler) => {
          const list = handlers.get(type) ?? [];
          list.push(handler as (event: unknown) => void);
          handlers.set(type, list);
        },
        emit: (type, event) => {
          for (const handler of handlers.get(type) ?? []) {
            handler(event);
          }
        },
      };
      all.push(socket);
      return socket;
    },
  };
}

const REGS = [{ ns: "plotapp", tools: [{ name: "set_range", description: "set the x range" }] }];

describe("createToolsLink", () => {
  it("one socket per tab-with-tools; registration carries tab identity", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({ host: bus, port: () => 5050, windowId: 3, socketFactory: factory });

    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    bus.firePageEvent({ kind: "pageTools", tab: 9, registrations: REGS });
    expect(all).toHaveLength(2); // one LITERAL websocket per tab (owner-confirmed)
    expect(all[0].url).toBe("ws://127.0.0.1:5050/tools");

    all[0].emit("open");
    const register = JSON.parse(all[0].sent[0]);
    expect(register).toMatchObject({
      v: 1,
      type: "register",
      ns: "plotapp",
      tab: { chromeTabId: 7, windowId: 3 },
    });
  });

  it("an EMPTY registration closes the socket — the directory forgets on close", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({ host: bus, port: () => 5050, socketFactory: factory });

    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: [] });
    expect(all[0].closed).toBe(true);
    expect(all).toHaveLength(1); // and no re-dial: the close was deliberate
  });

  it("routes a call to the page and the result back on the same socket", async () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({ host: bus, port: () => 5050, socketFactory: factory });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");
    bus.clearLog();

    all[0].emit("message", {
      data: JSON.stringify({
        v: 1,
        type: "call",
        callId: "c1",
        ns: "plotapp",
        name: "set_range",
        args: { x: [0, 1] },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Forwarded to the page as the toolsCall capability…
    expect(bus.log.some((line) => line.startsWith("page:toolsCall@7") && line.includes("c1"))).toBe(
      true,
    );
    // …and the page's answer (a toolsResult event) goes back as a result.
    bus.firePageEvent({ kind: "toolsResult", tab: 7, callId: "c1", ok: true, value: 42 });
    const result = all[0].sent.map((s) => JSON.parse(s)).find((m) => m.type === "result");
    expect(result).toMatchObject({ v: 1, callId: "c1", ok: true, value: 42 });
  });

  it("sends activation on tab change — engagement follows the eye", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({ host: bus, port: () => 5050, windowId: 3, socketFactory: factory });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");

    bus.switchTab(9);
    const activation = all[0].sent.map((s) => JSON.parse(s)).find((m) => m.type === "activation");
    expect(activation).toMatchObject({
      v: 1,
      type: "activation",
      tab: { chromeTabId: 9, windowId: 3 },
      active: true,
    });
  });

  it("dispose closes every socket and stops listening", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    const link = createToolsLink({ host: bus, port: () => 5050, socketFactory: factory });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    link.dispose();
    expect(all[0].closed).toBe(true);
    bus.firePageEvent({ kind: "pageTools", tab: 9, registrations: REGS });
    expect(all).toHaveLength(1); // deaf after dispose
  });
});
