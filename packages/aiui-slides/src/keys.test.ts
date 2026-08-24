/**
 * keys.test.ts — the deck keymap as a table: state × key → claim, resolved
 * through the real stack (the modal kit's promise: keymap redesigns get cheap
 * because this is where they are tested).
 */
import { keyHints, resolveKey } from "@habemus-papadum/aiui-viz/modal";
import { describe, expect, it } from "vitest";
import { type DeckCommand, type DeckKeyState, deckKeyLayers } from "./keys";

const stack = deckKeyLayers();
const closed: DeckKeyState = { hudOpen: false, atStart: false, atEnd: false };
const open: DeckKeyState = { hudOpen: true, atStart: false, atEnd: false };

const command = (state: DeckKeyState, key: string): DeckCommand | "pass" | "swallow" => {
  const claim = resolveKey(stack, state, key, "down", false);
  return claim === "pass" || claim === "swallow" ? claim : claim.command;
};

describe("deck base layer", () => {
  it("moves on arrows, paging keys, space, home/end", () => {
    for (const key of ["ArrowDown", "ArrowRight", "PageDown", " "]) {
      expect(command(closed, key)).toBe("next");
    }
    for (const key of ["ArrowUp", "ArrowLeft", "PageUp"]) {
      expect(command(closed, key)).toBe("prev");
    }
    expect(command(closed, "Home")).toBe("first");
    expect(command(closed, "End")).toBe("last");
    expect(command(closed, "o")).toBe("toggle-hud");
  });

  it("passes everything else to the page", () => {
    expect(command(closed, "j")).toBe("pass");
    expect(command(closed, "Escape")).toBe("pass"); // nothing to dismiss
    expect(command(closed, "Tab")).toBe("pass"); // focus stays the browser's
  });
});

describe("HUD layer", () => {
  it("claims Escape only while open; movement keys keep driving the deck", () => {
    expect(command(open, "Escape")).toBe("close-hud");
    expect(command(open, "ArrowDown")).toBe("next"); // the HUD is a projection
    expect(command(open, "o")).toBe("toggle-hud"); // o closes it again
  });
});

describe("hints (the widget's labels ARE the working keymap)", () => {
  it("shows the escape row only while the HUD is open, and marks o active", () => {
    const closedKeys = keyHints(stack, closed).map((h) => h.key);
    expect(closedKeys).not.toContain("esc");
    const openHints = keyHints(stack, open);
    expect(openHints.map((h) => h.key)).toContain("esc");
    expect(openHints.find((h) => h.key === "o")?.active).toBe(true);
  });

  it("carries tapKeys so widget taps resolve through the same table", () => {
    const hints = keyHints(stack, closed);
    expect(hints.find((h) => h.label === "next")?.tapKey).toBe("ArrowDown");
    expect(hints.find((h) => h.label === "back")?.tapKey).toBe("ArrowUp");
  });

  it("the forward hint reads 'end' once nothing is ahead", () => {
    const hints = keyHints(stack, { hudOpen: false, atStart: false, atEnd: true });
    expect(hints.find((h) => h.tapKey === "ArrowDown")?.label).toBe("end");
  });
});
