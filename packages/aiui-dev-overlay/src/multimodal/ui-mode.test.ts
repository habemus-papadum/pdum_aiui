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

  it("tweak mode wins the same way — it releases pointer and keys wholesale (§B.5)", () => {
    expect(uiMode({ ...base, mode: "tweak", threadOpen: true })).toBe("tweaking");
    // The engine holds exactly one mode, so tweak (like correct) shadows the
    // shell flags — a stale shooting/talking flag can't misreport the handover.
    expect(uiMode({ ...base, mode: "tweak", shooting: true, talking: true })).toBe("tweaking");
    expect(uiMode({ ...base, mode: "tweak", armed: false })).toBe("off");
  });

  it("vscode mode wins the same way — the tweak-shaped handover with the dblclick jump", () => {
    expect(uiMode({ ...base, mode: "vscode", threadOpen: true })).toBe("vscode");
    expect(uiMode({ ...base, mode: "vscode", shooting: true, talking: true })).toBe("vscode");
    expect(uiMode({ ...base, mode: "vscode", armed: false })).toBe("off");
  });

  it("vscode is the one blur-exiting mode: the jump leaves the window, so blur steps out", () => {
    for (const [name, spec] of Object.entries(UI_MODE_TABLE.modes)) {
      expect(spec.blurExits).toBe(name === "vscode" ? true : undefined);
    }
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

  it("every armed mode asserts the crosshair — except tweaking/vscode, which released the pointer", () => {
    for (const [name, spec] of Object.entries(UI_MODE_TABLE.modes)) {
      // No cursor for off (nothing armed) and none for tweaking/vscode (the
      // crosshair is capture's cursor; both hand capture back to the page).
      const bare = name === "off" || name === "tweaking" || name === "vscode";
      expect(spec.cursor).toBe(bare ? undefined : "crosshair");
    }
  });
});
