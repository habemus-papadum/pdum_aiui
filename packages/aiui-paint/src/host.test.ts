// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyIntent,
  type FrameSource,
  hostWsUrl,
  type InkSink,
  inkSurfaceSink,
  type NavHandlers,
  type RemoteInkTarget,
  startPaintHost,
} from "./host";
import type { CaptureState, PaintIntent } from "./protocol";

/** An InkSink that records the calls it receives, sized 200×100. */
function recordingSink(): InkSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setArmed: (on) => calls.push(`armed:${on}`),
    beginStroke: (id, style, p) =>
      calls.push(`begin:${id}:${style.color}/${style.width}:${p.x},${p.y}:${p.pressure ?? "-"}`),
    extendStroke: (id, p) => calls.push(`ext:${id}:${p.x},${p.y}`),
    endStroke: (id, p) => calls.push(`end:${id}:${p ? `${p.x},${p.y}` : "-"}`),
    cancelStroke: (id) => calls.push(`cancel:${id}`),
    size: () => ({ width: 200, height: 100 }),
  };
}

const nav = (calls: string[]): NavHandlers => ({
  scroll: (du, dv) => calls.push(`scroll:${du},${dv}`),
  zoom: (cu, cv, s) => calls.push(`zoom:${cu},${cv},${s}`),
});

describe("applyIntent", () => {
  it("maps stroke intents from normalized to sink pixels", () => {
    const sink = recordingSink();
    const begin: PaintIntent = {
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      style: { color: "#f00", width: 3 },
      point: { u: 0.5, v: 0.5, pressure: 0.8 },
    };
    applyIntent(begin, sink, nav([]));
    applyIntent({ type: "strokePoints", id: "s1", points: [{ u: 0.25, v: 1 }] }, sink, nav([]));
    applyIntent({ type: "strokeEnd", id: "s1", point: { u: 1, v: 0 } }, sink, nav([]));

    expect(sink.calls).toEqual(["begin:s1:#f00/3:100,50:0.8", "ext:s1:50,100", "end:s1:200,0"]);
  });

  it("ends without a point and cancels", () => {
    const sink = recordingSink();
    applyIntent({ type: "strokeEnd", id: "s1" }, sink, nav([]));
    applyIntent({ type: "strokeCancel", id: "s1" }, sink, nav([]));
    expect(sink.calls).toEqual(["end:s1:-", "cancel:s1"]);
  });

  it("routes arm and navigation intents", () => {
    const sink = recordingSink();
    const navCalls: string[] = [];
    const handlers = nav(navCalls);
    applyIntent({ type: "setArmed", armed: true }, sink, handlers);
    applyIntent({ type: "scroll", du: 0, dv: 0.5 }, sink, handlers);
    applyIntent({ type: "zoom", centerU: 0.5, centerV: 0.5, scale: 1.2 }, sink, handlers);
    expect(sink.calls).toEqual(["armed:true"]);
    expect(navCalls).toEqual(["scroll:0,0.5", "zoom:0.5,0.5,1.2"]);
  });
});

describe("inkSurfaceSink", () => {
  const target = (): RemoteInkTarget & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      remoteBegin: (id) => calls.push(`begin:${id}`),
      remotePoint: (id) => calls.push(`point:${id}`),
      remoteEnd: (id) => calls.push(`end:${id}`),
      remoteCancel: (id) => calls.push(`cancel:${id}`),
      size: () => ({ width: 10, height: 10 }),
    };
  };

  it("drops stroke starts until armed", () => {
    const surface = target();
    const sink = inkSurfaceSink(surface);
    sink.beginStroke("a", { color: "#000", width: 1 }, { x: 0, y: 0 });
    expect(surface.calls).toEqual([]);
    sink.setArmed(true);
    sink.beginStroke("b", { color: "#000", width: 1 }, { x: 0, y: 0 });
    expect(surface.calls).toEqual(["begin:b"]);
  });

  it("forwards extend/end/cancel and size", () => {
    const surface = target();
    const sink = inkSurfaceSink(surface, true);
    sink.beginStroke("a", { color: "#000", width: 1 }, { x: 0, y: 0 });
    sink.extendStroke("a", { x: 1, y: 1 });
    sink.endStroke("a");
    expect(surface.calls).toEqual(["begin:a", "point:a", "end:a"]);
    expect(sink.size()).toEqual({ width: 10, height: 10 });
  });
});

describe("hostWsUrl", () => {
  it("derives ws://…/host from an http base and strips path/query", () => {
    expect(hostWsUrl("http://mac.local:8788/foo?x=1")).toBe("ws://mac.local:8788/host");
  });
  it("upgrades to wss for https/wss", () => {
    expect(hostWsUrl("https://mac.local:8788")).toBe("wss://mac.local:8788/host");
    expect(hostWsUrl("wss://mac.local")).toBe("wss://mac.local/host");
  });
});

/** A fake browser WebSocket the host drives; records what it sent, injects messages. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  binaryType = "";
  sentJson: Array<Record<string, unknown>> = [];
  sentBinary = 0;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(fn);
  }
  send(data: unknown): void {
    if (typeof data === "string") {
      this.sentJson.push(JSON.parse(data));
    } else {
      this.sentBinary++;
    }
  }
  close(): void {
    this.fire("close");
  }
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev);
    }
  }
  fireMessage(obj: unknown): void {
    this.fire("message", { data: JSON.stringify(obj) });
  }
  has(pred: (m: Record<string, unknown>) => boolean): boolean {
    return this.sentJson.some(pred);
  }
}

/** A frame source that hands back a scripted sequence of capture states. */
function scriptedSource(states: CaptureState[]): FrameSource {
  let i = 0;
  return {
    start: async () => states[Math.min(i++, states.length - 1)],
    capture: async () => new Uint8Array([1, 2, 3]),
    stop: () => {},
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("startPaintHost capture handshake", () => {
  it("reports needsGesture on join, then goes active after requestCapture", async () => {
    FakeSocket.instances = [];
    const host = startPaintHost({
      relayUrl: "http://mac.local:8788",
      ink: recordingSink(),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      frameSource: scriptedSource(["needsGesture", "active"]),
      video: "jpeg",
    });
    const sock = FakeSocket.instances[0];
    sock.fire("open");
    expect(sock.has((m) => m.type === "register")).toBe(true);

    // A viewer joins. getDisplayMedia would need a gesture, so capture reports
    // needsGesture, the host tells the room, and it sends NO frames.
    sock.fireMessage({ type: "clientJoined", client: "c1" });
    await flush();
    expect(host.viewers()).toBe(1);
    expect(host.captureState()).toBe("needsGesture");
    expect(sock.has((m) => m.type === "videoStatus" && m.state === "needsGesture")).toBe(true);
    expect(sock.sentBinary).toBe(0);

    // The user clicks "Share screen" → requestCapture arms it → active.
    const result = await host.requestCapture();
    expect(result).toBe("active");
    expect(host.captureState()).toBe("active");
    expect(sock.has((m) => m.type === "videoStatus" && m.state === "active")).toBe(true);

    host.close();
    expect(host.captureState()).toBe("idle");
  });
});
