// @vitest-environment jsdom
/**
 * content-main.test.ts — the tools bridge's PAGE half.
 *
 * One rule, and it is the one that was missing (found live 2026-07-30): a page
 * reports its tools once at injection and then only on change, so a panel that
 * opens — or reloads — later must be able to ASK. Without that, an
 * instrumented page shows the `aiui` pill, serves the ring, and answers
 * screenshots, while its tools are invisible to both the panel's oracle and
 * the channel's tool directory. The isolated world cannot read `__AIUI__`, so
 * the request crosses on a postMessage; this pins that it is honored.
 *
 * The script is imported ONCE, like the single injection it models: importing
 * per test would stack a fresh `message` listener on the same jsdom window and
 * make every count a lie.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Registration {
  ns: string;
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
}

/** What the page half reads off `__AIUI__.tools`; `entries` is per-test. */
let entries: Registration[] = [];
const listeners = new Set<() => void>();

/** Every `aiuiTools` announcement posted to the isolated world, in order. */
const announcements: Registration[][] = [];

/**
 * Deliver a message the way the ISOLATED world does — with `source` set to
 * this window, because the page half guards on exactly that (a message from an
 * iframe is not the panel talking). jsdom's own `postMessage` leaves `source`
 * null, which would skip the guard and test nothing.
 */
const post = (data: unknown): void => {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
};
const refresh = (): void => post({ aiuiToolsRefresh: true });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = {
    v: 1,
    tools: {
      register: () => {},
      list: () => entries,
      call: () => Promise.resolve(undefined),
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  window.addEventListener("message", (event: MessageEvent) => {
    const tools = (event.data as { aiuiTools?: Registration[] } | null)?.aiuiTools;
    if (tools !== undefined) {
      announcements.push(tools);
    }
  });
  await import("./content-main"); // importing IS the injection
  await settle();
});

beforeEach(() => {
  entries = [{ ns: "testapp", tools: [{ name: "reseed", description: "new seed" }] }];
  announcements.length = 0;
});

describe("the tools bridge's page half", () => {
  it("RE-ANNOUNCES on request — what a late or reloaded panel depends on", async () => {
    // This is the isolated world's `sayHello` asking. Before the fix nothing
    // listened, so a panel that had not been present at injection never
    // learned the page had tools at all.
    refresh();
    await settle();
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.[0]?.tools.map((t) => t.name)).toEqual(["reseed"]);
  });

  it("re-announces the CURRENT set, not the one it first saw", async () => {
    entries = [
      {
        ns: "testapp",
        tools: [
          { name: "reseed", description: "new seed" },
          { name: "report", description: "read state" },
        ],
      },
    ];
    refresh();
    await settle();
    expect(announcements.at(-1)?.[0]?.tools.map((t) => t.name)).toEqual(["reseed", "report"]);
  });

  it("still relays a registry CHANGE on its own — the refresh is an addition", async () => {
    entries = [{ ns: "testapp", tools: [{ name: "kick", description: "kick it" }] }];
    for (const listener of listeners) {
      listener();
    }
    await settle();
    expect(announcements.at(-1)?.[0]?.tools.map((t) => t.name)).toEqual(["kick"]);
  });

  it("ignores messages that are not a refresh request", async () => {
    post({ somethingElse: true });
    post({ aiuiToolsRefresh: false });
    await settle();
    expect(announcements).toHaveLength(0);
  });
});
