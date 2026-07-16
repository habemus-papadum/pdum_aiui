// @vitest-environment jsdom
/**
 * shell.test.tsx — the shared panel shell's keyboard grammar. (Panel zoom used
 * to be tested here too; it moved to ext/side-panel-zoom.test.tsx when it became
 * a side-panel-only control — see that file for the apply half + the buttons.)
 */
import { describe, expect, it } from "vitest";
import type { IntentClient } from "../client";
import { installPanelKeys } from "./shell";

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
