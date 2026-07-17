/**
 * The CdpBus over a scripted CDP socket: the wire is faked, everything above it
 * is the real bus. These rows are the ones a live browser would otherwise have
 * to teach us the hard way — the panel inking itself, a reload silently losing
 * the ring, the leader tab blanking the moment you look at the panel.
 */

import { describe, expect, it, vi } from "vitest";
import type { PageEvent } from "../transport";
import { connectCdpBus } from "./cdp-bus";
import type { CdpSocket } from "./protocol";

const ORIGIN = "http://127.0.0.1:51819";
const BRIDGE = "ws://127.0.0.1:51819/intent/cdp";

interface SentCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A CDP far end: replies to every command, and can push events at will. */
function scriptedBrowser(results: Record<string, unknown> = {}) {
  const sent: SentCommand[] = [];
  const listeners = {
    message: [] as Array<(event: { data: unknown }) => void>,
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<() => void>,
  };
  const deliver = (message: unknown): void => {
    for (const handler of listeners.message) {
      handler({ data: JSON.stringify(message) });
    }
  };
  const socket: CdpSocket = {
    send: (data) => {
      const command = JSON.parse(data) as SentCommand;
      sent.push(command);
      queueMicrotask(() => {
        deliver({ id: command.id, result: results[command.method] ?? {} });
      });
    },
    close: () => {
      for (const handler of listeners.close) {
        handler();
      }
    },
    addEventListener: (type: string, handler: never) => {
      (listeners[type as keyof typeof listeners] as unknown[]).push(handler);
    },
  };
  queueMicrotask(() => {
    for (const handler of listeners.open) {
      handler();
    }
  });
  return {
    factory: () => socket,
    sent,
    /** A page target shows up (auto-attach or our explicit attach). */
    attach: (sessionId: string, targetId: string, url: string) =>
      deliver({
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: { type: "page", targetId, url, title: url } },
      }),
    detach: (sessionId: string) =>
      deliver({ method: "Target.detachedFromTarget", params: { sessionId } }),
    /** The target navigated (URL changed) — no sessionId; a browser-level event. */
    infoChanged: (targetId: string, url: string) =>
      deliver({
        method: "Target.targetInfoChanged",
        params: { targetInfo: { type: "page", targetId, url, title: url, attached: true } },
      }),
    /** A document committed. `parentId` set = an iframe, not the page itself. */
    navigated: (sessionId: string, parentId?: string) =>
      deliver({
        method: "Page.frameNavigated",
        sessionId,
        params: { frame: { id: "F1", ...(parentId !== undefined ? { parentId } : {}) } },
      }),
    /** The injected bootstrap speaks through its binding. */
    report: (sessionId: string, payload: unknown) =>
      deliver({
        method: "Runtime.bindingCalled",
        sessionId,
        params: { name: "__aiuiIntentReport", payload: JSON.stringify(payload) },
      }),
    evaluated: (sessionId?: string) =>
      sent
        .filter((c) => c.method === "Runtime.evaluate" && (!sessionId || c.sessionId === sessionId))
        .map((c) => String(c.params.expression)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A capability INVOCATION (not the bootstrap source, which mentions them all). */
const call = (capability: string) => `__aiuiIntentPage.handle("${capability}"`;

const hello = (url: string, focused = true) => ({
  kind: "hello",
  url,
  title: url,
  visible: true,
  focused,
  aiui: false,
});

describe("CdpBus", () => {
  it("refuses a bridge that isn't loopback (CDP is root of the browser)", async () => {
    await expect(
      connectCdpBus({ cdpUrl: "ws://10.0.0.5:9222/intent/cdp", channelOrigin: ORIGIN }),
    ).rejects.toThrow(/non-loopback/);
  });

  it("auto-attaches in flat mode and adopts the tabs already open", async () => {
    const browser = scriptedBrowser({
      "Target.getTargets": {
        targetInfos: [
          { type: "page", targetId: "T1", url: "https://example.test/" },
          { type: "page", targetId: "PANEL", url: `${ORIGIN}/intent/` },
          // The DEV-served panel: the bus's OWN origin at the root path — no
          // /intent/ shape to recognize, excluded because it is where this
          // bus lives (found live: the panel inked itself).
          { type: "page", targetId: "SELF", url: "http://localhost:5173/?channel=49317" },
          { type: "background_page", targetId: "BG", url: "chrome://x" },
        ],
      },
    });
    await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      selfOrigin: "http://localhost:5173",
      socketFactory: browser.factory,
    });
    await settle();

    const autoAttach = browser.sent.find((c) => c.method === "Target.setAutoAttach");
    expect(autoAttach?.params).toMatchObject({ autoAttach: true, flatten: true });
    // Without discovery, targetInfoChanged never arrives (measured live) —
    // and the parked-tab adoption below would be deaf.
    const discover = browser.sent.find((c) => c.method === "Target.setDiscoverTargets");
    expect(discover?.params).toMatchObject({ discover: true });
    const attached = browser.sent
      .filter((c) => c.method === "Target.attachToTarget")
      .map((c) => c.params.targetId);
    // The victim tab, yes. The panel's own page and browser chrome, never.
    expect(attached).toEqual(["T1"]);
  });

  it("instruments each page once the binding exists, and never the panel itself", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S1", "T1", "https://example.test/");
    browser.attach("S2", "PANEL", `${ORIGIN}/intent/`);
    await settle();

    const order = browser.sent.filter((c) => c.sessionId === "S1").map((c) => c.method);
    expect(order).toEqual([
      "Runtime.enable",
      "Page.enable", // or no navigation events — a reloaded page goes dark
      "Runtime.addBinding", // BEFORE the code that calls it, or hello is lost
      "Page.addScriptToEvaluateOnNewDocument", // every future document
      "Runtime.evaluate", // and the one already loaded
    ]);
    expect(browser.sent.some((c) => c.sessionId === "S2")).toBe(false);
    expect(bus.pages().map((p) => p.tab)).toEqual([1]);
  });

  it("is one tab per page, however many times the browser attaches it", async () => {
    // Found live: browser-level auto-attach adopts the tabs already open, and
    // then our own adoption pass attaches them AGAIN — one page arrived as two
    // sessions, two tabs, and the second addBinding stole the first's reports.
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S1", "T1", "https://example.test/");
    browser.attach("S2", "T1", "https://example.test/"); // the same page, again
    await settle();

    expect(bus.pages().map((p) => p.tab)).toEqual([1]);
    expect(
      browser.sent.some((c) => c.sessionId === "S2" && c.method === "Runtime.addBinding"),
    ).toBe(false);
    expect(
      browser.sent.some(
        (c) => c.method === "Target.detachFromTarget" && c.params.sessionId === "S2",
      ),
    ).toBe(true);
  });

  it("never treats another panel as a page to drive", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    // A panel served by a DIFFERENT channel (another port) is still a panel.
    browser.attach("S1", "T1", "http://127.0.0.1:51819/intent/");
    browser.attach("S2", "T2", "https://example.test/");
    await settle();
    expect(bus.pages().map((p) => p.url === "" && p.tab)).toEqual([1]); // only the victim
  });

  it("maps page reports onto PageEvents", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    const events: PageEvent[] = [];
    bus.transport.onPageEvent((event) => events.push(event));
    browser.attach("S1", "T1", "https://example.test/");
    await settle();

    browser.report("S1", { ...hello("https://example.test/"), aiui: true });
    browser.report("S1", { kind: "selection", present: true });
    browser.report("S1", { kind: "interaction" });
    browser.report("S1", { kind: "key", key: "s", phase: "down", repeat: false });
    browser.report("S1", {
      kind: "navigation",
      from: "https://example.test/",
      to: "https://example.test/next",
      navKind: "push",
    });
    browser.report("S1", { kind: "jumpDone" });

    expect(events).toEqual([
      { kind: "aiuiSupport", tab: 1, supported: true },
      { kind: "selectionPresent", tab: 1, present: true },
      { kind: "interaction", tab: 1 },
      { kind: "keyForward", tab: 1, key: "s", phase: "down", repeat: false },
      {
        kind: "navigation",
        tab: 1,
        from: "https://example.test/",
        to: "https://example.test/next",
        navKind: "push",
      },
      { kind: "jumpDone", tab: 1 },
    ]);
  });

  it("follows the tab you are LOOKING at, not the one with keyboard focus", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    const seen: Array<number | undefined> = [];
    bus.targeting.onActiveTabChange((tab) => seen.push(tab));
    browser.attach("S1", "T1", "https://one.test/");
    browser.attach("S2", "T2", "https://two.test/");
    await settle();

    // Found live: with the browser app in the background (you are in your
    // editor; an agent is driving), NO page has focus — every hello says
    // focused:false. A focus-only rule left the turn aimed at an about:blank
    // nobody had looked at. Visibility is the signal.
    browser.report("S2", { ...hello("https://two.test/"), focused: false });
    expect(bus.targeting.activeTab()).toBe(2);

    // You look at the panel: the victim page keeps being the visible tab of
    // its window, so it stays the leader — the claims must not re-point to
    // nothing the moment you touch the bar.
    browser.report("S2", { kind: "focus", visible: true, focused: false });
    expect(bus.targeting.activeTab()).toBe(2);

    // You switch to the other tab: it becomes visible, and takes the lead.
    browser.report("S1", { kind: "focus", visible: true, focused: false });
    expect(bus.targeting.activeTab()).toBe(1);

    browser.detach("S1");
    expect(bus.targeting.activeTab()).toBe(2);
    expect(seen).toEqual([1, 2, 1, 2]);
  });

  it("re-asserts ring and keylayer when a document reloads (the desire never changed)", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();
    browser.report("S1", hello("https://example.test/"));

    bus.transport.broadcastRing({ on: true, turnTone: true });
    await bus.transport.requestPage(1, "keylayer", { capture: true });
    await settle();
    const before = browser.evaluated("S1").length;

    // A full navigation: a NEW document, with none of that in it.
    browser.report("S1", hello("https://example.test/next"));
    await settle();

    const replayed = browser.evaluated("S1").slice(before);
    expect(replayed.some((e) => e.includes(call("ring")) && e.includes('"turnTone":true'))).toBe(
      true,
    );
    expect(replayed.some((e) => e.includes(call("keylayer")) && e.includes('"capture":true'))).toBe(
      true,
    );
  });

  it("re-injects the bootstrap when a page navigates to a new document", async () => {
    // Found live: a reloaded tab came back BARE — no bootstrap, no reports, no
    // ring — while its CDP session was still perfectly healthy. A page the
    // client cannot see is worse than no page, so the navigation itself
    // re-injects rather than trusting the add-script registration alone.
    const browser = scriptedBrowser();
    await connectCdpBus({ cdpUrl: BRIDGE, channelOrigin: ORIGIN, socketFactory: browser.factory });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();
    const before = browser.evaluated("S1").length;

    browser.navigated("S1"); // main-frame commit
    await settle();

    const injected = browser.evaluated("S1").slice(before);
    expect(injected.some((e) => e.includes("__aiuiIntentPage"))).toBe(true);
  });

  it("ignores a SUB-frame navigation (only the document that owns the page matters)", async () => {
    const browser = scriptedBrowser();
    await connectCdpBus({ cdpUrl: BRIDGE, channelOrigin: ORIGIN, socketFactory: browser.factory });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();
    const before = browser.evaluated("S1").length;

    browser.navigated("S1", "PARENT"); // an iframe committed — not our business
    await settle();

    expect(browser.evaluated("S1").length).toBe(before);
  });

  it("takes a shot with no grant and no stream (the tier's advantage over MV3)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const browser = scriptedBrowser({
      "Page.captureScreenshot": { data: png },
      "Page.getLayoutMetrics": { cssVisualViewport: { clientWidth: 1280.4, clientHeight: 800.2 } },
    });
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();

    const held = await bus.capture.holdStream(1);
    expect(held.tab).toBe(1); // nothing to warm — but the claim still holds it
    held.release();

    const shot = await bus.capture.grabShot(1);
    expect(shot.mime).toBe("image/png");
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(800);
    expect([...shot.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(shot.thumb).toBe(`data:image/png;base64,${png}`);
  });

  it("crops a region against browser ZOOM — the clip is unzoomed px, the rubber band is not", async () => {
    // A real PNG header so pngSize reads a device-resolution 450×300 out of IHDR.
    const ihdr = Buffer.alloc(24);
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
    ihdr.write("IHDR", 12, "ascii");
    ihdr.writeUInt32BE(450, 16);
    ihdr.writeUInt32BE(300, 20);
    const browser = scriptedBrowser({
      "Page.captureScreenshot": { data: ihdr.toString("base64") },
      // zoom 1.5: clientX-space rects need ×1.5 to land in the clip's unzoomed space.
      "Page.getLayoutMetrics": { cssVisualViewport: { zoom: 1.5 } },
    });
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();

    const shot = await bus.capture.grabRegion?.(
      1,
      { x: 10, y: 20, w: 300, h: 200 },
      { w: 897, h: 751 },
    );

    // The clip is the rubber-band rect multiplied by the live zoom, scale 1.
    const cap = browser.sent.find((c) => c.method === "Page.captureScreenshot");
    expect(cap?.params.clip).toEqual({ x: 15, y: 30, width: 450, height: 300, scale: 1 });
    // Reported size is the PNG's true (device) pixels, not the CSS rect.
    expect(shot?.width).toBe(450);
    expect(shot?.height).toBe(300);
  });

  it("injects the page bundle before a pencil op — the page fetches nothing", async () => {
    // Found live: the page imported its surface module from the channel origin,
    // which an https page refuses as mixed content — the ring appeared on
    // example.com and the surface, silently, did not. The bus reads the bundle
    // from its OWN origin and evaluates the source into the page.
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
      bundleSource: async () => "/* the page bundle */ window.__aiuiIntentPage = {};",
    });
    browser.attach("S1", "T1", "https://example.test/");
    await settle();

    await bus.transport.requestPage(1, "pencil", { op: "engage", fadeSec: 4 });
    const evaluated = browser.evaluated("S1");
    const bundleAt = evaluated.findIndex((e) => e.includes("the page bundle"));
    const pencilAt = evaluated.findIndex((e) => e.includes(call("pencil")));
    expect(bundleAt).toBeGreaterThanOrEqual(0);
    expect(bundleAt).toBeLessThan(pencilAt); // the surface exists before we use it
    expect(evaluated[pencilAt]).toContain('"fadeSec":4');

    // One document, one injection: a second op does not re-evaluate the bundle.
    await bus.transport.requestPage(1, "pencil", { op: "disengage" });
    expect(browser.evaluated("S1").filter((e) => e.includes("the page bundle"))).toHaveLength(1);

    // …but a NEW document has no bundle in it, so the next op re-injects.
    browser.report("S1", hello("https://example.test/next"));
    await settle();
    await bus.transport.requestPage(1, "pencil", { op: "engage" });
    expect(
      browser.evaluated("S1").filter((e) => e.includes("the page bundle")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("ignores a report from a page it never registered", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    const events = vi.fn();
    bus.transport.onPageEvent(events);
    browser.report("GHOST", { kind: "interaction" });
    expect(events).not.toHaveBeenCalled();
  });

  it("a tab born as browser chrome is adopted when it navigates somewhere driveable", async () => {
    // The + button: a fresh tab attaches as chrome://newtab — excluded — and
    // then navigates to the app. The verdict must be re-rendered on the NEW
    // url (found live: the third tab was never instrumented).
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S9", "T9", "chrome://new-tab-page/");
    await settle();
    expect(bus.pages()).toHaveLength(0); // parked, not driven
    expect(browser.sent.some((c) => c.sessionId === "S9")).toBe(false); // untouched

    browser.infoChanged("T9", "http://localhost:5173/app");
    await settle();
    expect(bus.pages()).toHaveLength(1); // adopted on the navigation…
    expect(
      browser.sent.some((c) => c.sessionId === "S9" && c.method === "Runtime.addBinding"),
    ).toBe(true); // …and instrumented through the ordinary path

    // Later navigations of an ADOPTED tab change nothing (no double-adopt).
    browser.infoChanged("T9", "http://localhost:5173/other");
    await settle();
    expect(bus.pages()).toHaveLength(1);
  });

  it("a parked tab that closes without navigating is forgotten", async () => {
    const browser = scriptedBrowser();
    const bus = await connectCdpBus({
      cdpUrl: BRIDGE,
      channelOrigin: ORIGIN,
      socketFactory: browser.factory,
    });
    browser.attach("S9", "T9", "chrome://new-tab-page/");
    browser.detach("S9");
    await settle();
    // A navigation event for the dead target must not resurrect it.
    browser.infoChanged("T9", "http://localhost:5173/app");
    await settle();
    expect(bus.pages()).toHaveLength(0);
  });

  it("beats every attached page with its session id; dispose stops the pulse", async () => {
    vi.useFakeTimers();
    try {
      const browser = scriptedBrowser();
      const bus = await connectCdpBus({
        cdpUrl: BRIDGE,
        channelOrigin: ORIGIN,
        socketFactory: browser.factory,
      });
      browser.attach("S1", "T1", "https://example.test/");
      await vi.advanceTimersByTimeAsync(0);
      const beats = () => browser.evaluated("S1").filter((e) => e.includes(call("heartbeat")));
      expect(beats()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(800);
      expect(beats()).toHaveLength(1);
      expect(beats()[0]).toContain("session"); // the per-boot driver id rides every beat

      await vi.advanceTimersByTimeAsync(750);
      expect(beats()).toHaveLength(2);

      bus.dispose();
      await vi.advanceTimersByTimeAsync(10000);
      expect(beats()).toHaveLength(2); // the pulse died with the bus
    } finally {
      vi.useRealTimers();
    }
  });
});
