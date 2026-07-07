// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { OverlayError } from "../errors";
import { mountWidget, type WidgetOptions } from "./widget";

/** Solid 2 batches signal writes; flush before asserting Solid-rendered DOM. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount(overrides: Partial<WidgetOptions> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: "open" });
  const onTabSelect = vi.fn();
  const onDismissSelection = vi.fn();
  const onDismissError = vi.fn();
  const widget = mountWidget(shadowRoot, {
    title: "aiui intent",
    tabLabels: ["Multimodal", "Text"],
    onTabSelect,
    onDismissSelection,
    onDismissError,
    ...overrides,
  });
  const q = <T extends Element>(sel: string): T | null => shadowRoot.querySelector<T>(sel);
  return { host, shadowRoot, widget, q, onTabSelect, onDismissSelection, onDismissError };
}

const toast = (id: number, message: string, count = 1): OverlayError => ({
  id,
  message,
  count,
  at: 0,
});

describe("the unified widget (ui/widget.tsx)", () => {
  it("renders the pill with the default label, panel hidden; expander toggles it", async () => {
    const { widget, q, host } = mount();
    expect(q(".pill-label")?.textContent).toBe("✳ aiui");
    expect(q<HTMLElement>(".panel")?.hidden).toBe(true);
    expect(widget.isOpen()).toBe(false);

    q<HTMLButtonElement>(".expander")?.click();
    await flush();
    expect(q<HTMLElement>(".panel")?.hidden).toBe(false);
    // isOpen reads the plain flag, not the (batched) signal — current same-tick.
    expect(widget.isOpen()).toBe(true);

    q<HTMLButtonElement>(".expander")?.click();
    await flush();
    expect(q<HTMLElement>(".panel")?.hidden).toBe(true);
    widget.dispose();
    host.remove();
  });

  it("claiming the hud slot hides the default label and injects slot styles", async () => {
    const { widget, q, shadowRoot, host } = mount();
    const slot = widget.claimHudSlot();
    slot.container.append(Object.assign(document.createElement("span"), { textContent: "hud!" }));
    slot.addStyle(".mm-test { color: red; }");
    await flush();
    expect(q(".pill-label")).toBeNull();
    expect(q(".hud-slot")?.textContent).toBe("hud!");
    const styles = [...shadowRoot.querySelectorAll("style")].map((s) => s.textContent ?? "");
    expect(styles.some((css) => css.includes(".mm-test"))).toBe(true);
    widget.dispose();
    host.remove();
  });

  it("drives the mode ring through data-ui-mode; undefined clears it", async () => {
    const { widget, q, host } = mount();
    widget.setUiMode("talking");
    await flush();
    expect(q(".pill")?.getAttribute("data-ui-mode")).toBe("talking");
    widget.setUiMode(undefined);
    await flush();
    expect(q(".pill")?.hasAttribute("data-ui-mode")).toBe(false);
    widget.dispose();
    host.remove();
  });

  it("renders toasts with source badge, ×N count, and dismiss → callback with the id", async () => {
    const { widget, q, onDismissError, host } = mount();
    widget.setToasts([
      { ...toast(1, "boom"), source: "connection", detail: "check the port" },
      toast(2, "again", 3),
    ]);
    await flush();
    const toasts = [...(q(".toasts")?.querySelectorAll(".toast") ?? [])];
    expect(toasts).toHaveLength(2);
    expect(toasts[0].querySelector(".toast-source")?.textContent).toBe("connection");
    expect(toasts[0].querySelector(".toast-detail")?.textContent).toBe("check the port");
    expect(toasts[1].querySelector(".toast-count")?.textContent).toBe("×3");

    toasts[1].querySelector<HTMLButtonElement>(".toast-dismiss")?.click();
    expect(onDismissError).toHaveBeenCalledWith(2);
    widget.dispose();
    host.remove();
  });

  it("shows the selection chip (truncated, with loc) and hides the row without one", async () => {
    const { widget, q, onDismissSelection, host } = mount();
    expect(q<HTMLElement>(".chiprow")?.hidden).toBe(true);
    widget.setChip({ text: "x".repeat(60), sourceLoc: "src/App.tsx:3:1" });
    await flush();
    expect(q<HTMLElement>(".chiprow")?.hidden).toBe(false);
    expect(q(".chip-label")?.textContent).toContain("…");
    expect(q(".chip-loc")?.textContent).toBe("src/App.tsx:3:1");
    q<HTMLButtonElement>(".chip-dismiss")?.click();
    expect(onDismissSelection).toHaveBeenCalled();
    widget.setChip(undefined);
    await flush();
    expect(q<HTMLElement>(".chiprow")?.hidden).toBe(true);
    widget.dispose();
    host.remove();
  });

  it("status line carries the error class only when flagged", async () => {
    const { widget, q, host } = mount();
    widget.setStatus("sending…", false);
    await flush();
    expect(q(".status")?.className).toBe("status");
    expect(q(".status")?.textContent).toBe("sending…");
    widget.setStatus("send failed: no channel", true);
    await flush();
    expect(q(".status")?.className).toBe("status error");
    widget.dispose();
    host.remove();
  });

  it("tab clicks route through onTabSelect; setActiveTab moves the active class", async () => {
    const { widget, q, onTabSelect, host } = mount();
    const tabs = [...(q(".tabs")?.querySelectorAll(".tab") ?? [])] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(["Multimodal", "Text"]);
    tabs[1].click();
    expect(onTabSelect).toHaveBeenCalledWith(1);
    widget.setActiveTab(1);
    await flush();
    expect(q(".tab.active")?.textContent).toBe("Text");
    widget.dispose();
    host.remove();
  });

  it("hides the tab row for a single modality, and 🔍 without its url", () => {
    const { q, widget, host } = mount({ tabLabels: ["Text"] });
    expect(q<HTMLElement>(".tabs")?.hidden).toBe(true);
    // No debugUrl option → the affordance doesn't render at all.
    expect(q('a[title="Open the lowering debugger"]')).toBeNull();
    widget.dispose();
    host.remove();
  });

  it("upgrades the 🔍 href via setDebugHref", async () => {
    const { widget, q, host } = mount({ debugUrl: "http://localhost:5173/__aiui/debug" });
    widget.setDebugHref("http://localhost:5173/__aiui/debug?session=abc");
    await flush();
    expect(q<HTMLAnchorElement>('a[title="Open the lowering debugger"]')?.href).toContain(
      "session=abc",
    );
    widget.dispose();
    host.remove();
  });
});
