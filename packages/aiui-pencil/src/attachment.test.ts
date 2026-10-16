// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindInkAttachment } from "./attachment";
import { createInkDocument } from "./document";
import { createInkSession } from "./session";
import type { PenSample } from "./telemetry";

const point: PenSample = {
  x: 10,
  y: 20,
  t: 0,
  pressure: 1,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 1,
  height: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("explicit ink attachment", () => {
  it("follows a scroll mapping, keeps source records unchanged, and skips identical mappings", () => {
    const ink = createInkDocument();
    const session = createInkSession(ink);
    session.begin("p", point);
    session.finish("p");
    const record = ink.snapshot().strokes[0];
    const canvas = document.createElement("canvas");
    const scrollTarget = new EventTarget();
    let scrollTop = 0;
    const surface = { canvas, setViewport: vi.fn(), setActive: vi.fn() };
    const attachment = bindInkAttachment({
      surface,
      scrollTarget,
      viewport: () => ({ x: 0, y: -scrollTop, scale: 1 }),
    });
    expect(surface.setViewport).toHaveBeenCalledTimes(1);
    attachment.refresh();
    expect(surface.setViewport).toHaveBeenCalledTimes(1);
    scrollTop = 40;
    scrollTarget.dispatchEvent(new Event("scroll"));
    expect(surface.setViewport).toHaveBeenLastCalledWith({ x: 0, y: -40, scale: 1 });
    expect(ink.snapshot().strokes[0]).toBe(record);
    attachment.dispose();
    scrollTop = 80;
    scrollTarget.dispatchEvent(new Event("scroll"));
    expect(surface.setViewport).toHaveBeenCalledTimes(2);
  });

  it("refreshes a rotation-only mapping change", () => {
    let rotation = 0;
    const surface = {
      canvas: document.createElement("canvas"),
      setViewport: vi.fn(),
      setActive: vi.fn(),
    };
    const scrollTarget = new EventTarget();
    const attachment = bindInkAttachment({
      surface,
      scrollTarget,
      viewport: () => ({ x: 0, y: 0, scale: 1, rotation }),
    });
    rotation = Math.PI / 3;
    attachment.refresh();
    expect(surface.setViewport).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      scale: 1,
      rotation: Math.PI / 3,
    });
    attachment.refresh();
    expect(surface.setViewport).toHaveBeenCalledTimes(2);
    attachment.dispose();
  });

  it("requires explicit resume after invalidation, cancelling input while retaining completed ink", () => {
    const ink = createInkDocument();
    const session = createInkSession(ink);
    session.begin("done", point);
    session.finish("done");
    const record = ink.snapshot().strokes[0];
    const canvas = document.createElement("canvas");
    const scrollTarget = new EventTarget();
    let y = 0;
    const surface = {
      canvas,
      setViewport: vi.fn(() => session.cancel("live")),
      setActive: vi.fn((active: boolean) => {
        if (!active) session.cancel("live");
      }),
    };
    const attachment = bindInkAttachment({
      surface,
      scrollTarget,
      viewport: () => ({ x: 0, y, scale: 1 }),
    });
    session.begin("live", point);
    attachment.invalidate();
    expect(ink.snapshot().live).toHaveLength(0);
    expect(ink.snapshot().strokes[0]).toBe(record);
    expect(canvas.style.visibility).toBe("hidden");
    expect(attachment.valid()).toBe(false);
    y = 50;
    scrollTarget.dispatchEvent(new Event("scroll"));
    expect(surface.setViewport).toHaveBeenCalledTimes(1);
    attachment.resume();
    expect(canvas.style.visibility).toBe("");
    expect(surface.setViewport).toHaveBeenLastCalledWith({ x: 0, y: 50, scale: 1 });
    expect(attachment.valid()).toBe(true);
    attachment.dispose();
  });

  it("observes declared resize dependencies and disconnects on disposal", () => {
    const observe = vi.fn(),
      disconnect = vi.fn();
    let onResize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const canvas = document.createElement("canvas"),
      content = document.createElement("div");
    let scale = 1;
    const surface = { canvas, setViewport: vi.fn(), setActive: vi.fn() };
    const attachment = bindInkAttachment({
      surface,
      scrollTarget: content,
      resizeTargets: [content],
      viewport: () => ({ x: 0, y: 0, scale }),
    });
    expect(observe).toHaveBeenCalledWith(content);
    scale = 2;
    onResize?.();
    expect(surface.setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, scale: 2 });
    attachment.dispose();
    attachment.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
    scale = 3;
    onResize?.();
    window.dispatchEvent(new Event("resize"));
    expect(surface.setViewport).toHaveBeenCalledTimes(2);
    expect(attachment.valid()).toBe(false);
  });
});
