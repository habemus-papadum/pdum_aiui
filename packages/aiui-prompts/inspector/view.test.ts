// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  Math as Formula,
  Group,
  Image,
  Prompt,
  rehydrate,
  Section,
  snapshot,
  Text,
  Use,
  Xml,
} from "../src/index.ts";
import type { CompiledPrompt } from "../src/model.ts";
import {
  delegationRecord,
  exampleRecord,
  laboratoryTools,
  markerSidecarRecord,
  textOnlyPrompt,
} from "./bench/fixtures.ts";
import { canonicalText } from "./state.ts";
import { mountComparison, mountInspector } from "./view.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function host() {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}

function getButton(root: HTMLElement, text: string): HTMLButtonElement {
  const result = [...root.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

function byLabel(compiled: CompiledPrompt, label: string) {
  const result = compiled.occurrences.find((item) => item.label === label);
  if (!result) throw new Error(`Missing occurrence label: ${label}`);
  return result;
}

function clickAction(root: HTMLElement, key: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("[data-action-key]")].find(
    (node) => node.dataset.actionKey === key,
  );
  if (!button) throw new Error(`Missing action: ${key}`);
  button.click();
}

describe("mounted inspector: real stored record → compiler → parser → DOM", () => {
  it("recompiles plain JSON, renders linked raw/Markdown/math/table/image views and session decisions", () => {
    const record = exampleRecord("reconnect");
    const root = host();
    const view = mountInspector(root, JSON.stringify(record));
    disposers.push(view.dispose);
    expect(view.controller.error).toBeNull();
    expect(view.controller.compiled).toEqual(rehydrate(record));
    expect(root.querySelector(".prompt-preview .katex")).not.toBeNull();
    expect(root.querySelector(".prompt-preview table")?.textContent).toContain("1.25");
    expect(root.querySelectorAll("[data-asset]").length).toBe(2);
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("Resume without repeating");
    expect(root.querySelector(".prompt-raw")?.textContent).not.toContain("Introduce the task");
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain("session.reason");
    const before = JSON.stringify(view.controller.compiled);
    getButton(root, "Recompile stored record").click();
    expect(JSON.stringify(view.controller.compiled)).toBe(before);
  });

  it("folds part of an equation in raw output while retaining valid math and canonical parts", async () => {
    const copied: string[] = [];
    const record = exampleRecord();
    const root = host();
    const view = mountInspector(root, record, {
      copy: (text) => {
        copied.push(text);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    const kinetic = byLabel(compiled, "Kinetic term");
    clickAction(root, `fold:${kinetic.id}`);
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded: Kinetic term]");
    expect(root.querySelector(".prompt-raw")?.textContent).not.toContain(
      String.raw`\frac{\hat p^2}{2m}`,
    );
    expect(root.querySelector(".prompt-preview .katex")).not.toBeNull();
    expect(root.querySelector("[data-partial-fold]")?.textContent).toContain(
      "complete block retained",
    );
    expect(root.querySelector(".prompt-preview .katex annotation")?.textContent).toContain(
      String.raw`\frac{\hat p^2}{2m}`,
    );
    getButton(root, "Copy canonical parts").click();
    await Promise.resolve();
    expect(copied[0]).toBe(JSON.stringify(compiled.parts));
    expect(copied[0]).not.toContain("[Folded:");
    expect(JSON.stringify(record)).toBe(JSON.stringify(view.controller.record));
  });

  it("keeps reused occurrences and nested folds independent from outline disclosure", () => {
    const root = host();
    const view = mountInspector(root, exampleRecord());
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    const reused = compiled.occurrences.filter(
      (item) => item.label === "Theory checks" || item.label === "Experiment checks",
    );
    expect(reused.length).toBe(2);
    expect(reused[0].definition).toBe(reused[1].definition);
    clickAction(root, `outline:${reused[0].id}`);
    expect(view.controller.state.contentFolded.size).toBe(0);
    expect(
      root.querySelector(".prompt-raw")?.textContent?.match(/Check \*\*dimensions\*\*/g)?.length,
    ).toBe(2);
    clickAction(root, `fold:${reused[0].id}`);
    expect(
      root.querySelector(".prompt-raw")?.textContent?.match(/Check \*\*dimensions\*\*/g)?.length,
    ).toBe(1);
    const section = byLabel(compiled, "Hamiltonian section");
    clickAction(root, `fold:${section.id}`);
    expect(view.controller.state.contentFolded.has(reused[0].id)).toBe(true);
    clickAction(root, `fold:${section.id}`);
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded: Theory checks]");
    expect(view.controller.state.contentFolded.has(reused[1].id)).toBe(false);
  });

  it("navigates from math to all contributors and raw text to the recorded source owner", () => {
    const root = host();
    const opened: unknown[] = [];
    const view = mountInspector(root, exampleRecord(), {
      onSource: (origin) => {
        opened.push(origin);
      },
    });
    disposers.push(view.dispose);
    const equation = root.querySelector<HTMLElement>(".prompt-equation");
    expect(equation?.dataset.precision).toBe("whole-equation");
    equation?.click();
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      "multiple contributing owners",
    );
    const compiled = view.controller.compiled as CompiledPrompt;
    const kinetic = byLabel(compiled, "Kinetic term");
    const raw = [...root.querySelectorAll<HTMLElement>(".prompt-raw-span")].find(
      (node) => node.dataset.owner === kinetic.id,
    );
    raw?.click();
    expect(view.controller.state.selected).toBe(kinetic.id);
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain('"capture": "manual"');
    getButton(root, "Open recorded source").click();
    expect(opened).toEqual([
      { kind: "example", label: "inspector/bench/fixtures.ts", capture: "manual" },
    ]);
    expect(root.querySelector(".prompt-preview [data-selected='true']")).not.toBeNull();
  });

  it("retains complete tables when only one contributing cell is folded", () => {
    const record = snapshot(
      Group({
        children: [
          "| A | B |\n| --- | --- |\n| ",
          Text({ value: "12.5", label: "Measured cell" }),
          " | 42 |",
        ],
      }),
    );
    const root = host();
    const view = mountInspector(root, record);
    disposers.push(view.dispose);
    const item = byLabel(view.controller.compiled as CompiledPrompt, "Measured cell");
    clickAction(root, `fold:${item.id}`);
    expect(root.querySelector(".prompt-preview table")?.textContent).toContain("12.5");
    expect(root.querySelector("[data-partial-fold]")).not.toBeNull();
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded: Measured cell]");
  });

  it("keeps raw images as hover/pinned popups beside the inline preview and cleans up", () => {
    const root = host();
    const resolutions: string[] = [];
    const view = mountInspector(root, exampleRecord(), {
      resolveAsset: (asset) => {
        resolutions.push(asset.id);
        return "data:image/png;base64,aGVsbG8=";
      },
    });
    disposers.push(view.dispose);
    const image = root.querySelector<HTMLButtonElement>("[data-asset]") as HTMLButtonElement;
    const popup = root.querySelector<HTMLElement>(".prompt-image-popup") as HTMLElement;
    expect(resolutions).toEqual(["example:energy-plot"]);
    expect(root.querySelectorAll(".prompt-preview img")).toHaveLength(1);
    expect(root.querySelector(".prompt-raw img")).toBeNull();
    image.dispatchEvent(new Event("pointerenter"));
    expect(popup.hidden).toBe(false);
    image.dispatchEvent(new Event("pointerleave"));
    expect(popup.hidden).toBe(true);
    image.click();
    image.dispatchEvent(new Event("pointerleave"));
    expect(popup.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popup.hidden).toBe(true);
    expect(document.activeElement).toBe(image);
    expect(popup.hidden).toBe(true);
    view.dispose();
    image.click();
    expect(root.childElementCount).toBe(0);
    expect(resolutions.length).toBe(3);
  });

  it("copies exact canonical text despite folds and keeps entities/HTML as safe preview content", async () => {
    const root = host();
    const copied: string[] = [];
    const record = snapshot(
      Prompt({
        children: [
          textOnlyPrompt,
          "<script>window.compromised = true</script>\n\n[bad](javascript:alert(1))",
        ],
      }),
    );
    const view = mountInspector(root, record, {
      copy: (text) => {
        copied.push(text);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    expect(root.querySelector(".prompt-preview")?.textContent).toContain("A & B");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("a[href^='javascript:']")).toBeNull();
    view.controller.toggleFold(compiled.occurrences[0].id);
    getButton(root, "Copy canonical text").click();
    await Promise.resolve();
    expect(copied[0]).toBe(canonicalText(compiled));
    expect(copied[0]).toContain("\r\n");
    expect(copied[0]).toContain("&amp;");
  });

  it("rejects unreadable schema/compiler/fingerprint records with a visible recoverable diagnostic", () => {
    const root = host();
    const record = exampleRecord();
    const view = mountInspector(root, { ...record, schemaVersion: 99 });
    disposers.push(view.dispose);
    expect(root.querySelector("[role='alert']")).not.toBeNull();
    expect(view.controller.compiled).toBeNull();
    expect(view.load({ ...record, compiler: { ...record.compiler, version: "99.0.0" } })).toBe(
      false,
    );
    expect(view.load({ ...record, fingerprint: "sha256:bad" })).toBe(false);
    expect(view.load("not JSON")).toBe(false);
    expect(view.load(record)).toBe(true);
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(root.querySelector(".prompt-preview")).not.toBeNull();
    view.dispose();
    expect(view.controller.load(record)).toBe(false);
    expect(view.controller.recompile()).toBe(false);
  });

  it("compares exact output and decisions in independent revision views", () => {
    const root = host();
    const comparison = mountComparison(root, exampleRecord("start"), exampleRecord("refresh"));
    disposers.push(comparison.dispose);
    expect(root.querySelector(".prompt-comparison-summary")?.textContent).toContain(
      "Different semantic records; different output",
    );
    expect(root.querySelector(".prompt-comparison-summary")?.textContent).toContain(
      "Recorded decisions changed",
    );
    const compiled = comparison.before.controller.compiled as CompiledPrompt;
    comparison.before.controller.toggleFold(compiled.occurrences[0].id);
    expect(comparison.before.controller.state.contentFolded.size).toBe(1);
    expect(comparison.after.controller.state.contentFolded.size).toBe(0);
    expect(root.querySelector("[aria-label='After revision'] .prompt-raw")?.textContent).toContain(
      "Continue from the existing",
    );
  });

  it("surfaces callback failures without changing the stored record", async () => {
    const root = host();
    const view = mountInspector(
      root,
      snapshot(Section({ title: "Example", children: "Exact text" })),
      {
        copy: () => {
          throw new Error("host denied clipboard");
        },
      },
    );
    disposers.push(view.dispose);
    getButton(root, "Copy canonical text").click();
    await Promise.resolve();
    expect(root.querySelector("[role='status']")?.textContent).toContain("host denied clipboard");
    expect(view.controller.error).toBeNull();
  });

  it("keeps definition and placement origins distinct and stops detached controls after disposal", () => {
    const definitionOrigin = { file: "component.prompt.tsx", line: 3, capture: "manual" };
    const placementOrigin = { file: "consumer.prompt.tsx", line: 18, capture: "manual" };
    const record = snapshot(
      Use({
        value: Text({ value: "Shared content", origin: definitionOrigin }),
        label: "Placed shared content",
        origin: placementOrigin,
      }),
    );
    const copied: string[] = [];
    const opened: unknown[] = [];
    const root = host();
    const view = mountInspector(root, record, {
      copy: (text) => {
        copied.push(text);
      },
      onSource: (origin) => {
        opened.push(origin);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    clickAction(root, `select:${compiled.occurrences[0].id}`);
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain("consumer.prompt.tsx");
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain("component.prompt.tsx");
    getButton(root, "Open recorded source").click();
    getButton(root, "Open definition source").click();
    expect(opened).toEqual([placementOrigin, definitionOrigin]);
    const copy = getButton(root, "Copy semantic record");
    const source = getButton(root, "Open recorded source");
    view.dispose();
    copy.click();
    source.click();
    expect(copied).toEqual([]);
    expect(opened.length).toBe(2);
  });

  it("retains the last validated record, selection, and folds after malformed JSON", async () => {
    const root = host();
    const original = exampleRecord();
    const copied: string[] = [];
    const view = mountInspector(root, original, {
      copy: (value) => {
        copied.push(value);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    const kinetic = byLabel(compiled, "Kinetic term");
    view.controller.select(kinetic.id);
    view.controller.toggleFold(kinetic.id);
    expect(view.load('{"incomplete":')).toBe(false);
    expect(root.querySelector("[role='alert']")?.textContent).toContain(
      "Showing the last validated record",
    );
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded: Kinetic term]");
    expect(view.controller.record).toEqual(original);
    expect(view.controller.compiled).toBe(compiled);
    expect(view.controller.state.selected).toBe(kinetic.id);
    getButton(root, "Copy semantic record").click();
    await Promise.resolve();
    expect(JSON.parse(copied[0])).toEqual(original);
    expect(view.load(exampleRecord("refresh"))).toBe(true);
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(view.controller.state.contentFolded.size).toBe(0);
  });

  it("blocks executable and local image URL schemes in both inline preview and popup", () => {
    const blocked = [
      "javascript:alert(1)",
      "file:///private/image.png",
      "ftp://example.com/a.png",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ];
    for (const url of blocked) {
      const root = host();
      const view = mountInspector(root, snapshot(Image({ asset: { id: "untrusted", uri: url } })));
      disposers.push(view.dispose);
      expect(root.querySelector(".prompt-preview img")).toBeNull();
      expect(root.querySelector(".prompt-inline-image")?.textContent).toContain(
        "No preview URL is available",
      );
      root.querySelector<HTMLButtonElement>("[data-asset]")?.click();
      expect(root.querySelector(".prompt-image-popup img")).toBeNull();
      expect(root.querySelector(".prompt-image-popup")?.textContent).toContain(
        "No preview URL is available",
      );
      view.dispose();
    }
  });

  it("replaces image load errors and removes document listeners on disposal", () => {
    const root = host();
    const view = mountInspector(root, snapshot(Image({ asset: { id: "image" } })), {
      resolveAsset: () => "https://example.invalid/a.png",
    });
    disposers.push(view.dispose);
    const trigger = root.querySelector<HTMLButtonElement>("[data-asset]") as HTMLButtonElement;
    trigger.click();
    const failedImage = root.querySelector<HTMLImageElement>(
      ".prompt-image-popup img",
    ) as HTMLImageElement;
    failedImage.dispatchEvent(new Event("error"));
    expect(root.querySelector(".prompt-image-popup img")).toBeNull();
    expect(root.querySelector(".prompt-image-popup")?.textContent).toContain(
      "Image could not be loaded",
    );
    getButton(root, "Close image preview").click();
    trigger.click();
    const replacement = root.querySelector<HTMLImageElement>(".prompt-image-popup img");
    failedImage.dispatchEvent(new Event("error"));
    expect(root.querySelector(".prompt-image-popup img")).toBe(replacement);
    view.dispose();
    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(false);
    replacement?.dispatchEvent(new Event("error"));
    expect(root.childElementCount).toBe(0);
  });

  it("surfaces every transparent provenance boundary once, deduplicating canonical JSON origins", () => {
    const definition = { file: "definition.prompt.tsx", line: 5 };
    const inner = { file: "inner.prompt.tsx", line: 12 };
    const outer = { file: "outer.prompt.tsx", line: 24 };
    const record = snapshot(
      Use({
        origin: outer,
        value: Use({
          origin: inner,
          value: Use({
            origin: { line: 12, file: "inner.prompt.tsx" },
            value: Text({ value: "One semantic leaf", origin: definition }),
          }),
        }),
      }),
    );
    const root = host();
    const opened: unknown[] = [];
    const view = mountInspector(root, record, {
      onSource: (origin) => {
        opened.push(origin);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    expect(compiled.occurrences.length).toBe(1);
    expect(compiled.parts).toMatchObject([{ type: "text", text: "One semantic leaf" }]);
    view.controller.select(compiled.occurrences[0].id);
    const provenance = root.querySelector(".prompt-provenance");
    const sourceButtons = [...(provenance?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    expect(sourceButtons.length).toBe(3);
    for (const button of sourceButtons) button.click();
    expect(opened).toEqual(expect.arrayContaining([definition, inner, outer]));
    expect(opened.length).toBe(3);
  });

  it("inspects mixed delegation and marker sidecar compositions with budgets and event origins", () => {
    const root = host();
    const opened: unknown[] = [];
    const view = mountInspector(root, delegationRecord(), {
      onSource: (origin) => {
        opened.push(origin);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    expect(root.querySelector(".prompt-raw")?.textContent).toContain(
      '<delegation backend="responses" id="synthetic-task-7">',
    );
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      '"selected": "elided-usage"',
    );
    view.controller.select(byLabel(compiled, "Budgeted laboratory tools").id);
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      laboratoryTools.fingerprint,
    );
    getButton(root, "Open contribution source 1").click();
    expect(opened[0]).toMatchObject({
      kind: "tool-projection",
      snapshot: laboratoryTools.fingerprint,
    });
    expect(view.load(markerSidecarRecord())).toBe(true);
    const marker = byLabel(view.controller.compiled as CompiledPrompt, "Captured tab marker");
    view.controller.select(marker.id);
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain(
      "synthetic:tab-switch:42",
    );
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[current tab changed:");
    getButton(root, "Open recorded source").click();
    expect(opened.at(-1)).toMatchObject({ kind: "event", eventId: "synthetic:tab-switch:42" });
    expect(root.querySelector(".prompt-provenance")?.textContent).toContain("page.isAiui");
  });

  it("decodes recognized math inside XML once while preserving canonical output and whole-equation mappings", async () => {
    const formula = String.raw`\begin{aligned}a &< b\\ c &= d\end{aligned}`;
    const literalEntity = String.raw`\text{&lt;}`;
    const record = snapshot(
      Prompt({
        children: [
          Xml({
            tag: "analysis",
            children: Prompt({
              children: [
                "An aligned expression:",
                Formula({ value: formula, label: "XML equation" }),
                "End of the expression.",
              ],
            }),
          }),
          Formula({ value: literalEntity, label: "Outside XML" }),
        ],
      }),
    );
    const root = host();
    const copied: string[] = [];
    const view = mountInspector(root, record, {
      copy: (text) => {
        copied.push(text);
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled as CompiledPrompt;
    const canonical = canonicalText(compiled) as string;
    const before = JSON.stringify(compiled.contributions);
    const xmlMath = root.querySelector<HTMLElement>(
      "[data-math-encoding='xml-entities-once']",
    ) as HTMLElement;
    expect(xmlMath).not.toBeNull();
    expect(xmlMath.querySelector("annotation")?.textContent).toBe(formula);
    expect(xmlMath.querySelector(".katex-error")).toBeNull();
    expect(xmlMath.dataset.precision).toBe("whole-equation");
    expect(canonical.slice(Number(xmlMath.dataset.start), Number(xmlMath.dataset.end))).toContain(
      "&amp;&lt;",
    );
    const outside = root.querySelector<HTMLElement>("[data-math-encoding='literal']");
    expect(outside?.title).toBe(literalEntity);
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("&amp;&lt;");
    getButton(root, "Copy canonical text").click();
    await Promise.resolve();
    expect(copied).toEqual([canonical]);
    expect(JSON.stringify(compiled.contributions)).toBe(before);
    expect(view.controller.record).toEqual(record);
  });
});
