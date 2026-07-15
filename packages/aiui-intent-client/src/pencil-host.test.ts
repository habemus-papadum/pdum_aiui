// @vitest-environment jsdom
/**
 * pencil-host.test.ts — the panel's remote-pencil host: the proxy surface
 * forwards the library's fire-and-forget stroke calls to the in-page surface
 * over the transport, the plane size is queried from the page, and the host
 * follows the tab in view. The real HostSession (relay + WebRTC) is faked; what
 * we pin is the wiring the library can't see.
 */

import type { PenSample } from "@habemus-papadum/aiui-pencil";
import { describe, expect, it } from "vitest";
import { fakeBus } from "./fake-bus";
import { createPencilHost, type PencilHostSession } from "./pencil-host";

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
    };
  };
  return { calls, factory, options: () => captured };
}

describe("createPencilHost", () => {
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
    expect(bus.log.some((l) => l.startsWith('page:pencil@7 {"op":"rpoint","id":"r1"'))).toBe(true);
    expect(bus.log.some((l) => l.startsWith('page:pencil@7 {"op":"rend","id":"r1"'))).toBe(true);
    expect(bus.log).toContain('page:pencil@7 {"op":"clear"}');
    expect(bus.log).toContain('page:pencil@7 {"op":"undo"}');
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

    host.dispose();
    expect(fs.calls).toContain("dispose");
    // Deaf after dispose: a later switch does not re-query.
    bus.clearLog();
    bus.switchTab(7);
    expect(bus.log).toEqual([]);
  });
});
