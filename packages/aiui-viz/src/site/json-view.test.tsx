// @vitest-environment jsdom
/**
 * The JSON explorer: small flat values stay inline, deeper structure folds
 * behind a summary and opens on a click, long strings clip behind "more".
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { JsonView } from "./json-view";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(value: unknown, depth?: number): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <JsonView value={value} depth={depth} />, host);
  return host;
}

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("JsonView", () => {
  it("renders a small flat object inline, keys unquoted, strings quoted", () => {
    const host = mount({ seed: 3065319331, targetN: 32, ok: true, note: "hi" });
    expect(text(host)).toBe('{seed: 3065319331, targetN: 32, ok: true, note: "hi"}');
    expect(host.querySelector(".aiui-json-toggle")).toBeNull();
  });

  it("folds a nested object behind a summary and opens it on a click", async () => {
    const host = mount({ meta: { a: 1, b: 2 }, rows: [1, 2, 3, 4, 5, 6] });
    // top level open (depth 1); its children folded
    const toggles = [...host.querySelectorAll<HTMLButtonElement>(".aiui-json-toggle")];
    expect(toggles.map((t) => t.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(text(host)).toContain("{meta, rows}");
    expect(text(host)).toContain("[6]");
    expect(text(host)).not.toContain("5: 6"); // the array's items are folded
    toggles[1]?.click();
    await tick();
    expect(text(host)).toContain("5: 6");
  });

  it("clips a long string behind more", async () => {
    const long = "x".repeat(400);
    const host = mount({ s: long });
    expect(text(host)).toContain("more (400)");
    expect(text(host)).not.toContain(long);
    host.querySelector<HTMLButtonElement>(".aiui-json-more")?.click();
    await tick();
    expect(text(host)).toContain(long);
  });

  it("renders null, undefined, and empty containers as themselves", () => {
    const host = mount({ a: null, b: undefined, c: {}, d: [] });
    expect(text(host)).toBe("{a: null, b: undefined, c: {}, d: []}");
  });
});
