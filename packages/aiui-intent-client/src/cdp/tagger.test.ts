/**
 * The CDP tagger over a scripted browser: the channel plants its port into the
 * extension's storage THROUGH the debug endpoint — the write only lands in the
 * browser actually behind that endpoint, which is the whole point. These rows
 * pin the wire shape (find the worker, attach flat, evaluate the set, detach)
 * and the honest failures (no worker → no write, endpoint down → no write).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_ID } from "../ext/manifest";
import type { CdpSocket } from "./protocol";
import { CDP_CHANNEL_TAG_KEY, tagOnce } from "./tagger";

const BROWSER_URL = "http://127.0.0.1:9222";

interface SentCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A browser endpoint: answers `/json/version`, then scripts the CDP socket. */
function scriptedBrowser(results: Record<string, unknown> = {}) {
  const sent: SentCommand[] = [];
  const listeners = {
    message: [] as Array<(event: { data: unknown }) => void>,
    open: [] as Array<() => void>,
    close: [] as Array<() => void>,
    error: [] as Array<() => void>,
  };
  const socket: CdpSocket = {
    send: (data) => {
      const command = JSON.parse(data) as SentCommand;
      sent.push(command);
      queueMicrotask(() => {
        for (const handler of listeners.message) {
          handler({
            data: JSON.stringify({ id: command.id, result: results[command.method] ?? {} }),
          });
        }
      });
    },
    close: () => {
      for (const handler of listeners.close) {
        handler();
      }
    },
    addEventListener: (type: string, handler: never) => {
      (listeners[type as keyof typeof listeners] as unknown[]).push(handler);
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }),
    ),
  );
  return {
    // The open fires a microtask after the DIAL (tagOnce fetches first —
    // scheduling it at construction would beat the listener registration).
    factory: () => {
      queueMicrotask(() => {
        for (const handler of listeners.open) {
          handler();
        }
      });
      return socket;
    },
    sent,
  };
}

const WORKER_TARGETS = {
  "Target.getTargets": {
    targetInfos: [
      { targetId: "P1", type: "page", url: "https://example.com/" },
      {
        targetId: "SW1",
        type: "service_worker",
        url: `chrome-extension://${EXTENSION_ID}/sw.js`,
      },
    ],
  },
  "Target.attachToTarget": { sessionId: "S1" },
};

afterEach(() => vi.unstubAllGlobals());

describe("tagOnce", () => {
  it("finds the worker, attaches flat, and writes the tag in ITS context", async () => {
    const browser = scriptedBrowser(WORKER_TARGETS);
    expect(await tagOnce(BROWSER_URL, 5050, browser.factory)).toBe(true);

    const attach = browser.sent.find((c) => c.method === "Target.attachToTarget");
    expect(attach?.params).toMatchObject({ targetId: "SW1", flatten: true });

    const evaluate = browser.sent.find((c) => c.method === "Runtime.evaluate");
    expect(evaluate?.sessionId).toBe("S1"); // the WORKER's session, not the browser's
    const expression = String(evaluate?.params.expression);
    expect(expression).toContain("chrome.storage.local.set");
    expect(expression).toContain(CDP_CHANNEL_TAG_KEY);
    expect(expression).toContain('"port":5050');
    expect(expression).toContain(BROWSER_URL);

    // And it lets go: the debugger stays un-attached between tags.
    expect(browser.sent.some((c) => c.method === "Target.detachFromTarget")).toBe(true);
  });

  it("no extension worker among the targets → no write, honest false", async () => {
    const browser = scriptedBrowser({
      "Target.getTargets": {
        targetInfos: [{ targetId: "P1", type: "page", url: "https://example.com/" }],
      },
    });
    expect(await tagOnce(BROWSER_URL, 5050, browser.factory)).toBe(false);
    expect(browser.sent.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  });

  it("someone ELSE's worker never gets tagged — the id is the filter", async () => {
    const browser = scriptedBrowser({
      "Target.getTargets": {
        targetInfos: [
          {
            targetId: "SW9",
            type: "service_worker",
            url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sw.js",
          },
        ],
      },
    });
    expect(await tagOnce(BROWSER_URL, 5050, browser.factory)).toBe(false);
    expect(browser.sent.some((c) => c.method === "Target.attachToTarget")).toBe(false);
  });

  it("endpoint down → false, no dial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const dialed = vi.fn();
    expect(await tagOnce(BROWSER_URL, 5050, dialed as never)).toBe(false);
    expect(dialed).not.toHaveBeenCalled();
  });
});
