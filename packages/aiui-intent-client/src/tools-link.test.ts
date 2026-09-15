// @vitest-environment jsdom
/**
 * tools-link.test.ts — the panel's page-tools bridge: one socket per
 * tab-with-tools, lifecycle-by-disconnect, call round trips, activation on
 * tab change, and the honest per-host tab record. Driven through the FakeBus
 * (page events in) and a fake socket factory (the channel side observed).
 */
import type { PageToolDescriptor } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PageToolDescriptorReport } from "./cdp/page-script";
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
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      windowId: 3,
      socketFactory: factory,
    });

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
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });

    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: [] });
    expect(all[0].closed).toBe(true);
    expect(all).toHaveLength(1); // and no re-dial: the close was deliberate
  });

  it("routes a call to the page and the result back on the same socket", async () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });
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
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      windowId: 3,
      socketFactory: factory,
    });
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

  it("the CDP tier registers its handle as driverTab and tabInfo's target id — never a chrome id", async () => {
    const bus = fakeBus({ activeTab: 7 });
    // A plain-page host: tabInfo knows the CDP target and the driver handle.
    const host = {
      ...bus,
      targeting: {
        ...bus.targeting,
        tabInfo: async (tab: number) => ({
          url: `http://app/${tab}`,
          title: `app ${tab}`,
          targetId: `T-${tab}`,
          driverTab: tab,
        }),
      },
    };
    const { all, factory } = fakeSockets();
    createToolsLink({ host, port: () => 5050, tabIdKey: "driverTab", socketFactory: factory });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const registers = all[0].sent.map((s) => JSON.parse(s)).filter((m) => m.type === "register");
    // The first register (before tabInfo answered) already names the tab honestly…
    expect(registers[0].tab).toEqual({ driverTab: 7 });
    expect(registers[0].tab.chromeTabId).toBeUndefined();
    // …and the enriched one carries the target id + url/title the agent joins on.
    expect(registers.at(-1)).toMatchObject({
      url: "http://app/7",
      tab: { driverTab: 7, targetId: "T-7", url: "http://app/7", title: "app 7" },
    });
    expect(registers.at(-1).tab.chromeTabId).toBeUndefined();

    bus.switchTab(9);
    const activation = all[0].sent.map((s) => JSON.parse(s)).find((m) => m.type === "activation");
    expect(activation.tab).toEqual({ driverTab: 9, windowId: 0 });
  });

  it("a navigation re-registers with the new url (the title dropped until the page reports)", async () => {
    const bus = fakeBus({ activeTab: 7 });
    bus.setTabUrl(7, "http://app/a", "Page A");
    const { all, factory } = fakeSockets();
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = all[0].sent.map((s) => JSON.parse(s)).filter((m) => m.type === "register");
    expect(before.at(-1)).toMatchObject({ url: "http://app/a", tab: { title: "Page A" } });

    bus.firePageEvent({ kind: "navigation", tab: 7, from: "http://app/a", to: "http://app/b" });
    const after = all[0].sent.map((s) => JSON.parse(s)).filter((m) => m.type === "register");
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      url: "http://app/b",
      tab: { chromeTabId: 7, url: "http://app/b" },
    });
    expect(after.at(-1).tab.title).toBeUndefined();
    // A navigation on a tab with no link is nothing to re-register.
    bus.firePageEvent({ kind: "navigation", tab: 8, from: "x", to: "y" });
    expect(all).toHaveLength(1);
  });

  it("registration carries the activity bit and a content hash (change detection)", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });
    bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ...REGS[0], active: false }],
    });
    all[0].emit("open");
    const register = JSON.parse(all[0].sent[0]);
    expect(register.active).toBe(false);
    expect(typeof register.hash).toBe("string");
    expect(register.hash.length).toBeGreaterThan(0);

    // A route flip re-registers with the SAME hash (activity rides outside
    // it), so the directory updates the bit without logging a new set.
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    const second = all[0].sent.map((s) => JSON.parse(s)).filter((m) => m.type === "register")[1];
    expect(second.active).toBe(true);
    expect(second.hash).toBe(register.hash);
  });

  it("a CLOSED tab drops its socket — the leak that kept dead namespaces registered", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    all[0].emit("open");

    bus.firePageEvent({ kind: "tabClosed", tab: 7 });
    expect(all[0].closed).toBe(true);
    expect(all).toHaveLength(1); // deliberate close — no re-dial

    // A REOPENED app gets a fresh socket, not the ghost's.
    bus.firePageEvent({ kind: "pageTools", tab: 8, registrations: REGS });
    expect(all).toHaveLength(2);
  });

  it("dispose closes every socket and stops listening", () => {
    const bus = fakeBus({ activeTab: 7 });
    const { all, factory } = fakeSockets();
    const link = createToolsLink({
      host: bus,
      port: () => 5050,
      tabIdKey: "chromeTabId",
      socketFactory: factory,
    });
    bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: REGS });
    link.dispose();
    expect(all[0].closed).toBe(true);
    bus.firePageEvent({ kind: "pageTools", tab: 9, registrations: REGS });
    expect(all).toHaveLength(1); // deaf after dispose
  });

  // The page→panel tool descriptor (page-script's PageToolDescriptorReport, the
  // rows this link relays) IS the channel's PageToolDescriptor — the wire the
  // link speaks to the channel devDep. Pinned at typecheck so a field drift on
  // either side breaks the build instead of the socket. See the code-review
  // pass-2 S1 mirrors note (git history).
  it("the relayed tool descriptor is the channel's PageToolDescriptor (drift guard)", () => {
    expectTypeOf<PageToolDescriptorReport>().toEqualTypeOf<PageToolDescriptor>();
  });
});
