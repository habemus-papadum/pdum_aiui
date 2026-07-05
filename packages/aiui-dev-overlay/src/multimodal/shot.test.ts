// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ink } from "./ink";
import { locateComponents, ShotTool } from "./shot";

afterEach(() => {
  delete window.__AIUI__;
  vi.restoreAllMocks();
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});

/** jsdom lacks elementsFromPoint; install one that returns `els` for any point. */
function stubElementsFromPoint(els: Element[]): void {
  (
    document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }
  ).elementsFromPoint = () => els;
}

describe("locateComponents (the P3 locator: data-source-loc / data-cell)", () => {
  it("reads data-cell for the name and resolves the stamp to an absolute path", () => {
    const el = document.createElement("div");
    el.setAttribute("data-cell", "SpectrumPlot");
    el.setAttribute("data-source-loc", "src/ui/Plot.tsx:20:9");
    document.body.append(el);
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/repo/app" };
    stubElementsFromPoint([el]);

    const [component] = locateComponents({ x: 0, y: 0, w: 100, h: 100 }, []);
    expect(component.component).toBe("SpectrumPlot");
    expect(component.source).toBe("/repo/app/src/ui/Plot.tsx:20:9");
    el.remove();
  });

  it("passes the relative stamp through when no sourceRoot is known", () => {
    const el = document.createElement("div");
    el.setAttribute("data-cell", "Legend");
    el.setAttribute("data-source-loc", "src/ui/Legend.tsx:3:1");
    document.body.append(el);
    stubElementsFromPoint([el]);

    const [component] = locateComponents({ x: 0, y: 0, w: 10, h: 10 }, []);
    expect(component.source).toBe("src/ui/Legend.tsx:3:1");
    el.remove();
  });
});

/** Stub the getDisplayMedia + canvas stack jsdom lacks, so a shot yields bytes. */
function stubCapture(): () => void {
  const track = { addEventListener() {}, stop() {} };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia: async () => stream, getUserMedia: async () => stream },
    configurable: true,
  });
  const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const media = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    getContext: canvas.getContext,
    toBlob: canvas.toBlob,
    toDataURL: canvas.toDataURL,
    play: media.play,
    srcObject: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject"),
  };
  canvas.getContext = () => fakeCtx;
  canvas.toBlob = (cb: (b: Blob) => void) =>
    cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  canvas.toDataURL = () => "data:image/png;base64,iVBOR";
  media.play = async () => {};
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return () => {
    if (originalMedia) {
      Object.defineProperty(navigator, "mediaDevices", originalMedia);
    }
    canvas.getContext = saved.getContext;
    canvas.toBlob = saved.toBlob;
    canvas.toDataURL = saved.toDataURL;
    media.play = saved.play;
    if (saved.srcObject) {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", saved.srcObject);
    }
  };
}

describe("ShotTool capture", () => {
  it("hands back raw PNG bytes for the modality to upload", async () => {
    const restore = stubCapture();
    try {
      const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
      let received: { thumb?: string; bytes?: Uint8Array } | undefined;
      const shots = new ShotTool(ink, (_rect, _components, thumb, bytes) => {
        received = { thumb, bytes };
      });
      await shots.shootViewport();
      expect(received?.bytes).toBeInstanceOf(Uint8Array);
      expect([...(received?.bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      ink.dispose();
      shots.dispose();
    } finally {
      restore();
    }
  });

  it("degrades to no pixels when capture is unavailable", async () => {
    const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
    let received: { bytes?: Uint8Array } | undefined;
    const shots = new ShotTool(ink, (_rect, _components, _thumb, bytes) => {
      received = { bytes };
    });
    // jsdom has no getDisplayMedia — the shot still fires, without bytes.
    await shots.shootViewport();
    expect(received?.bytes).toBeUndefined();
    ink.dispose();
    shots.dispose();
  });
});
