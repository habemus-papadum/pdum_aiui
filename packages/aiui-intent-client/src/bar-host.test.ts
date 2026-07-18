// @vitest-environment jsdom
/**
 * bar-host.test.ts — the intent client projected as a remote-bar host: only the
 * `remote`-flagged caps reach the wire, the register carries the channel port,
 * and an inbound tap dispatches into the one engine. The last assertion pins the
 * KNOWN GAP (plan's Security note): the filter is display-only, so a command
 * that is NOT a projected remote cap still dispatches — deferred, not fixed.
 */

import { decode, encode, type WireCap } from "@habemus-papadum/aiui-remote-bar";
import type { CapView } from "@habemus-papadum/aiui-viz/modal";
import { describe, expect, it } from "vitest";
import { type BarSocket, createBarHost, intentBarSource, isRemoteCap } from "./bar-host";
import { createIntentClient, type IntentClient, type IntentLanes } from "./client";
import { fakeBus } from "./fake-bus";

const noopLanes: IntentLanes = {
  openTurn: () => {},
  sendTurn: () => {},
  cancelTurn: () => {},
  takeShot: () => {},
  addSelection: () => {},
  clearPencil: () => {},
  startTalk: () => {},
  stopTalk: () => {},
  setMicMuted: () => {},
};

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

function makeClient(): IntentClient {
  return createIntentClient({ host: fakeBus({ activeTab: 7 }), lanes: noopLanes });
}

/** disarmed → armed → turn, the phase that reveals the turn-tier caps. */
function enterTurn(client: IntentClient): void {
  client.setContext({ connected: true });
  client.dispatch("arm");
  client.dispatch("turn");
}

/** The remote subset of the current projection, commands in order. */
function remoteCommands(client: IntentClient): string[] {
  return intentBarSource(client)
    .bar()
    .flatMap((row) => (row as unknown as { items: unknown[] }).items)
    .filter((it): it is CapView => (it as CapView).kind === "cap")
    .filter((cap) => isRemoteCap(cap as WireCap))
    .map((cap) => cap.command);
}

function fakeSocket() {
  const handlers: Record<string, Array<(e: { data?: unknown }) => void>> = {};
  const sent: string[] = [];
  let readyState = 0; // CONNECTING
  const fire = (type: string, e: { data?: unknown }): void => {
    for (const h of handlers[type] ?? []) {
      h(e);
    }
  };
  const socket: BarSocket = {
    get readyState() {
      return readyState;
    },
    send: (data) => sent.push(data),
    close: () => {
      readyState = 3;
      fire("close", {});
    },
    addEventListener: (type, h) => {
      handlers[type] ??= [];
      handlers[type]?.push(h);
    },
  };
  const bars = () =>
    sent
      .map((s) => decode(s))
      .filter((m): m is Extract<ReturnType<typeof decode>, { type: "bar" }> => m?.type === "bar");
  return {
    socket,
    sent,
    open: () => {
      readyState = 1; // OPEN
      fire("open", {});
    },
    message: (data: string) => fire("message", { data }),
    lastBar: () => bars().at(-1),
  };
}

describe("intentBarSource — the remote subset", () => {
  it("projects exactly the remote-flagged caps (hands-free, video, pencil) while in a turn", () => {
    const client = makeClient();
    enterTurn(client);
    expect(remoteCommands(client)).toEqual(["handsFree", "video", "pencil"]);
  });

  it("projects nothing remote outside a turn — the tier is not even revealed", () => {
    const client = makeClient();
    client.setContext({ connected: true });
    client.dispatch("arm"); // armed, not in a turn
    expect(remoteCommands(client)).toEqual([]);
  });
});

describe("createBarHost", () => {
  it("registers with the channel port on open and publishes only the remote caps", async () => {
    const client = makeClient();
    enterTurn(client);
    const fs = fakeSocket();
    createBarHost({
      client,
      port: 5099,
      label: "aiui intent — test",
      socketFactory: () => fs.socket,
    }).connect();
    fs.open();
    await settle();

    const register = decode(fs.sent[0]);
    expect(register).toEqual({
      type: "register",
      label: "aiui intent — test",
      channelPort: 5099,
    });
    expect(fs.lastBar()?.rows.map((r) => r.command)).toEqual(["handsFree", "video", "pencil"]);
  });

  it("routes an inbound remote tap into the one engine (single writer)", async () => {
    const client = makeClient();
    enterTurn(client);
    const fs = fakeSocket();
    createBarHost({
      client,
      port: 5099,
      label: "t",
      socketFactory: () => fs.socket,
    }).connect();
    fs.open();
    await settle();

    fs.message(encode({ type: "command", command: "handsFree" }));
    expect(client.state().talk).toBe("handsFree");
  });

  it("dispatches even a NON-projected command — the display-only gap (deferred, not fixed)", async () => {
    const client = makeClient();
    enterTurn(client);
    const fs = fakeSocket();
    createBarHost({
      client,
      port: 5099,
      label: "t",
      socketFactory: () => fs.socket,
    }).connect();
    fs.open();
    await settle();

    // `pencil` is a desktop-only cap — never in the remote projection — yet the
    // host has no membership check, so a socket that sends it still moves state.
    expect(client.state().pencil).not.toBe(true);
    fs.message(encode({ type: "command", command: "pencil" }));
    expect(client.state().pencil).toBe(true);
  });
});
