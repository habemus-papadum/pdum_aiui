import { targetLabel } from "./model";
import { CAPTURE_BOUNDARY_SELECTOR, elementCaptureIssue } from "./targets";
import type { CropMode } from "./types";

const active = new WeakMap<Document, () => void>();

/** Region selects any element; Element only selects declared boundaries. No page styles are changed. */
export function pickCaptureElement(
  options: { root?: Document | Element; signal?: AbortSignal; mode?: CropMode } = {},
): Promise<Element | undefined> {
  const root = options.root ?? document;
  const doc = root.nodeType === 9 ? (root as Document) : (root.ownerDocument as Document);
  const win = doc.defaultView;
  if (!win || options.signal?.aborted) return Promise.resolve(undefined);
  active.get(doc)?.();
  const boundariesOnly = options.mode === "element";
  const eligible = (element: Element | null): element is Element =>
    !!element &&
    element !== doc.documentElement &&
    element !== doc.body &&
    element.isConnected &&
    root.contains(element) &&
    !element.closest("[data-screen-capture-ignore]") &&
    (!boundariesOnly || !elementCaptureIssue(element));
  const resolveElement = (element: Element | null): Element | undefined => {
    if (!element || !root.contains(element) || element.closest("[data-screen-capture-ignore]"))
      return undefined;
    const candidate = boundariesOnly ? element.closest(CAPTURE_BOUNDARY_SELECTOR) : element;
    return eligible(candidate) ? candidate : undefined;
  };
  const firstBoundary = (parent: Document | Element) =>
    [...parent.querySelectorAll(CAPTURE_BOUNDARY_SELECTOR)].find(eligible);
  const initial = boundariesOnly
    ? root.nodeType === 1 && eligible(root as Element)
      ? (root as Element)
      : firstBoundary(root)
    : undefined;
  if (boundariesOnly && !initial)
    return Promise.reject(
      new Error(
        "No capture boundaries are available here. Use Region to pick an individual element.",
      ),
    );
  return new Promise((resolve) => {
    let target: Element | undefined;
    let done = false;
    let raf = 0;
    const overlay = doc.createElement("div");
    overlay.setAttribute("data-screen-capture-ignore", "");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid var(--aiui-accent,#555);display:none;box-sizing:border-box";
    const hint = doc.createElement("div");
    hint.setAttribute("role", "status");
    hint.setAttribute("data-screen-capture-ignore", "");
    hint.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;bottom:16px;left:16px;max-width:calc(100vw - 32px);padding:10px;background:var(--aiui-surface-raised,#fff);color:var(--aiui-ink,#222);border:1px solid var(--aiui-hairline,#aaa);font:13px var(--aiui-sans,system-ui)";
    doc.body.append(overlay, hint);
    const select = (element: Element | null) => {
      target = eligible(element) ? element : undefined;
      hint.textContent = `${target ? targetLabel({ element: target }) : boundariesOnly ? "No capture boundary here" : "Choose an element"} · ↑ parent · ↓ child · Enter select · Esc cancel`;
    };
    const draw = () => {
      if (target?.isConnected) {
        const r = target.getBoundingClientRect();
        Object.assign(overlay.style, {
          display: "block",
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      } else overlay.style.display = "none";
      raf = win.requestAnimationFrame(draw);
    };
    const underPointer = (event: MouseEvent) =>
      resolveElement(doc.elementFromPoint(event.clientX, event.clientY)) ?? null;
    const move = (event: PointerEvent) => select(underPointer(event));
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const click = (event: MouseEvent) => {
      swallow(event);
      select(underPointer(event));
      if (eligible(target ?? null)) finish(target);
    };
    const key = (event: KeyboardEvent) => {
      if (!["Escape", "Enter", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      swallow(event);
      if (event.key === "Escape") finish();
      if (event.key === "Enter" && eligible(target ?? null)) finish(target);
      const parent = boundariesOnly
        ? target?.parentElement?.closest(CAPTURE_BOUNDARY_SELECTOR)
        : target?.parentElement;
      if (event.key === "ArrowUp" && eligible(parent ?? null)) select(parent ?? null);
      const child = boundariesOnly
        ? target
          ? firstBoundary(target)
          : firstBoundary(root)
        : target?.firstElementChild;
      if (event.key === "ArrowDown" && eligible(child ?? null)) select(child ?? null);
    };
    const cancel = () => finish();
    function finish(element?: Element) {
      if (done) return;
      done = true;
      win?.cancelAnimationFrame(raf);
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("pointerdown", swallow, true);
      doc.removeEventListener("pointerup", swallow, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("keydown", key, true);
      win?.removeEventListener("blur", cancel);
      options.signal?.removeEventListener("abort", cancel);
      overlay.remove();
      hint.remove();
      active.delete(doc);
      resolve(element);
    }
    active.set(doc, cancel);
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerdown", swallow, true);
    doc.addEventListener("pointerup", swallow, true);
    doc.addEventListener("click", click, true);
    doc.addEventListener("keydown", key, true);
    win.addEventListener("blur", cancel);
    options.signal?.addEventListener("abort", cancel, { once: true });
    select(initial ?? null);
    draw();
  });
}
