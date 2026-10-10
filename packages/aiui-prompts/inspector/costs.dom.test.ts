// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Elide, Image, Prompt, Section, snapshot, Text, Use } from "../src/index.ts";
import type { CompiledPrompt } from "../src/model.ts";
import { mountInspector } from "./view.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function action(root: HTMLElement, key: string): HTMLButtonElement {
  const element = [...root.querySelectorAll<HTMLButtonElement>("[data-action-key]")].find(
    (item) => item.dataset.actionKey === key,
  );
  if (!element) throw new Error(`Missing action ${key}`);
  return element;
}

function visibleCosts(root: HTMLElement) {
  return Object.fromEntries(
    [...root.querySelectorAll<HTMLElement>(".prompt-tree-cost")].map((item) => [
      item.dataset.costOccurrence,
      {
        text: item.textContent,
        units: item.dataset.codeUnits,
        images: item.dataset.images,
        title: item.title,
      },
    ]),
  );
}

describe("mounted occurrence cost badges", () => {
  it("shows inclusive and exclusive costs without changing them when content or outline folds", () => {
    const shared = Section({
      title: "Shared",
      children: Text({ value: "🧪α", label: "Shared leaf" }),
    });
    const record = snapshot(
      Prompt({
        label: "Root",
        children: [
          Use({ value: shared, key: "one", label: "First use" }),
          Use({ value: shared, key: "two", label: "Second use" }),
          Image({ asset: { id: "plot" }, label: "Plot" }),
          Elide({ unit: "characters", limit: 2, marker: "…", label: "Elision", children: "🧪αβγ" }),
        ],
      }),
    );
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountInspector(root, record);
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    const rootId = compiled.occurrences[0].id;
    const first = compiled.occurrences.find((item) => item.label === "First use");
    if (!first) throw new Error("Missing shared occurrence");
    const before = visibleCosts(root);
    expect(Object.keys(before).length).toBe(compiled.occurrences.length);
    expect(before[rootId]).toMatchObject({ text: "36 cu · 1 img", units: "36", images: "1" });
    expect(before[first.id].title).toContain("Subtree (inclusive): 13 UTF-16 code units");
    expect(before[first.id].title).toContain("Own (exclusive): 10 UTF-16 code units");
    expect(root.querySelector(".prompt-cost-legend")?.textContent).toContain(
      "Parent and child totals overlap",
    );
    expect(root.querySelector(".prompt-record-meta")?.textContent).toContain("tokens unknown");

    action(root, `select:${first.id}`).click();
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      "Own contribution (exclusive): 10 UTF-16 code units and 0 image placements",
    );
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      "Subtree (inclusive): 13 UTF-16 code units and 0 image placements",
    );
    action(root, `fold:${first.id}`).click();
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded: First use]");
    expect(visibleCosts(root)).toEqual(before);
    action(root, `outline:${rootId}`).click();
    expect(Object.keys(visibleCosts(root))).toEqual([rootId]);
    expect(visibleCosts(root)[rootId]).toEqual(before[rootId]);
    action(root, `outline:${rootId}`).click();
    expect(visibleCosts(root)).toEqual(before);
    expect(view.controller.state.contentFolded.has(first.id)).toBe(true);
    expect(view.controller.record).toEqual(record);
  });
});
