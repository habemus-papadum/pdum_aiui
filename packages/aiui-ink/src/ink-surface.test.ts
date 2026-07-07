// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkSurface } from "./ink-surface";
import type { StrokeStyle } from "./strokes";

const surfaces: InkSurface[] = [];
const make = (opts?: ConstructorParameters<typeof InkSurface>[0]): InkSurface => {
  const s = new InkSurface(opts);
  surfaces.push(s);
  return s;
};

afterEach(() => {
  for (const s of surfaces.splice(0)) {
    s.dispose();
  }
});

const blue: StrokeStyle = { color: "#00f", width: 4 };

describe("InkSurface remote feed", () => {
  it("appends a canvas to the target and reports its CSS size", () => {
    const surface = make();
    expect(document.body.contains(surface.canvas)).toBe(true);
    expect(surface.size().width).toBe(window.innerWidth);
    expect(surface.size().height).toBe(window.innerHeight);
  });

  it("builds a remote stroke from begin/point/end", () => {
    const surface = make();
    expect(surface.hasInk()).toBe(false);

    surface.remoteBegin("s1", { style: blue, point: { x: 10, y: 10 } });
    surface.remotePoint("s1", { x: 20, y: 30 });
    surface.remoteEnd("s1", { x: 40, y: 30 });

    expect(surface.hasInk()).toBe(true);
    expect(surface.inkBounds()).toEqual({ x: 10, y: 10, w: 30, h: 20 });
  });

  it("removes a cancelled stroke", () => {
    const surface = make();
    surface.remoteBegin("s1", { style: blue, point: { x: 0, y: 0 } });
    surface.remotePoint("s1", { x: 5, y: 5 });
    surface.remoteCancel("s1");
    expect(surface.hasInk()).toBe(false);
  });

  it("ignores points/end for an unknown stroke id", () => {
    const surface = make();
    expect(() => {
      surface.remotePoint("nope", { x: 1, y: 1 });
      surface.remoteEnd("nope");
      surface.remoteCancel("nope");
    }).not.toThrow();
    expect(surface.hasInk()).toBe(false);
  });

  it("clear() drops everything and fires onAutoClear only when asked", () => {
    const onAutoClear = vi.fn();
    const surface = make({ onAutoClear });
    surface.remoteBegin("s1", { style: blue, point: { x: 1, y: 1 } });
    surface.remoteEnd("s1");
    surface.clear(true);
    expect(surface.hasInk()).toBe(false);
    expect(onAutoClear).toHaveBeenCalledTimes(1);

    surface.remoteBegin("s2", { style: blue, point: { x: 1, y: 1 } });
    surface.remoteEnd("s2");
    surface.clear(false);
    expect(onAutoClear).toHaveBeenCalledTimes(1);
  });
});

describe("InkSurface compositeInto", () => {
  it("strokes each committed path into the target context", () => {
    const surface = make();
    surface.remoteBegin("s1", { style: blue, point: { x: 10, y: 10 } });
    surface.remotePoint("s1", { x: 20, y: 20 });
    surface.remotePoint("s1", { x: 30, y: 10 });
    surface.remoteEnd("s1");

    const calls: string[] = [];
    const ctx = recordingContext(calls);
    surface.compositeInto(ctx, 5, 5, 2);

    expect(calls).toContain("stroke");
    expect(calls).toContain("moveTo");
    expect(calls).toContain("quadraticCurveTo");
  });

  it("draws a dot for a single-point stroke", () => {
    const surface = make();
    surface.remoteBegin("s1", { style: blue, point: { x: 10, y: 10 } });
    surface.remoteEnd("s1");

    const calls: string[] = [];
    surface.compositeInto(recordingContext(calls), 0, 0, 1);
    expect(calls).toContain("arc");
    expect(calls).toContain("fill");
  });
});

/** A CanvasRenderingContext2D stub that records the method names it receives. */
function recordingContext(calls: string[]): CanvasRenderingContext2D {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "canvas") {
        return {};
      }
      return (...args: unknown[]) => {
        void args;
        calls.push(prop);
      };
    },
    set() {
      return true;
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
}
