import { describe, expect, it } from "vitest";
import { UI_MODE_TABLE, type UiModeInputs, uiMode } from "./ui-mode";

const base: UiModeInputs = {
  armed: true,
  mode: "ink",
  talking: false,
  threadOpen: false,
  shooting: false,
};

describe("uiMode (the §B.4 derivation)", () => {
  it("disarmed is off, whatever else claims to be true", () => {
    expect(uiMode({ ...base, armed: false })).toBe("off");
    expect(uiMode({ ...base, armed: false, talking: true, threadOpen: true })).toBe("off");
  });

  it("armed with no thread is ready; a thread makes it composing", () => {
    expect(uiMode(base)).toBe("ready");
    expect(uiMode({ ...base, threadOpen: true })).toBe("composing");
  });

  it("talking overlays composing (REC), shooting overlays talking (the veil owns the pointer)", () => {
    expect(uiMode({ ...base, threadOpen: true, talking: true })).toBe("talking");
    expect(uiMode({ ...base, threadOpen: true, talking: true, shooting: true })).toBe("shooting");
    expect(uiMode({ ...base, shooting: true })).toBe("shooting");
  });

  it("correct mode wins outright — it re-owns pointer and keys wholesale", () => {
    expect(uiMode({ ...base, mode: "correct", threadOpen: true })).toBe("correcting");
    expect(uiMode({ ...base, mode: "correct", talking: true })).toBe("correcting");
  });

  it("the table's Esc ladder steps every mode toward off", () => {
    // Walk each mode up its escParent chain; every chain must terminate at
    // off (no cycles, no dead ends) — the mechanical form of "Esc always
    // steps out one level".
    for (const start of Object.keys(UI_MODE_TABLE.modes) as (keyof typeof UI_MODE_TABLE.modes)[]) {
      let mode = start;
      const seen = new Set<string>([mode]);
      while (UI_MODE_TABLE.modes[mode].escParent !== null) {
        mode = UI_MODE_TABLE.modes[mode].escParent as typeof mode;
        expect(seen.has(mode)).toBe(false);
        seen.add(mode);
      }
      expect(mode).toBe("off");
    }
  });

  it("every armed mode asserts the crosshair; off asserts nothing", () => {
    for (const [name, spec] of Object.entries(UI_MODE_TABLE.modes)) {
      expect(spec.cursor).toBe(name === "off" ? undefined : "crosshair");
    }
  });
});
