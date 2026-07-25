/**
 * client-session.test.ts — the relay-facing half of ClientSession over a
 * stubbed WebSocket: the redial contract ("lost" must not be terminal — the
 * old single-shot socket stranded the iPad until a page reload). The WebRTC
 * half stays untested here (it needs a browser).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "./client-session";
import type { Surface } from "./protocol";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  private handlers: Record<string, Array<(event: unknown) => void>> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers[type] ??= [];
    this.handlers[type]?.push(handler);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    for (const h of this.handlers.close ?? []) {
      h({});
    }
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const PLANE: Surface = { width: 100, height: 100 };

function makeSession(onClose?: () => void): ClientSession {
  return new ClientSession({
    url: "ws://127.0.0.1:0/pencil/client",
    surface: () => PLANE,
    tool: () => "draw",
    mode: () => "write",
    video: () => undefined,
    ...(onClose !== undefined ? { onClose } : {}),
    log: () => {},
  });
}

describe("ClientSession redial", () => {
  it("redials after a socket drop, and stops once disposed", () => {
    let closes = 0;
    const session = makeSession(() => {
      closes += 1;
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The relay drops (channel restart, Wi-Fi roam): onClose still fires
    // (the app shows "lost"), and a fresh socket dials after the backoff.
    FakeWebSocket.instances[0].close();
    expect(closes).toBe(1);
    vi.advanceTimersByTime(2100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Disposal is the one terminal state: no further dial.
    session.dispose();
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
