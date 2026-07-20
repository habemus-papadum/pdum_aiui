/**
 * The ExtensionBus over a faked `chrome.*`: the wire is stubbed, everything
 * above it is the real bus. The rows here are the ones the MV3 shell can get
 * wrong in ways that are invisible until you are driving a real page — a panel
 * hearing another window's tabs, a reloaded page coming back bare, a shot taken
 * on a tab the user never granted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageEvent } from "../transport";
import { connectExtensionBus } from "./extension-bus";
import type { ReportMessage } from "./protocol";

interface FakeChrome {
  fireMessage(msg: unknown, sender: { tab?: { id: number; windowId: number } }): void;
  fireActivated(info: { tabId: number; windowId: number }): void;
  fireRemoved(tabId: number): void;
  /** Every `chrome.tabs.sendMessage` the bus made, as "tab:cmd:payload". */
  sent: string[];
}

function fakeChrome(options: { windowTabs: Array<{ id: number; active?: boolean }> }): FakeChrome {
  const messageHandlers: Array<(msg: unknown, sender: unknown) => void> = [];
  const activatedHandlers: Array<(info: unknown) => void> = [];
  const removedHandlers: Array<(tabId: number) => void> = [];
  const sent: string[] = [];

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: (msg: unknown, sender: unknown) => void) => messageHandlers.push(fn),
        removeListener: () => {},
      },
      sendMessage: () => Promise.resolve(),
      lastError: undefined,
    },
    tabs: {
      query: (q: { active?: boolean }) =>
        Promise.resolve(
          q.active === true ? options.windowTabs.filter((t) => t.active) : options.windowTabs,
        ),
      get: (id: number) =>
        Promise.resolve({ id, url: `https://tab${id}.test/`, title: `tab ${id}` }),
      sendMessage: (tabId: number, envelope: { cmd: string; payload?: unknown }) => {
        sent.push(`${tabId}:${envelope.cmd}:${JSON.stringify(envelope.payload ?? null)}`);
        return Promise.resolve({ ok: true, value: { ok: true } });
      },
      onActivated: {
        addListener: (fn: (info: unknown) => void) => activatedHandlers.push(fn),
        removeListener: () => {},
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => removedHandlers.push(fn),
        removeListener: () => {},
      },
    },
  };

  return {
    sent,
    fireMessage: (msg, sender) => {
      for (const fn of messageHandlers) {
        fn(msg, sender);
      }
    },
    fireActivated: (info) => {
      for (const fn of activatedHandlers) {
        fn(info);
      }
    },
    fireRemoved: (tabId) => {
      for (const fn of removedHandlers) {
        fn(tabId);
      }
    },
  };
}

