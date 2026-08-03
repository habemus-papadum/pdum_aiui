// @vitest-environment jsdom
/**
 * oracle-tools.test.ts — the oracle's panel and file tool groups (O3c). What
 * is worth pinning here is the PERMISSION shape: declared per cap, absent
 * means no, and refusals come back as readable answers rather than throws
 * (the vendor gives tools no error channel).
 */

import { disposeDurable } from "@habemus-papadum/aiui-viz";
import { afterEach, describe, expect, it } from "vitest";
import { intentBar } from "../caps";
import { createIntentClient, type IntentClient } from "../client";
import { fakeBus } from "../fake-bus";
import { intentSpec } from "../spec";
import { resolveToolTab } from "./oracle";
import { fileTools, panelTools } from "./oracle-tools";

let client: IntentClient | undefined;

const armed = (): IntentClient => {
  const c = createIntentClient({
    host: fakeBus({ activeTab: 7, grantless: true }),
    lanes: {
      openTurn: () => {},
      sendTurn: () => {},
      cancelTurn: () => {},
      takeShot: () => {},
      addSelection: () => {},
      clearPencil: () => {},
      startTalk: () => {},
      stopTalk: () => {},
      setMicMuted: () => {},
    },
  });
  c.setContext({ connected: true, micGranted: true });
  client = c;
  return c;
};

afterEach(async () => {
  await client?.dispose();
  client = undefined;
  for (const region of Object.keys(intentSpec.regions)) {
    disposeDurable(`mode:${region}`);
  }
});

/** Every cap in the declaration, flattened, with its oracle flag. */
const allCaps = (): Array<{ command: string; oracle: boolean }> => {
  const out: Array<{ command: string; oracle: boolean }> = [];
  const walk = (nodes: readonly (typeof intentBar)[number][]): void => {
    for (const node of nodes) {
      if (node.kind === "widget") {
        continue;
      }
      out.push({ command: node.command, oracle: node.oracle === true });
      if (node.children !== undefined) {
        walk(node.children as readonly (typeof intentBar)[number][]);
      }
    }
  };
  walk(intentBar);
  return out;
};

describe("the oracle cap flag — declared, absent means no", () => {
  it("the three forbidden families carry NO flag", () => {
    const flagged = new Set(
      allCaps()
        .filter((c) => c.oracle)
        .map((c) => c.command),
    );
    // The turn's lifecycle: sending is irreversible and outward-facing; the
    // others discard or duplicate what taking the sink already did.
    for (const command of ["send", "turn", "cancelTurn", "pause"]) {
      expect(flagged.has(command), `${command} must not be oracle-pressable`).toBe(false);
    }
    // The ladder: each would end the session that is asking.
    for (const command of ["arm", "disarm", "escape", "oracle"]) {
      expect(flagged.has(command), `${command} must not be oracle-pressable`).toBe(false);
    }
    // Its own hearing: the mic is the user's, and a model that can gate its
    // own input can lock itself out of the instruction that restores it.
    for (const command of ["handsFree", "mute", "talkPress", "oraclePark"]) {
      expect(flagged.has(command), `${command} must not be oracle-pressable`).toBe(false);
    }
  });

  it("the page/markup/source acts DO carry it", () => {
    const flagged = new Set(
      allCaps()
        .filter((c) => c.oracle)
        .map((c) => c.command),
    );
    for (const command of ["shot", "region", "selection", "jump", "video", "pencil"]) {
      expect(flagged.has(command), `${command} should be oracle-pressable`).toBe(true);
    }
  });
});

