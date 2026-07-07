// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installKeys, isTypingTarget, type KeyLayer } from "./keys";

// The DOM half of the keymap: one capture-phase owner on the document, and
// the typing-target guard that keeps it from stealing keys out of editors.

const layer: KeyLayer<undefined, string> = {
  name: "test",
  fallback: "pass",
  bindings: [
    { keys: ["a"], down: () => ({ command: "act" }), up: () => ({ command: "act-up" }) },
    { keys: ["b"], down: () => "swallow" },
    {
      keys: ["r"],
      down: (_state, _key, repeat) => (repeat ? "swallow" : { command: "run-once" }),
    },
  ],
};

function install() {
  const dispatch = vi.fn();
  const uninstall = installKeys<undefined, string>({
    stack: [layer],
    getState: () => undefined,
    dispatch,
  });
  return { dispatch, uninstall };
}

function key(type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("installKeys", () => {
  it("claims commands at document capture: preventDefault, dispatch, and bubblers never see it", () => {
    const { dispatch, uninstall } = install();
    const bubbler = vi.fn();
    document.addEventListener("keydown", bubbler); // a component-level listener
    const event = key("keydown", { key: "a" });
    document.body.dispatchEvent(event);
    expect(dispatch).toHaveBeenCalledWith("act");
    expect(event.defaultPrevented).toBe(true);
    expect(bubbler).not.toHaveBeenCalled(); // stopPropagation from the capture owner
    document.removeEventListener("keydown", bubbler);
    uninstall();
  });

  it("swallows are claimed too — preventDefault-ed, but nothing dispatched", () => {
    const { dispatch, uninstall } = install();
    const event = key("keydown", { key: "b" });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    uninstall();
  });

  it("held-key repeats reach the handler as repeats, and the swallow still prevents default", () => {
    const { dispatch, uninstall } = install();
    const first = key("keydown", { key: "r", repeat: false });
    const held = key("keydown", { key: "r", repeat: true });
    document.body.dispatchEvent(first);
    document.body.dispatchEvent(held);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("run-once");
    expect(held.defaultPrevented).toBe(true); // inert, but not the page's
    uninstall();
  });

  it("passes leave the event completely untouched — the page keeps it", () => {
    const { dispatch, uninstall } = install();
    const unbound = key("keydown", { key: "z" });
    document.body.dispatchEvent(unbound);
    expect(unbound.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    // A down-only binding's keyup passes too (b has no up handler).
    const upEvent = key("keyup", { key: "b" });
    document.body.dispatchEvent(upEvent);
    expect(upEvent.defaultPrevented).toBe(false);
    uninstall();
  });

  it("keyups route to up handlers through the same capture owner", () => {
    const { dispatch, uninstall } = install();
    document.body.dispatchEvent(key("keyup", { key: "a" }));
    expect(dispatch).toHaveBeenCalledWith("act-up");
    uninstall();
  });

  it("yields to typing targets: a focused input keeps its keys, even from inside shadow DOM", () => {
    const { dispatch, uninstall } = install();

    const input = document.createElement("input");
    document.body.append(input);
    const typed = key("keydown", { key: "a" });
    input.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    // Shadow DOM: at the document, event.target is the host — only
    // composedPath still points at the inner input. The guard must hold.
    const host = document.createElement("div");
    document.body.append(host);
    const shadowInput = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(shadowInput);
    const shadowTyped = key("keydown", { key: "a" });
    shadowInput.dispatchEvent(shadowTyped);
    expect(shadowTyped.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    uninstall();
  });

  it("uninstall removes both listeners — no zombie keymap after teardown", () => {
    const { dispatch, uninstall } = install();
    uninstall();
    const down = key("keydown", { key: "a" });
    const up = key("keyup", { key: "a" });
    document.body.dispatchEvent(down);
    document.body.dispatchEvent(up);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    uninstall(); // idempotent — a second release must not throw
  });
});

describe("isTypingTarget", () => {
  /** Dispatch a key event from `el` and report what the guard said at the document. */
  function typingAt(el: Element): boolean {
    let verdict: boolean | undefined;
    const probe = (event: Event) => {
      verdict = isTypingTarget(event as KeyboardEvent);
    };
    document.addEventListener("keydown", probe, true);
    el.dispatchEvent(key("keydown", { key: "a" }));
    document.removeEventListener("keydown", probe, true);
    return verdict === true;
  }

  it("native inputs and textareas are typing targets; a plain div is not", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const div = document.createElement("div");
    document.body.append(input, textarea, div);
    expect(typingAt(input)).toBe(true);
    expect(typingAt(textarea)).toBe(true);
    expect(typingAt(div)).toBe(false);
  });

  it("contenteditable hosts count, including a span nested inside one", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.append(inner);
    document.body.append(editor);
    expect(typingAt(editor)).toBe(true);
    expect(typingAt(inner)).toBe(true); // keys land on descendants of the editable root
  });

  it("ARIA textboxes count — web editors that skip contenteditable still get their keys", () => {
    const box = document.createElement("div");
    box.setAttribute("role", "textbox");
    document.body.append(box);
    expect(typingAt(box)).toBe(true);
  });

  it("sees through shadow retargeting via composedPath", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadowInput = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(shadowInput);
    // At the document the target is the (non-editable) host; only the
    // composed path knows an input is underneath.
    expect(typingAt(shadowInput)).toBe(true);
  });
});
