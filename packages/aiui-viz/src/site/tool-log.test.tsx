// @vitest-environment jsdom
/**
 * tool-log.test.tsx — the on-page tool log: hidden until opened, live over
 * the registry's call log, and its "as rendered" view is the same text the
 * consumers render.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { agentToolkit } from "../agent-tools";
import { ensureAiuiGlobal } from "../aiui-global";
import { renderToolBrief } from "../tool-brief";
import { ToolLog, toggleToolLog } from "./tool-log";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  toggleToolLog(false);
  document.body.innerHTML = "";
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = undefined;
  for (const key of Object.keys(window)) {
    if (key.startsWith("__")) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  }
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ToolLog", () => {
  it("renders nothing until opened, then lists calls with their caller", async () => {
    const kit = agentToolkit("lab", { brief: "A wave lab." });
    kit.registerTool({
      name: "set_freq",
      description: "set the frequency",
      usage: "trust the applied value",
      kind: "write",
      run: (args) => ({ applied: args?.value }),
    });
    dispose = render(() => <ToolLog />, document.body);
    expect(document.querySelector(".aiui-toollog")).toBeNull();

    toggleToolLog(true);
    await tick();
    expect(document.querySelector(".aiui-toollog")).not.toBeNull();

    await ensureAiuiGlobal()?.tools?.call("lab", "set_freq", { value: 3 }, { caller: "channel" });
    await tick();
    const row = document.querySelector(".aiui-toollog-call");
    expect(row?.textContent).toContain("channel");
    expect(row?.textContent).toContain("lab/set_freq");
    expect(row?.textContent).toContain('{"applied":3}');
  });

  it("the 'as rendered' view is renderToolBrief over the live registry", async () => {
    const kit = agentToolkit("lab", { brief: "A wave lab." });
    kit.registerTool({
      name: "set_freq",
      description: "set the frequency",
      usage: "trust the applied value",
      kind: "write",
      run: () => 0,
    });
    dispose = render(() => <ToolLog />, document.body);
    toggleToolLog(true);
    await tick();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>(".aiui-toollog-tab")];
    tabs.find((b) => b.textContent === "as rendered")?.click();
    await tick();
    const brief = document.querySelector(".aiui-toollog-brief")?.textContent;
    const expected = renderToolBrief([
      {
        ns: "lab",
        brief: "A wave lab.",
        tools: [
          {
            name: "set_freq",
            description: "set the frequency",
            usage: "trust the applied value",
            kind: "write",
          },
          { name: "report", description: "bounded snapshot of page state", kind: "read" },
        ],
      },
    ]);
    expect(brief).toBe(expected);
    expect(brief).toContain("A wave lab.");
    // The structured half never carries functions.
    expect(document.querySelector(".aiui-toollog-listing")?.textContent).not.toContain("run");
  });
});
