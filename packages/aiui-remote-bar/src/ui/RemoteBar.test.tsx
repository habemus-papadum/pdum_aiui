// @vitest-environment jsdom
/**
 * RemoteBar.test.tsx — the remote's DOM as a projection: drive the client through
 * a FAKE wire (no real WebSocket — jsdom has none) and assert the rendered truth,
 * plus what the taps put back on the wire. Mirrors intent-client's panel.test.tsx.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientToRelay, RelayToClient } from "../protocol";
import type { BarTransportFactory, BarTransportHandlers } from "./client";
import { createRemoteBarClient, type RemoteBarClient } from "./client";
import { RemoteBar } from "./RemoteBar";

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

/** A fake wire: captures outbound frames, delivers inbound on the test's command. */
function fakeWire() {
  const outbound: ClientToRelay[] = [];
  let handlers: BarTransportHandlers | undefined;
  const factory: BarTransportFactory = (_url, h) => {
    handlers = h;
    return { send: (m) => outbound.push(m), close: () => {} };
  };
  return {
    factory,
    outbound,
    open: () => handlers?.onOpen(),
    emit: (m: RelayToClient) => handlers?.onMessage(m),
    dropWire: () => handlers?.onClose(),
  };
}

interface Mounted {
  client: RemoteBarClient;
  wire: ReturnType<typeof fakeWire>;
  root: HTMLElement;
  dispose: () => void;
}

let mounted: Mounted | undefined;

function mount(options: { autoJoin?: boolean } = {}): Mounted {
  const wire = fakeWire();
  const client = createRemoteBarClient({
    url: "ws://test/bar/client",
    transport: wire.factory,
    ...(options.autoJoin !== undefined ? { autoJoin: options.autoJoin } : {}),
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(() => <RemoteBar client={client} />, root);
  mounted = {
    client,
    wire,
    root,
    dispose: () => {
      dispose();
      root.remove();
    },
  };
  return mounted;
}

afterEach(() => {
  mounted?.dispose();
  mounted?.client.dispose();
  mounted = undefined;
});

const q = (root: HTMLElement, sel: string) => root.querySelector(sel);
const text = (root: HTMLElement, testid: string): string =>
  root.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";

const oneHost: RelayToClient = {
  type: "sessions",
  sessions: [{ id: "host-1", label: "my app", busy: false, connectedAt: "2026-07-14T00:00:00Z" }],
};

describe("the remote bar is a projection", () => {
  it("waits for a host, then lists what the relay advertises", async () => {
    const m = mount({ autoJoin: false });
    m.wire.open();
    await settle();
    expect(text(m.root, "empty")).toContain("Waiting");

    m.wire.emit(oneHost);
    await settle();
    expect(m.root.querySelector('[data-host="host-1"]')?.textContent).toContain("my app");
  });

  it("auto-joins the sole host and renders its projected bar", async () => {
    const m = mount(); // autoJoin default on
    m.wire.open();
    m.wire.emit(oneHost);
    await settle();
    // It sent a join for the one host…
    expect(m.wire.outbound).toContainEqual({ type: "join", host: "host-1" });

    m.wire.emit({ type: "joined", host: "host-1", label: "my app" });
    m.wire.emit({
      type: "bar",
      rows: [
        { kind: "cap", command: "ink", hint: { key: "i", label: "ink" }, lit: true, enabled: true },
        {
          kind: "cap",
          command: "send",
          hint: { key: "↵", label: "send" },
          lit: false,
          enabled: false,
        },
      ],
      claims: { ring: "active" },
      phase: "turn",
    });
    await settle();

    expect(text(m.root, "phase-pill")).toBe("turn");
    const ink = m.root.querySelector('[data-command="ink"]');
    expect(ink?.getAttribute("data-lit")).toBe("true");
    const send = m.root.querySelector<HTMLButtonElement>('[data-command="send"]');
    expect(send?.disabled).toBe(true); // enabled:false → refuses taps
    expect(m.root.querySelector('[data-claim="ring"]')?.getAttribute("data-phase")).toBe("active");
  });

  it("a cap tap sends the same command up the wire", async () => {
    const m = mount();
    m.wire.open();
    m.wire.emit(oneHost);
    m.wire.emit({ type: "joined", host: "host-1", label: "my app" });
    m.wire.emit({
      type: "bar",
      rows: [
        {
          kind: "cap",
          command: "ink",
          payload: { on: true },
          hint: { key: "i", label: "ink" },
          lit: false,
          enabled: true,
        },
      ],
      claims: {},
    });
    await settle();

    m.root.querySelector<HTMLButtonElement>('[data-command="ink"]')?.click();
    await settle();
    expect(m.wire.outbound).toContainEqual({
      type: "command",
      command: "ink",
      payload: { on: true },
    });
  });

  it("shows the host-gone state visibly", async () => {
    const m = mount();
    m.wire.open();
    m.wire.emit(oneHost);
    m.wire.emit({ type: "joined", host: "host-1", label: "my app" });
    await settle();
    expect(q(m.root, '[data-testid="joined"]')).not.toBeNull();

    m.wire.emit({ type: "hostGone" });
    await settle();
    expect(q(m.root, '[data-testid="joined"]')).toBeNull();
    expect(text(m.root, "host-gone")).toContain("disconnected");
  });

  it("shows a rejected join with its reason", async () => {
    const m = mount({ autoJoin: false });
    m.wire.open();
    m.wire.emit(oneHost);
    await settle();
    m.client.join("host-1");
    m.wire.emit({ type: "joinRejected", reason: "host not found" });
    await settle();
    expect(text(m.root, "rejected")).toContain("host not found");
  });
});
