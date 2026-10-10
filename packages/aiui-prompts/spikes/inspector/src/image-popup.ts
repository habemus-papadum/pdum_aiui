import { button, element } from "./dom";
import type { ImagePart } from "./model";

/** Popup ownership is scoped to one app; every revision/fold replacement explicitly closes it. */
export class ImagePopup {
  private node?: HTMLElement;
  private pinned = false;
  private timer?: ReturnType<typeof setTimeout>;
  private anchor?: HTMLElement;
  private abort = new AbortController();

  constructor() {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.node) {
          event.preventDefault();
          this.close(true);
        }
      },
      { signal: this.abort.signal },
    );
  }

  open(part: ImagePart, anchor: HTMLElement, pinned: boolean) {
    if (this.pinned && !pinned) return;
    this.close();
    this.anchor = anchor;
    this.pinned = pinned;
    const node = element("aside", "image-popup");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", `Image: ${part.asset.alt}`);
    const title = element("strong", "", part.asset.alt);
    const img = element("img");
    img.src = part.asset.uri;
    img.alt = part.asset.alt;
    const status = element("p", "muted", "Loading local fixture image…");
    img.addEventListener("load", () => {
      status.textContent = `${part.asset.width} × ${part.asset.height} · image/svg+xml · ${part.asset.revision}`;
    });
    img.addEventListener("error", () => {
      status.textContent = "Image unavailable. Asset identity and source mapping remain available.";
    });
    const controls = element("div", "toolbar");
    const pin = button(pinned ? "Pinned" : "Pin preview", () => {
      this.pinned = true;
      pin.textContent = "Pinned";
    });
    const close = button("Close · Esc", () => this.close(true));
    controls.append(pin, close);
    node.append(
      title,
      img,
      status,
      element("p", "muted", `Asset ${part.asset.id}. Fixture origin: local authored SVG.`),
      controls,
    );
    node.addEventListener("pointerenter", () => clearTimeout(this.timer));
    node.addEventListener("pointerleave", () => this.scheduleClose());
    document.body.append(node);
    this.node = node;
    if (pinned) close.focus({ preventScroll: true });
  }

  scheduleClose() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.pinned) this.close();
    }, 180);
  }

  close(restoreFocus = false) {
    clearTimeout(this.timer);
    this.node?.remove();
    this.node = undefined;
    this.pinned = false;
    if (restoreFocus && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
    this.anchor = undefined;
  }

  dispose() {
    this.close();
    this.abort.abort();
  }
}