describe("panel_bar_list / panel_bar_dispatch", () => {
  it("lists the caps with their live enablement and what may be pressed", async () => {
    const c = armed();
    const [list] = panelTools(c);
    const rows = (await list?.execute({})) as Array<Record<string, unknown>>;
    const turn = rows.find((r) => r.command === "turn");
    expect(turn).toMatchObject({ label: "turn", enabled: true, engaged: false });
    // The refusal is ADVERTISED, so the oracle explains instead of trying.
    expect(turn?.youMayPress).toBe(false);
    expect(rows.find((r) => r.command === "pencil")?.youMayPress).toBe(true);
  });

  it("presses an allowed cap, and the machine's own gate still applies", async () => {
    const c = armed();
    const [, dispatch] = panelTools(c);
    expect(await dispatch?.execute({ command: "pencil" })).toEqual({
      ok: true,
      pressed: "pencil",
    });
    expect(c.state().pencil).toBe(true);

    // `jump` carries the flag but needs an instrumented page — the machine
    // refuses it right now, and that is a DIFFERENT refusal from "never".
    const notNow = (await dispatch?.execute({ command: "jump" })) as { refused?: string };
    expect(notNow.refused).toContain("not available right now");
    expect(c.state().jump).toBe(false);
  });

  it("refuses a forbidden cap in words, and does NOT dispatch it", async () => {
    const c = armed();
    c.dispatch("turn"); // open a turn so `send` would otherwise be available
    const [, dispatch] = panelTools(c);
    expect(c.canDispatch("send")).toBe(true); // the machine would allow it…
    const refused = (await dispatch?.execute({ command: "send" })) as { refused?: string };
    expect(refused.refused).toContain("not a control the oracle may press");
    expect(c.state().phase).toBe("turn"); // …and it did not happen
  });

  it("an unknown command is refused the same way — never a throw", async () => {
    const c = armed();
    const [, dispatch] = panelTools(c);
    const refused = (await dispatch?.execute({ command: "nonsense" })) as { refused?: string };
    expect(refused.refused).toContain("not a control");
  });
});

describe("the file tools", () => {
  it("POST the sidecar's one route and hand the model the content", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const tools = fileTools({
      port: () => 5555,
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true, content: "found it", summary: "1" }) };
      }) as never,
    });
    expect(tools.map((t) => t.name)).toEqual(["read_file", "list_files", "grep"]);

    const grep = tools.find((t) => t.name === "grep");
    expect(await grep?.execute({ pattern: "freq" })).toEqual({ ok: true, result: "found it" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:5555/intent/oracle/tool");
    expect(calls[0]?.body).toEqual({ tool: "grep", args: { pattern: "freq" } });
  });

  it("a channel that refuses answers IN BAND — a throw would be opaque to the model", async () => {
    const tools = fileTools({
      port: () => 5555,
      fetchImpl: (async () => ({ ok: false, status: 503 })) as never,
    });
    const read = tools.find((t) => t.name === "read_file");
    const outcome = (await read?.execute({ path: "x.ts" })) as { ok: boolean; result: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toContain("503");
  });

  it("goes same-origin when the channel serves the panel", async () => {
    const calls: string[] = [];
    const tools = fileTools({
      port: () => undefined,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return { ok: true, json: async () => ({ ok: true, content: "", summary: "" }) };
      }) as never,
    });
    await tools[0]?.execute({ path: "a" });
    expect(calls[0]).toBe("/intent/oracle/tool");
  });
});

describe("resolveToolTab — the eye, else the last app (owner, 2026-07-30)", () => {
  const registry = (byTab: Record<number, number>) =>
    ({
      toolsFor: (tab?: number) =>
        tab !== undefined && (byTab[tab] ?? 0) > 0
          ? [
              {
                ns: "app",
                tools: Array.from({ length: byTab[tab] as number }, () => ({
                  name: "t",
                  description: "",
                })),
              },
            ]
          : [],
    }) as never;

  it("prefers the tab in view when it has tools", () => {
    expect(resolveToolTab(registry({ 7: 2, 9: 1 }), 9, 7)).toBe(9);
  });

  it("falls back to the remembered app when the eye is elsewhere", () => {
    // The console, a doc, chrome://extensions — none of them an app.
    expect(resolveToolTab(registry({ 7: 2 }), 99, 7)).toBe(7);
  });

  it("drops a remembered tab that no longer has tools", () => {
    expect(resolveToolTab(registry({}), 99, 7)).toBeUndefined();
  });

  it("has nothing to offer before any app has been seen", () => {
    expect(resolveToolTab(registry({}), 99, undefined)).toBeUndefined();
    expect(resolveToolTab(registry({}), undefined, undefined)).toBeUndefined();
  });

  it("PARKED namespaces don't count — the oracle's surface is route-following", () => {
    // A tab whose only namespaces are parked (a gallery notebook off-route)
    // reads as toolless: the projection withholds it and the resolution falls
    // through to the remembered app (docs/proposals/page-tools.md).
    const parked = {
      toolsFor: (tab?: number) =>
        tab === 9
          ? [{ ns: "aztec", active: false, tools: [{ name: "regrow", description: "" }] }]
          : tab === 7
            ? [{ ns: "gears", active: true, tools: [{ name: "reset", description: "" }] }]
            : [],
    } as never;
    expect(resolveToolTab(parked, 9, 7)).toBe(7); // the eye's tab is all-parked
  });
});
