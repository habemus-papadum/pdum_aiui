// @vitest-environment jsdom
/**
 * target-tab.test.tsx — the "aimed at" chip names the leader tab and follows
 * it. A fake SurfaceTargeting drives leader changes; the DOM is the assertion.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import type { SurfaceTargeting } from "../transport";
import { TargetTab } from "./target-tab";

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

/** A targeting seam with a per-tab identity table and a manual leader. */
function fakeTargeting(
  info: Record<number, { url?: string; title?: string }>,
  opts: { withTabInfo?: boolean } = {},
) {
  let active: number | undefined = 0;
  const handlers = new Set<(tab: number | undefined) => void>();
  const targeting: SurfaceTargeting = {
    activeTab: () => active,
    onActiveTabChange: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    ...(opts.withTabInfo === false ? {} : { tabInfo: async (tab: number) => info[tab] }),
  };
  return {
    targeting,
    switchTo: (tab: number | undefined) => {
      active = tab;
      for (const handler of handlers) {
        handler(tab);
      }
    },
  };
}

let dispose: (() => void) | undefined;
function mount(node: () => unknown): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(node as never, root);
  return root;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("TargetTab", () => {
  it("names the current leader — host, title, and tab id", async () => {
    const t = fakeTargeting({ 0: { url: "https://plot.example.com/x", title: "Spectra" } });
    const root = mount(() => <TargetTab targeting={t.targeting} />);
    await settle();
    const chip = root.querySelector('[data-testid="target-tab"]') as HTMLElement;
    expect(chip.querySelector(".aiui-target-host")?.textContent).toBe("plot.example.com");
    expect(chip.querySelector(".aiui-target-title")?.textContent).toBe("Spectra");
    expect(chip.querySelector(".aiui-target-id")?.textContent).toBe("#0");
  });

  it("follows the leader when the tab changes", async () => {
    const t = fakeTargeting({
      0: { url: "https://a.test/", title: "A" },
      1: { url: "https://b.test/", title: "B" },
    });
    const root = mount(() => <TargetTab targeting={t.targeting} />);
    await settle();
    t.switchTo(1);
    await settle();
    const chip = root.querySelector('[data-testid="target-tab"]') as HTMLElement;
    expect(chip.querySelector(".aiui-target-host")?.textContent).toBe("b.test");
    expect(chip.querySelector(".aiui-target-title")?.textContent).toBe("B");
  });

  it("says so when no tab is in view", async () => {
    const t = fakeTargeting({});
    const root = mount(() => <TargetTab targeting={t.targeting} />);
    await settle();
    t.switchTo(undefined);
    await settle();
    expect(root.querySelector(".aiui-target-none")?.textContent).toBe("no tab in view");
  });

  it("renders nothing when the host cannot identify tabs (no tabInfo)", async () => {
    const t = fakeTargeting({ 0: { url: "https://a.test/" } }, { withTabInfo: false });
    const root = mount(() => <TargetTab targeting={t.targeting} />);
    await settle();
    expect(root.querySelector('[data-testid="target-tab"]')).toBeNull();
  });
});
