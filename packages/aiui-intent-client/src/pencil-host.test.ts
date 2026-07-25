// @vitest-environment jsdom
/**
 * pencil-host.test.ts — the panel's remote-pencil host: the proxy surface
 * forwards the library's fire-and-forget stroke calls to the in-page surface
 * over the transport, the plane size is queried from the page, and the host
 * follows the tab in view. The real HostSession (relay + WebRTC) is faked; what
 * we pin is the wiring the library can't see.
 */

import type { PenSample } from "@habemus-papadum/aiui-pencil";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBus } from "./fake-bus";
import { correctRemotePoint, createPencilHost, type PencilHostSession } from "./pencil-host";

// A minimal PenSample for forwarding assertions.
const POINT = {
  x: 3,
  y: 4,
  t: 0,
  pressure: 0.5,
  altitude: 1,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 1,
  height: 1,
} as unknown as PenSample;

function fakeSession() {
  const calls: string[] = [];
  let captured: Parameters<
    NonNullable<Parameters<typeof createPencilHost>[0]["sessionFactory"]>
  >[0];
  const factory = (options: typeof captured): PencilHostSession => {
    captured = options;
    return {
      connect: () => calls.push("connect"),
      refresh: () => calls.push("refresh"),
      dispose: () => calls.push("dispose"),
      announce: () => calls.push("announce"),
    };
  };
  return { calls, factory, options: () => captured };
}

/** A held stream whose one video track reports a fixed frame size. */
function fakeStream(width: number, height: number): MediaStream {
  return {
    getVideoTracks: () => [{ getSettings: () => ({ width, height }) }],
  } as unknown as MediaStream;
}

describe("correctRemotePoint — the letterbox belt", () => {
  const point = (x: number, y: number): PenSample => ({ ...POINT, x, y }) as PenSample;

  it("undoes the in-frame letterbox a resize introduces", () => {
    // Plane 200×100 (aspect 2), frame 100×100 (aspect 1): the tab image sits
    // 100×50, centered — bars 25px top and bottom INSIDE the frame.
    const fixed = correctRemotePoint(
      point(100, 25),
      { width: 200, height: 100 },
      { width: 100, height: 100 },
    );
    // u=.5, v=.25 → frame px (50, 25) → the bar's top edge → CSS (100, 0).
    expect(fixed.x).toBeCloseTo(100, 6);
    expect(fixed.y).toBeCloseTo(0, 6);
  });

  it("is the identity when the frame matches the plane's aspect", () => {
    const fixed = correctRemotePoint(
      point(100, 25),
      { width: 200, height: 100 },
      { width: 400, height: 200 },
    );
    expect(fixed.x).toBeCloseTo(100, 6);
    expect(fixed.y).toBeCloseTo(25, 6);
  });

  it("passes through untouched with no frame to correct against", () => {
    expect(correctRemotePoint(point(3, 4), { width: 200, height: 100 }, undefined)).toMatchObject({
      x: 3,
      y: 4,
    });
  });
});