const report = (report: ReportMessage["report"]): ReportMessage => ({
  aiuiIntentReport: 1,
  report,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe("ExtensionBus", () => {
  it("asks the browser which tab is active — no visibility heuristics needed", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }, { id: 9 }] });
    const bus = await connectExtensionBus({ windowId: 1 });
    expect(bus.targeting.activeTab()).toBe(7);

    const seen: Array<number | undefined> = [];
    bus.targeting.onActiveTabChange((tab) => seen.push(tab));
    fake.fireActivated({ tabId: 9, windowId: 1 });
    expect(bus.targeting.activeTab()).toBe(9);

    // Another WINDOW's tab switch is not ours: a side panel drives its own
    // window's tabs, and only those.
    fake.fireActivated({ tabId: 42, windowId: 2 });
    expect(bus.targeting.activeTab()).toBe(9);
    expect(seen).toEqual([9]);
  });

  it("hears page reports from its own window only", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    const bus = await connectExtensionBus({ windowId: 1 });
    const events: PageEvent[] = [];
    bus.transport.onPageEvent((event) => events.push(event));

    fake.fireMessage(report({ kind: "interaction" }), { tab: { id: 7, windowId: 1 } });
    fake.fireMessage(report({ kind: "selection", present: true }), { tab: { id: 7, windowId: 1 } });
    // A page in ANOTHER window reports too — every panel hears it, and must not
    // act on it (the ring, the keys and the turn all belong to one window).
    fake.fireMessage(report({ kind: "interaction" }), { tab: { id: 88, windowId: 2 } });

    expect(events).toEqual([
      { kind: "interaction", tab: 7 },
      { kind: "selectionPresent", tab: 7, present: true },
    ]);
  });

  it("replays cached page facts to a LATE subscriber (the unlit-aiui-pill lesson)", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    const bus = await connectExtensionBus({ windowId: 1 });

    // The page announces itself BEFORE anyone subscribes — exactly the panel
    // boot gap (the bus connects several awaits before the client registers
    // its page-event handler; seen live 2026-07-18 as an aiui pill that only
    // lit after a manual page reload).
    fake.fireMessage(
      report({
        kind: "hello",
        url: "http://x/",
        title: "t",
        visible: true,
        focused: true,
        aiui: true,
      }),
      { tab: { id: 7, windowId: 1 } },
    );
    fake.fireMessage(report({ kind: "selection", present: true }), { tab: { id: 7, windowId: 1 } });

    const events: PageEvent[] = [];
    bus.transport.onPageEvent((event) => events.push(event));
    expect(events).toEqual([]); // async replay: never inside the registration call
    await settle();
    expect(events).toContainEqual({ kind: "aiuiSupport", tab: 7, supported: true });
    expect(events).toContainEqual({ kind: "selectionPresent", tab: 7, present: true });
  });

  it("re-asserts ring and key layer when a document says hello again (the reload lesson)", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    const bus = await connectExtensionBus({ windowId: 1 });

    bus.transport.broadcastRing({ on: true, turnTone: true });
    await bus.transport.requestPage(7, "keylayer", { capture: true });
    await settle();
    const before = fake.sent.length;

    // The page reloaded: a NEW document, with none of that in it. The client's
    // desire has not changed, so no claim re-applies — the bus must.
    fake.fireMessage(
      report({
        kind: "hello",
        url: "https://tab7.test/",
        title: "t",
        visible: true,
        focused: true,
        aiui: false,
      }),
      { tab: { id: 7, windowId: 1 } },
    );
    await settle();

    const replayed = fake.sent.slice(before);
    expect(replayed.some((s) => s.startsWith("7:ring:") && s.includes('"turnTone":true'))).toBe(
      true,
    );
    expect(replayed.some((s) => s.startsWith("7:keylayer:") && s.includes('"capture":true'))).toBe(
      true,
    );
  });

  it("says the capture grant is REAL here — tabCapture is invocation-gated", async () => {
    fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    const bus = await connectExtensionBus({ windowId: 1 });
    // The opposite of the CDP tier: the user must invoke the extension on a tab
    // before its pixels are available, so the machine's capture gates stay dark
    // until the activation gesture mints the grant.
    expect(bus.capture.grantless).toBe(false);
  });

  it("names the invocation surfaces in the hollow ring's hint (the chord is retired)", async () => {
    // The activation chord is gone (owner, 2026-07-20) — the remaining
    // invocation surfaces are the context-menu grant item and the toolbar
    // click, and the hint leads with the one that works unpinned.
    fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    const bus = await connectExtensionBus({ windowId: 1 });
    expect(bus.capture.grantHint).toBe("right-click → aiui: grant capture");
  });

  it("projects the ring per tab: solid where the grant is, hollow + hint everywhere else", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }, { id: 9 }] });
    const bus = await connectExtensionBus({ windowId: 1 });

    bus.transport.broadcastRing({
      on: true,
      turnTone: true,
      grant: { tab: 7, hint: "right-click → aiui: grant capture" },
    });
    await settle();

    // Tab 7 holds the grant: the ordinary breathing ring, no hint.
    const to7 = fake.sent.find((s) => s.startsWith("7:ring:"));
    expect(to7).toBeDefined();
    expect(to7).not.toContain("hollow");
    // Tab 9 does not: HOLLOW, carrying how to mint the grant right there.
    const to9 = fake.sent.find((s) => s.startsWith("9:ring:"));
    expect(to9).toContain('"hollow":true');
    expect(to9).toContain('"hint":"right-click → aiui: grant capture"');
  });

  it("treats a tab with no content script as a tab with no capabilities, not an error", async () => {
    const fake = fakeChrome({ windowTabs: [{ id: 7, active: true }] });
    (
      globalThis as unknown as { chrome: { tabs: { sendMessage: unknown } } }
    ).chrome.tabs.sendMessage = () => Promise.reject(new Error("Could not establish connection"));
    const bus = await connectExtensionBus({ windowId: 1 });

    // chrome://, the web store, a tab still loading: the page simply has no
    // capabilities. The claims degrade; nothing throws into the machine.
    await expect(bus.transport.requestPage(7, "selection")).resolves.toBeUndefined();
    expect(fake.sent).toEqual([]);
  });
});
