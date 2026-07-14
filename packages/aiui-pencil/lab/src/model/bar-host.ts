/**
 * bar-host.ts — the Lab's command bar, projected to remotes over the bar
 * channel (D5).
 *
 * The Lab has no mode engine — its verbs are plain `action()`s and controls —
 * and that is exactly why this file is a useful reference: `bindRemoteBar`'s
 * `BarSource` is **structural**, so any page can project a bar by answering
 * four questions (rows? claims? phase? dispatch?). An intent-client page will
 * answer them from its `solidModeEngine`; the Lab answers them from its store.
 * The remote taps are indistinguishable from local clicks downstream, because
 * dispatch lands on the very same actions.
 */

import type { Tool } from "@habemus-papadum/aiui-pencil";
import {
  type BarSource,
  bindRemoteBar,
  decode,
  encode,
  type WireCap,
} from "@habemus-papadum/aiui-remote-bar";
import { clearAnimated, clearStrokes, undo } from "./graph";
import { share, tool } from "./store";

const RECONNECT_MS = 2000;

/** The Lab's bar: the instrument's verbs, lit from the live controls. */
const source: BarSource = {
  bar(): WireCap[] {
    const t = tool.get();
    return [
      {
        kind: "cap",
        command: "tool.draw",
        hint: { key: "d", label: "draw", icon: "✏️" },
        lit: t === "draw",
        enabled: true,
      },
      {
        kind: "cap",
        command: "tool.erase",
        hint: { key: "e", label: "erase", icon: "◻️" },
        lit: t === "erase",
        enabled: true,
      },
      {
        kind: "cap",
        command: "ink.undo",
        hint: { key: "z", label: "undo", icon: "↩" },
        lit: false,
        enabled: true,
      },
      {
        kind: "cap",
        command: "ink.clear",
        hint: { key: "c", label: "clear", icon: "✕" },
        lit: false,
        enabled: true,
      },
      {
        kind: "cap",
        command: "ink.clearAnimated",
        hint: { key: "C", label: "clear ✨" },
        lit: false,
        enabled: true,
      },
    ];
  },
  claimStatuses() {
    return {};
  },
  state() {
    return { phase: share.get() };
  },
  dispatch(command: string) {
    switch (command) {
      case "tool.draw":
        return tool.set("draw" as Tool);
      case "tool.erase":
        return tool.set("erase" as Tool);
      case "ink.undo":
        return undo.run?.();
      case "ink.clear":
        return clearStrokes.run?.();
      case "ink.clearAnimated":
        return clearAnimated.run?.();
      default:
        return undefined;
    }
  },
};

/** Dial the bar relay (same origin) and keep the projection published. */
export function connectBarHost(): () => void {
  let ws: WebSocket | undefined;
  let unbind: (() => void) | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const dial = (): void => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/bar/host`);
    const socket = ws;

    socket.addEventListener("open", () => {
      socket.send(encode({ type: "register", label: "pencil-lab" }));
      // Bind AFTER open: bindRemoteBar publishes once immediately (the relay
      // caches it for join-time replay), and a publish into a CONNECTING socket
      // is silently dropped.
      const bound = bindRemoteBar(source, {
        send: (message) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(encode(message));
          }
        },
      });
      unbind = () => bound.dispose();
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const message = decode(event.data);
        if (message) {
          bound.host.receive(message as never);
        }
      });
    });

    socket.addEventListener("close", () => {
      unbind?.();
      unbind = undefined;
      if (!stopped) {
        reconnect = setTimeout(dial, RECONNECT_MS);
      }
    });
    socket.addEventListener("error", () => socket.close());
  };

  dial();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    unbind?.();
    ws?.close();
  };
}
