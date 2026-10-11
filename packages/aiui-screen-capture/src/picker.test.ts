import { afterEach, expect, it, vi } from "vitest";
import { pickCaptureElement } from "./picker";

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function rig() {
  document.body.innerHTML = `<main><div id="outer" data-screen-capture-target style="isolation:isolate;transform-style:flat">
    <div id="inner" data-screen-capture-target style="isolation:isolate;transform-style:flat"><p>Text</p></div>
    <button data-screen-capture-ignore>Ignored</button>
  </div><aside>Outside</aside></main>`;
  const outer = document.querySelector("#outer") as HTMLElement;
  const inner = document.querySelector("#inner") as HTMLElement;
  const child = document.querySelector("p") as HTMLElement;
  const root = document.querySelector("main") as HTMLElement;
  const point = vi.fn((): Element => child);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: point });
  return { outer, inner, child, root, point };
}
const move = () => document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
const key = (value: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: value }));

it("selects the nearest declared boundary, with parent/child boundary navigation", async () => {
  const { root, inner, outer } = rig();
  const picked = pickCaptureElement({ root, mode: "element" });
  move();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("#inner");
  key("ArrowUp");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("#outer");
  key("ArrowDown");
  key("Enter");
  expect(await picked).toBe(inner);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(outer.style.isolation).toBe("isolate");
});

it("keeps arbitrary child picking in Region without changing its styles", async () => {
  const { root, child } = rig();
  const picked = pickCaptureElement({ root, mode: "region" });
  move();
  document.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(await picked).toBe(child);
  expect(child.getAttribute("style")).toBeNull();
});

it("does not select ignored content or a boundary outside the picker root", async () => {
  const { inner, child, point } = rig();
  // The only declaration is outside this picker root.
  inner.removeAttribute("data-screen-capture-target");
  await expect(pickCaptureElement({ root: inner, mode: "element" })).rejects.toThrow(
    "No capture boundaries",
  );
  inner.setAttribute("data-screen-capture-target", "");
  const picked = pickCaptureElement({ mode: "element" });
  point.mockReturnValue(document.querySelector("button") as Element);
  move();
  key("Enter");
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "No capture boundary here",
  );
  point.mockReturnValue(child);
  move();
  key("Enter");
  expect(await picked).toBe(inner);
});

it("cancels on abort and releases the click interceptor", async () => {
  const { root } = rig();
  const signal = new AbortController();
  const picked = pickCaptureElement({ root, mode: "element", signal: signal.signal });
  signal.abort();
  expect(await picked).toBeUndefined();
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.dispatchEvent(new MouseEvent("click", { cancelable: true }))).toBe(true);
});
