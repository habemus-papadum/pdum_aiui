// @vitest-environment jsdom
/**
 * shell.test.tsx — panel zoom, both halves. The frozen client's "zoom
 * restore" ledger row: stepping always worked; the RESTORE half (a saved
 * scale landing on the document at boot) was the part that broke. Here the
 * apply half is one shared effect (`installUiScaleRoot`), so the restore is
 * pinned by construction — the effect fires immediately with whatever value
 * `loadConfigBase()` put in the control.
 */
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { IntentClient } from "../client";
import { uiScale } from "../config";
import { installConfigAutoSave, loadConfigBase } from "../config-store";
import { installPanelKeys, installUiScaleRoot } from "./shell";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  uiScale.set(uiScale.initial as never);
  flush();
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("panel zoom — the uiScale root effect", () => {
  it("applies the CURRENT value immediately (the restore half), then follows steps", async () => {
    // Boot order as both entries run it: config restored FIRST, effect second.
    // The persistence is AUTO-SAVE now: the change itself writes the store.
    const stopAutoSave = installConfigAutoSave(localStorage, 0);
    uiScale.set(1.4 as never);
    flush();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the debounce tick
    stopAutoSave();
    uiScale.set(1 as never);
    loadConfigBase(); // a fresh document restoring what auto-save persisted
    flush();

    dispose = installUiScaleRoot();
    flush(); // effects run post-flush; boot's first flush is where this lands
    // ledger: "zoom restore" — the saved scale must LAND on the document,
    // not merely sit in the control.
    expect(document.documentElement.style.fontSize).toBe("140%");

    // …and the live stepping keeps flowing through the same effect.
    uiScale.set(1.1 as never);
    flush();
    expect(document.documentElement.style.fontSize).toBe("110%");
    uiScale.set(1 as never);
    flush();
    expect(document.documentElement.style.fontSize).toBe("100%");
  });
});

describe("panel keys — the grammar stands down for editable fields", () => {
  it("a key born in an input/contenteditable never reaches the grammar", () => {
    const handled: string[] = [];
    const client = {
      state: () => ({ phase: "turn" }),
      canDispatch: () => true,
      dispatch: (cmd: string) => handled.push(`dispatch:${cmd}`),
      handleKey: (key: string) => handled.push(`key:${key}`),
      emit: () => {},
    } as unknown as IntentClient;
    const uninstall = installPanelKeys({ client });
    try {
      const input = document.createElement("input");
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      document.body.append(input, editable);
      // In a TURN, "s" is the shot key and arrows blip — but not from a field.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
      editable.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(handled).toEqual([]);
      // From the document itself the grammar still works.
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }),
      );
      expect(handled).toEqual(["key:s"]);
    } finally {
      uninstall();
      document.body.replaceChildren();
    }
  });
});
