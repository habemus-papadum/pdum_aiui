// @vitest-environment jsdom
/**
 * prompt-record.test.tsx — a stored record, as a ledger holds it, previewed
 * by the toolkit's inspector loaded on demand: a real record (a preface and
 * a tool brief, the oracle's shape), through JSON, into the mounted preview.
 */
import { Prompt, snapshot, Text } from "@habemus-papadum/aiui-prompts";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { toolBrief } from "../tool-brief";
import { PromptRecordView } from "./prompt-record";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const until = async (ok: () => boolean, ms = 8000): Promise<void> => {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for the preview");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("PromptRecordView", () => {
  it("loads the inspector on demand and shows the record's text, attributed", async () => {
    const record = snapshot(
      Prompt({
        children: [
          Text({ value: "You are the lab." }),
          toolBrief([
            {
              ns: "app",
              brief: "A lab.",
              tools: [{ name: "report", description: "Read the state.", kind: "read" }],
            },
          ]),
        ],
      }),
    );
    // What a ledger holds: plain JSON, no live objects.
    const stored: unknown = JSON.parse(JSON.stringify(record));
    dispose = render(() => <PromptRecordView record={stored} initialView="text" />, document.body);
    const host = document.querySelector(".aiui-prompt-record") as HTMLElement;
    expect(host.dataset.promptTheme).toBe("aiui");
    expect(host.textContent).toContain("loading the prompt inspector");

    await until(() => document.querySelector(".prompt-inspector") !== null);
    // The inspector's stylesheets arrived as one injected <style>, once.
    expect(document.head.querySelectorAll("style[data-aiui-prompt-inspector]")).toHaveLength(1);
    await until(() => (document.querySelector(".prompt-raw")?.textContent ?? "") !== "");
    const raw = document.querySelector(".prompt-raw")?.textContent ?? "";
    expect(raw).toContain("You are the lab.");
    expect(raw).toContain("Tools:");
    expect(raw).toContain("- report: Read the state.");
    // The compact view carries its own controls — the host adds none.
    const labels = [...document.querySelectorAll(".prompt-inspector button")].map(
      (b) => b.textContent,
    );
    expect(labels).toContain("Markdown");
    expect(labels).toContain("Text");
    expect(labels).toContain("Open full inspector");
  });
});
