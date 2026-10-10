// @vitest-environment jsdom
import { Group, Image, snapshot, Text } from "@habemus-papadum/aiui-prompts";
import {
  type ConsumerAdapter,
  captureWire,
  consumerOperation,
  lowerOperation,
} from "@habemus-papadum/aiui-prompts/operations";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleRecord } from "../bench/fixtures.ts";
import { InspectorController } from "./controller.ts";
import {
  mountInspector,
  mountPreview,
  PromptInspector,
  PromptPreview,
  positionImagePopup,
} from "./view.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function host() {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}
function button(root: HTMLElement, label: string) {
  const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
const record = () =>
  snapshot(
    Group({
      children: [
        Text({ value: "**Visible** $x^2$", label: "Prose" }),
        Image({ asset: { id: "plot", uri: "https://example.invalid/plot.png" } }),
      ],
    }),
  );

describe("native Solid components under jsdom", () => {
  it("reacts to record props, retains the last good record on invalid input, and disposes cleanly", async () => {
    const warnings = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const [value, setValue] = createSignal<unknown>(record());
    const root = host();
    const dispose = render(() => <PromptInspector record={value()} />, root);
    disposers.push(dispose);
    flush();
    expect(root.querySelector(".prompt-preview strong")?.textContent).toBe("Visible");
    expect(root.querySelector(".prompt-preview .katex")).not.toBeNull();
    setValue("malformed");
    await Promise.resolve();
    flush();
    expect(root.querySelector("[role=alert]")?.textContent).toContain("last validated record");
    expect(root.querySelector(".prompt-preview strong")?.textContent).toBe("Visible");
    setValue(snapshot(Text({ value: "Replacement" })));
    await Promise.resolve();
    flush();
    expect(root.querySelector("[role=alert]")).toBeNull();
    expect(root.querySelector(".prompt-preview")?.textContent).toContain("Replacement");
    dispose();
    setValue(record());
    await Promise.resolve();
    flush();
    expect(root.childElementCount).toBe(0);
    expect(warnings).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("preserves unaffected raw/math/image nodes, disclosure state and actual focus on selection/folding", () => {
    const root = host();
    const view = mountInspector(root, exampleRecord());
    disposers.push(view.dispose);
    const compiled = view.controller.compiled;
    const kinetic = compiled?.occurrences.find((item) => item.label === "Kinetic term");
    const raw = root.querySelector<HTMLElement>(".prompt-raw-span");
    const math = root.querySelector(".prompt-equation");
    const image = root.querySelector(".prompt-inline-image img");
    const details = root.querySelector<HTMLDetailsElement>("details.prompt-json");
    const target = root.querySelector<HTMLButtonElement>(`[data-action-key='fold:${kinetic?.id}']`);
    if (!kinetic || !raw || !details || !target) throw new Error("Missing fixture DOM");
    details.open = false;
    target.focus();
    view.controller.select(kinetic.id);
    expect(root.querySelector(".prompt-raw-span")).toBe(raw);
    expect(root.querySelector(".prompt-equation")).toBe(math);
    expect(root.querySelector(".prompt-inline-image img")).toBe(image);
    target.click();
    expect(root.querySelector(".prompt-equation")).toBe(math);
    expect(root.querySelector(".prompt-inline-image img")).toBe(image);
    expect(document.activeElement).toBe(target);
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(false);
    expect(root.querySelector("[data-partial-fold]")).not.toBeNull();
  });

  it("provides compact Markdown/text modes and a full inspector that shares state and restores focus", async () => {
    const root = host();
    const view = mountPreview(root, record());
    disposers.push(view.dispose);
    const compact = root.querySelector<HTMLElement>(".prompt-compact") as HTMLElement;
    const preview = compact.querySelector<HTMLElement>(".prompt-preview") as HTMLElement;
    const raw = compact.querySelector<HTMLElement>(".prompt-raw") as HTMLElement;
    expect(compact.querySelector(".prompt-tree")).toBeNull();
    expect(preview.hidden).toBe(false);
    expect(raw.hidden).toBe(true);
    const image = preview.querySelector("img");
    button(compact, "Text").click();
    expect(raw.hidden).toBe(false);
    expect(preview.hidden).toBe(true);
    expect(raw.textContent).toContain("**Visible** $x^2$");
    button(compact, "Markdown").click();
    expect(preview.querySelector("img")).toBe(image);
    const opener = button(compact, "Open full inspector");
    opener.focus();
    opener.click();
    await Promise.resolve();
    flush();
    const dialog = compact.querySelector<HTMLDialogElement>("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector(".prompt-tree")).not.toBeNull();
    const id = view.controller.compiled?.occurrences.find((item) => item.label === "Prose")?.id;
    if (!id) throw new Error("Missing prose owner");
    view.controller.select(id);
    flush();
    expect(dialog?.querySelector(".prompt-tree-row[data-selected='true']")).not.toBeNull();
    button(dialog as HTMLDialogElement, "Close full inspector").click();
    expect(compact.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(preview.querySelector("img")).toBe(image);
    expect(view.controller.state.selected).toBe(id);
    expect(view.controller.disposed).toBe(false);
  });

  it("leaves an externally owned controller alive, supports host expansion and keyboard mode controls", () => {
    const root = host();
    const controller = new InspectorController(record());
    const expand = vi.fn();
    const dispose = render(
      () => <PromptPreview controller={controller} initialView="text" onExpand={expand} />,
      root,
    );
    disposers.push(dispose, () => controller.dispose());
    flush();
    expect(root.querySelector<HTMLElement>(".prompt-raw")?.hidden).toBe(false);
    button(root, "Open full inspector").click();
    expect(expand).toHaveBeenCalledWith(controller);
    expect(root.querySelector("dialog")).toBeNull();
    const markdown = button(root, "Markdown");
    markdown.focus();
    markdown.click();
    expect(document.activeElement).toBe(markdown);
    expect(markdown.getAttribute("aria-pressed")).toBe("true");
    dispose();
    expect(controller.disposed).toBe(false);
    expect(controller.load(snapshot(Text({ value: "Still usable" })))).toBe(true);
    expect(root.childElementCount).toBe(0);
  });
  it("loads context and exact adapters reactively even when the captured wire prop stays the same", async () => {
    const adapter: ConsumerAdapter = {
      identity: { name: "saved-control", version: "1" },
      capabilities: { actions: ["ping"], content: [], assets: [] },
      lower: () => ({ payload: { event: "ping" }, mappings: [], decisions: [] }),
    };
    const operation = consumerOperation({
      adapter: adapter.identity,
      action: "ping",
      bindings: [],
    });
    const delivery = lowerOperation(
      operation,
      { kind: "custom", adapter: adapter.identity, options: {} },
      {},
      [adapter],
    );
    const wire = captureWire(delivery, delivery.payload, { capturedAt: "2026-10-10T12:00:00Z" });
    const [operationProp, setOperation] = createSignal<unknown>(undefined);
    const [adapters, setAdapters] = createSignal<readonly ConsumerAdapter[]>([]);
    const root = host();
    const dispose = render(
      () => <PromptInspector record={wire} operation={operationProp()} adapters={adapters()} />,
      root,
    );
    disposers.push(dispose);
    flush();
    expect(root.querySelector("[role=alert]")?.textContent).toContain(
      "referenced semantic operation",
    );
    setOperation(operation);
    await Promise.resolve();
    flush();
    expect(root.querySelector("[role=alert]")).toBeNull();
    expect(root.querySelector(".prompt-history")?.textContent).toContain(
      "Wire verification: unavailable",
    );
    expect(root.querySelector(".prompt-history")?.textContent).toContain('"event": "ping"');
    expect(root.querySelector(".prompt-tree")).toBeNull();
    setAdapters([adapter]);
    await Promise.resolve();
    flush();
    expect(root.querySelector(".prompt-history")?.textContent).toContain(
      "Wire verification: equal",
    );
  });

  it("shares the owned compact controller with its dialog even with an explicitly undefined forwarded controller", async () => {
    const root = host();
    const dispose = render(() => <PromptPreview record={record()} controller={undefined} />, root);
    disposers.push(dispose);
    flush();
    const raw = root.querySelector<HTMLElement>(".prompt-raw-span") as HTMLElement;
    raw.click();
    const owner = raw.dataset.owner;
    button(root, "Open full inspector").click();
    await Promise.resolve();
    flush();
    expect(
      root
        .querySelector("dialog .prompt-tree-row[data-selected='true']")
        ?.parentElement?.getAttribute("data-occurrence"),
    ).toBe(owner);
    const dialog = root.querySelector<HTMLDialogElement>("dialog") as HTMLDialogElement;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector("dialog")).toBeNull();
  });
});

describe("anchored image previews", () => {
  it("places the popup below the link, flips above it, and clamps viewport edges", () => {
    const viewport = { width: 800, height: 600 };
    const size = { width: 280, height: 200 };
    // Neither side fits: cap to the larger available side while keeping the trigger unobscured.
    expect(
      positionImagePopup(
        { left: 40, top: 338, bottom: 366 },
        { width: 448, height: 370 },
        { width: 1676, height: 704 },
      ),
    ).toEqual({ left: 40, top: 374, maxHeight: 322 });
    expect(positionImagePopup({ left: 100, top: 120, bottom: 145 }, size, viewport)).toEqual({
      left: 100,
      top: 153,
      maxHeight: 439,
    });
    expect(positionImagePopup({ left: 700, top: 500, bottom: 525 }, size, viewport)).toEqual({
      left: 512,
      top: 292,
      maxHeight: 484,
    });
    expect(
      positionImagePopup({ left: -20, top: -20, bottom: 0 }, { width: 900, height: 900 }, viewport),
    ).toEqual({ left: 8, top: 8, maxHeight: 584 });
  });

  it("uses the trigger rectangle, closes on pointer exit or focus loss, and cleans document listeners", () => {
    const root = host();
    const view = mountInspector(root, record());
    disposers.push(view.dispose);
    const trigger = root.querySelector<HTMLButtonElement>(
      ".prompt-raw [data-asset]",
    ) as HTMLButtonElement;
    const popup = root.querySelector<HTMLElement>(".prompt-image-popup") as HTMLElement;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 130,
      top: 90,
      bottom: 110,
      right: 250,
      width: 120,
      height: 20,
      x: 130,
      y: 90,
      toJSON: () => ({}),
    });
    vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      bottom: 200,
      right: 300,
      width: 300,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    trigger.dispatchEvent(new Event("pointerenter"));
    expect(popup.hidden).toBe(false);
    expect(popup.style.left).toBe("130px");
    expect(popup.style.top).toBe("118px");
    trigger.dispatchEvent(new Event("pointerleave"));
    expect(popup.hidden).toBe(true);
    trigger.focus();
    expect(popup.hidden).toBe(false);
    trigger.blur();
    expect(popup.hidden).toBe(true);
    const remove = vi.spyOn(document, "removeEventListener");
    view.dispose();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    trigger.dispatchEvent(new Event("pointerenter"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(root.childElementCount).toBe(0);
  });
  it("dismisses a preview when its trigger is folded away or its compact text pane is hidden", () => {
    const root = host();
    const view = mountPreview(root, record(), { initialView: "text" });
    disposers.push(view.dispose);
    const trigger = root.querySelector<HTMLButtonElement>(
      ".prompt-raw [data-asset]",
    ) as HTMLButtonElement;
    const popup = root.querySelector<HTMLElement>(".prompt-image-popup") as HTMLElement;
    trigger.dispatchEvent(new Event("pointerenter"));
    expect(popup.hidden).toBe(false);
    const owner = view.controller.compiled?.contributions.find(
      (entry) => entry.part === "p1",
    )?.occurrence;
    if (!owner) throw new Error("Missing image owner");
    view.controller.toggleFold(owner);
    flush();
    expect(trigger.isConnected).toBe(false);
    expect(popup.hidden).toBe(true);
    view.controller.toggleFold(owner);
    const next = root.querySelector<HTMLButtonElement>(
      ".prompt-raw [data-asset]",
    ) as HTMLButtonElement;
    next.dispatchEvent(new Event("pointerenter"));
    expect(popup.hidden).toBe(false);
    button(root, "Markdown").click();
    expect(popup.hidden).toBe(true);
    next.dispatchEvent(new Event("pointerenter"));
    const image = popup.querySelector("img");
    const measure = vi.spyOn(popup, "getBoundingClientRect");
    view.dispose();
    image?.dispatchEvent(new Event("load"));
    expect(measure).not.toHaveBeenCalled();
  });
});
