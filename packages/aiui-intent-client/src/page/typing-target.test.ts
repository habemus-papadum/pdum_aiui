// @vitest-environment jsdom
/**
 * typing-target.test.ts — the ONE typing predicate (panel + both page tiers).
 * The parity test proves both tiers APPLY it; this pins what it answers.
 */
import { describe, expect, it } from "vitest";
import { isPageTypingTarget } from "./typing-target";

function keyOn(el: Element): KeyboardEvent {
  document.body.append(el);
  let captured: KeyboardEvent | undefined;
  el.addEventListener("keydown", (e) => {
    captured = e as KeyboardEvent;
  });
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
  el.remove();
  if (captured === undefined) {
    throw new Error("no event captured");
  }
  return captured;
}

describe("isPageTypingTarget", () => {
  it("claims inputs, textareas, selects, contenteditable, and ARIA textboxes", () => {
    expect(isPageTypingTarget(keyOn(document.createElement("input")))).toBe(true);
    expect(isPageTypingTarget(keyOn(document.createElement("textarea")))).toBe(true);
    expect(isPageTypingTarget(keyOn(document.createElement("select")))).toBe(true);

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isPageTypingTarget(keyOn(editable))).toBe(true);

    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    expect(isPageTypingTarget(keyOn(textbox))).toBe(true);
  });

  it("passes plain elements — the grammar keeps those keys", () => {
    expect(isPageTypingTarget(keyOn(document.createElement("div")))).toBe(false);
    expect(isPageTypingTarget(keyOn(document.createElement("button")))).toBe(false);
  });

  it("sees through shadow DOM via composedPath", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const inner = document.createElement("input");
    root.append(inner);
    let verdict: boolean | undefined;
    // Listen at the DOCUMENT, where event.target is retargeted to the host —
    // exactly the situation composedPath exists for. The predicate must run
    // DURING dispatch (composedPath() is empty once dispatch finishes), which
    // is how every real caller uses it — inside the capture listener.
    const listener = (e: Event): void => {
      verdict = isPageTypingTarget(e as KeyboardEvent);
    };
    document.addEventListener("keydown", listener, true);
    inner.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true, composed: true }));
    document.removeEventListener("keydown", listener, true);
    host.remove();
    expect(verdict).toBe(true);
  });
});
