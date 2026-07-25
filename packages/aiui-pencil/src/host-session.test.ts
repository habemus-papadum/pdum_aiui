/**
 * host-session.test.ts — the relay-facing half of HostSession over a stubbed
 * WebSocket: what `register` announces (label, name, presentation), that the
 * plane rides every `videoStatus` push (the HUD's host-side number), and that
 * `setName` re-registers live. The WebRTC half stays untested here (it needs
 * a browser); the wire framing is the part worth pinning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostSession } from "./host-session";
import { decode, type WireMessage } from "./protocol";
import type { PencilSurface } from "./surface";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, Array<(event: unknown) => void>> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers[type] ??= [];
    this.handlers[type]?.push(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    for (const h of this.handlers.close ?? []) {
      h({});
    }
  }
  open(): void {
    this.readyState = 1;
    for (const h of this.handlers.open ?? []) {
      h({});
    }
  }
  frames(): WireMessage[] {
    return this.sent.map((s) => decode(s)).filter((m): m is WireMessage => m !== undefined);
  }
}

const surface = { size: () => ({ width: 640, height: 360 }) } as unknown as PencilSurface;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HostSession wire framing", () => {
  it("registers with label + name, and pushes videoStatus carrying the plane", () => {
    let stream: MediaStream | undefined;
    const session = new HostSession({
      url: "ws://127.0.0.1:0/pencil/host",
      label: "aiui intent — window 3",
      name: "courageous-beaver",
      surface: () => surface,
      size: () => ({ width: 1440, height: 812 }),
      stream: () => stream,
      streamHint: () => "grant the tab first",
      log: () => {},
    });
    session.connect();
    const ws = FakeWebSocket.instances.at(-1);
    if (ws === undefined) {
      throw new Error("no socket dialed");
    }
    ws.open();

    const [register, status] = ws.frames();
    expect(register).toMatchObject({
      type: "register",
      label: "aiui intent — window 3",
      name: "courageous-beaver",
    });
    expect(status).toEqual({
      type: "videoStatus",
      state: "needsGesture",
      plane: { width: 1440, height: 812 },
      detail: "grant the tab first",
    });

    // The stream warming + refresh() → an ACTIVE status, plane still riding.
    stream = { getTracks: () => [] } as unknown as MediaStream;
    session.refresh();
    expect(ws.frames().at(-1)).toEqual({
      type: "videoStatus",
      state: "active",
      plane: { width: 1440, height: 812 },
    });
    session.dispose();
  });

  it("setName re-registers live; without an explicit size the surface's plane rides", () => {
    const session = new HostSession({
      url: "ws://127.0.0.1:0/pencil/host",
      label: "lab",
      surface: () => surface,
      stream: () => undefined,
      log: () => {},
    });
    session.connect();
    const ws = FakeWebSocket.instances.at(-1);
    if (ws === undefined) {
      throw new Error("no socket dialed");
    }
    ws.open();

    expect(ws.frames()[0]).toEqual({ type: "register", label: "lab" });
    expect(ws.frames()[1]).toMatchObject({ plane: { width: 640, height: 360 } });

    session.setName("solemn-otter");
    expect(ws.frames().at(-1)).toEqual({ type: "register", label: "lab", name: "solemn-otter" });

    // announce() re-pushes videoStatus (the plane rider) without re-offering.
    session.announce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: "videoStatus",
      plane: { width: 640, height: 360 },
    });
    session.dispose();
  });
});