describe("createPencilHost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials the relay loopback and connects", () => {
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    const host = createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      stream: () => undefined,
      label: "demo",
      sessionFactory: fs.factory,
    });
    host.connect();
    expect(fs.options().url).toBe("ws://127.0.0.1:5050/pencil/host");
    // The presentation declares the one brush's color so the iPad's local
    // preview paints the same red the host inks (the proxy clamp enforces it).
    expect(fs.options().presentation?.strokeColor).toBe("#e5484d");
    expect(fs.calls).toContain("connect");
    // The plane size is queried from the page on connect.
    expect(bus.log).toContain('page:pencil@7 {"op":"size"}');
  });

  it("the proxy surface forwards the remote host's stroke calls to the page", () => {
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      stream: () => undefined,
      label: "demo",
      sessionFactory: fs.factory,
    }).connect();
    bus.clearLog();

    const surface = fs.options().surface();
    surface.remoteBegin("r1", { tool: "draw", params: {} as never, point: POINT });
    surface.remotePoint("r1", POINT);
    surface.remoteEnd("r1", POINT);
    surface.clear();
    surface.undo();

    expect(bus.log.some((l) => l.startsWith('page:pencil@7 {"op":"rbegin","id":"r1"'))).toBe(true);
    // The clamp: whatever params arrived, the forwarded stroke wears the ONE
    // brush — the red MARKUP pencil, the same instrument the local stylus
    // holds (owner, 2026-07-17: no grey remote ink).
    const rbegin = bus.log.find((l) => l.startsWith('page:pencil@7 {"op":"rbegin"'));
    expect(rbegin).toContain('"color":"#e5484d"');
    expect(rbegin).toContain('"tool":"draw"');
    expect(bus.log.some((l) => l.startsWith('page:pencil@7 {"op":"rpoint","id":"r1"'))).toBe(true);
    expect(bus.log.some((l) => l.startsWith('page:pencil@7 {"op":"rend","id":"r1"'))).toBe(true);
    expect(bus.log).toContain('page:pencil@7 {"op":"clear"}');
    expect(bus.log).toContain('page:pencil@7 {"op":"undo"}');
  });

  it("wears the letterbox belt: remote points are frame-corrected before forwarding", () => {
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      // A square 640×640 frame against the DEFAULT 1280×720 plane (the fake
      // bus answers no real size): the tab image is 640×360 centered, bars
      // 140px top and bottom inside the frame.
      stream: () => fakeStream(640, 640),
      label: "demo",
      sessionFactory: fs.factory,
    }).connect();
    bus.clearLog();

    const surface = fs.options().surface();
    // Plane (640, 180) = u .5, v .25 → frame px (320, 160) → CSS (640, 40).
    surface.remoteBegin("r1", {
      tool: "draw",
      params: {} as never,
      point: { ...POINT, x: 640, y: 180 } as PenSample,
    });
    const rbegin = bus.log.find((l) => l.startsWith('page:pencil@7 {"op":"rbegin"'));
    if (rbegin === undefined) {
      throw new Error("no rbegin forwarded");
    }
    const op = JSON.parse(rbegin.slice(rbegin.indexOf("{"))) as {
      init: { point: { x: number; y: number } };
    };
    expect(op.init.point.x).toBeCloseTo(640, 6);
    expect(op.init.point.y).toBeCloseTo(40, 6);
  });

  it("the iPad's two-finger pan scrolls the target page (default onScroll)", () => {
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      stream: () => undefined,
      label: "demo",
      sessionFactory: fs.factory,
    }).connect();
    bus.clearLog();

    fs.options().onScroll?.(0.1, -0.25);
    expect(bus.log).toContain('page:pencil@7 {"op":"scroll","du":0.1,"dv":-0.25}');
    // Pinch-zoom stays dropped: no default handler (visual-viewport zoom is
    // not scriptable; faking it would break the D2 plane contract).
    expect(fs.options().onZoom).toBeUndefined();
  });

  it("polls the plane while a viewer is connected, and announces a change", async () => {
    vi.useFakeTimers();
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      stream: () => undefined,
      label: "demo",
      sessionFactory: fs.factory,
    }).connect();
    bus.clearLog();

    const sizeOps = () => bus.log.filter((l) => l === 'page:pencil@7 {"op":"size"}').length;
    // Nobody watching: no poll.
    await vi.advanceTimersByTimeAsync(2500);
    expect(sizeOps()).toBe(0);

    // A viewer joins (the session's status feed) → the poll runs.
    fs.options().onStatus?.({ state: "hosting", viewers: 1, capturing: false });
    await vi.advanceTimersByTimeAsync(2500);
    expect(sizeOps()).toBeGreaterThanOrEqual(2);

    // The viewer leaves → the poll stops.
    fs.options().onStatus?.({ state: "hosting", viewers: 0, capturing: false });
    const seen = sizeOps();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sizeOps()).toBe(seen);
  });

  it("follows the tab in view — re-queries the plane and re-offers on a switch", () => {
    const bus = fakeBus({ activeTab: 7 });
    const fs = fakeSession();
    const host = createPencilHost({
      host: bus,
      port: 5050,
      tab: () => bus.targeting.activeTab(),
      stream: () => undefined,
      label: "demo",
      sessionFactory: fs.factory,
    });
    host.connect();
    bus.clearLog();

    bus.switchTab(9);
    expect(fs.calls).toContain("refresh");
    expect(bus.log).toContain('page:pencil@9 {"op":"size"}');

    // announce() forwards (no re-offer — the grant-landed / plane-moved push).
    host.announce();
    expect(fs.calls).toContain("announce");

    host.dispose();
    expect(fs.calls).toContain("dispose");
    // Deaf after dispose: a later switch does not re-query.
    bus.clearLog();
    bus.switchTab(7);
    expect(bus.log).toEqual([]);
  });
});
