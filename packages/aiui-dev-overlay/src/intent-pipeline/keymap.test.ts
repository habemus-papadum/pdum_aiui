import { describe, expect, it } from "vitest";
import { intentKeyHints, type KeyState, keyCommand, keymapHelp, TIER_BY_DIGIT } from "./keymap";

const base: KeyState = {
  armed: true,
  mode: "ink",
  talking: false,
  talkMode: "hold",
  typing: false,
};

describe("keyCommand", () => {
  it("arms with backtick from anywhere, and does nothing else disarmed", () => {
    expect(keyCommand({ ...base, armed: false }, "`", "down", false)).toEqual({
      cmd: "arm-toggle",
    });
    expect(keyCommand({ ...base, armed: false }, " ", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, armed: false }, "s", "down", false)).toBeUndefined();
  });

  it("never fires while typing in an input", () => {
    expect(keyCommand({ ...base, typing: true }, " ", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, typing: true }, "Enter", "down", false)).toBeUndefined();
  });

  it("hold mode: space down starts, space up ends, repeats swallowed", () => {
    expect(keyCommand(base, " ", "down", false)).toEqual({ cmd: "talk-start" });
    expect(keyCommand({ ...base, talking: true }, " ", "up", false)).toEqual({ cmd: "talk-end" });
    // Key-repeats while held are claimed-but-inert (swallow): they must not
    // toggle anything AND must not fall through unprevented — including in the
    // window where talk-start's async mic acquisition hasn't yet set `talking`
    // (an unswallowed Space repeat scrolls the page).
    expect(keyCommand({ ...base, talking: true }, " ", "down", true)).toEqual({ cmd: "swallow" });
    expect(keyCommand(base, " ", "down", true)).toEqual({ cmd: "swallow" });
    // Release ALWAYS ends the hold — even when `talking` is momentarily false
    // (the silence endpointer's gap between auto-split segments); the modality
    // treats a redundant talk-end as a no-op.
    expect(keyCommand(base, " ", "up", false)).toEqual({ cmd: "talk-end" });
  });

  it("toggle mode: space down flips, space up is inert", () => {
    const toggle: KeyState = { ...base, talkMode: "toggle" };
    expect(keyCommand(toggle, " ", "down", false)).toEqual({ cmd: "talk-start" });
    expect(keyCommand({ ...toggle, talking: true }, " ", "down", false)).toEqual({
      cmd: "talk-end",
    });
    expect(keyCommand({ ...toggle, talking: true }, " ", "up", false)).toBeUndefined();
  });

  it("maps the rest of the tiny keyboard", () => {
    // D arms the region veil on the way down, disarms on the way up.
    expect(keyCommand(base, "d", "down", false)).toEqual({ cmd: "shoot-arm" });
    expect(keyCommand(base, "D", "up", false)).toEqual({ cmd: "shoot-release" });
    // S is the whole-viewport shot: a single keydown, nothing on keyup.
    expect(keyCommand(base, "s", "down", false)).toEqual({ cmd: "shoot-viewport" });
    expect(keyCommand(base, "S", "up", false)).toBeUndefined();
    expect(keyCommand(base, "c", "down", false)).toEqual({ cmd: "ink-clear" });
    // J enters VS Code jump mode; V toggles the realtime screen share (the
    // modality gates the latter on submode).
    expect(keyCommand(base, "j", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(base, "J", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(base, "v", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "V", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(base, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    expect(keyCommand(base, "x", "down", false)).toBeUndefined();
  });

  it("V toggles the screen share only on ink-mode keydown, never repeats/keyup", () => {
    expect(keyCommand(base, "v", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "v", "down", true)).toBeUndefined(); // key-repeat
    expect(keyCommand(base, "v", "up", false)).toBeUndefined(); // keyup
    // Inert in the handover modes (the page owns the key there).
    expect(keyCommand({ ...base, mode: "tweak" }, "v", "down", false)).toBeUndefined();
    // Nothing while disarmed.
    expect(keyCommand({ ...base, armed: false }, "v", "down", false)).toBeUndefined();
  });

  it("keeps the two screenshot gestures from overlapping (the split that killed the race)", () => {
    // D's keyup is only ever a disarm — never a viewport fallback (the old S-tap
    // heuristic that double-fired on a fast drag is gone).
    expect(keyCommand(base, "d", "up", false)).toEqual({ cmd: "shoot-release" });
    // Holding D doesn't re-arm on key-repeat.
    expect(keyCommand(base, "d", "down", true)).toBeUndefined();
    // S fires once on keydown; a held S (repeat) must not spam viewport shots,
    // and its keyup does nothing.
    expect(keyCommand(base, "s", "down", true)).toBeUndefined();
    expect(keyCommand(base, "s", "up", false)).toBeUndefined();
  });
});

describe("keyCommand: the config strip layer", () => {
  const open: KeyState = { ...base, configOpen: true };

  it("K toggles the strip while armed, and is inert disarmed or typing", () => {
    expect(keyCommand(base, "k", "down", false)).toEqual({ cmd: "config-toggle" });
    expect(keyCommand(base, "K", "down", false)).toEqual({ cmd: "config-toggle" });
    expect(keyCommand(base, "k", "down", true)).toBeUndefined(); // key-repeat
    expect(keyCommand({ ...base, armed: false }, "k", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, typing: true }, "k", "down", false)).toBeUndefined();
  });

  it("digits 1..2 pick tiers, cheapest first, matching TIER_BY_DIGIT (mock unsurfaced)", () => {
    expect(TIER_BY_DIGIT).toEqual(["rapid", "premium"]);
    expect(keyCommand(open, "1", "down", false)).toEqual({ cmd: "config-tier", tier: "rapid" });
    expect(keyCommand(open, "2", "down", false)).toEqual({ cmd: "config-tier", tier: "premium" });
    expect(keyCommand(open, "3", "down", false)).toBeUndefined();
    expect(keyCommand(open, "0", "down", false)).toBeUndefined();
    // Digits mean nothing when the strip is closed.
    expect(keyCommand(base, "1", "down", false)).toBeUndefined();
  });

  it("S saves, R resets, G opens the advanced editor, Esc/K close", () => {
    expect(keyCommand(open, "s", "down", false)).toEqual({ cmd: "config-save" });
    expect(keyCommand(open, "r", "down", false)).toEqual({ cmd: "config-reset" });
    expect(keyCommand(open, "g", "down", false)).toEqual({ cmd: "config-advanced" });
    expect(keyCommand(open, "Escape", "down", false)).toEqual({ cmd: "config-close" });
    expect(keyCommand(open, "k", "down", false)).toEqual({ cmd: "config-close" });
  });

  it("claims S for save; its keyup is inert, so no viewport shot leaks through", () => {
    expect(keyCommand(open, "s", "down", false)).toEqual({ cmd: "config-save" });
    expect(keyCommand(open, "s", "up", false)).toBeUndefined();
    expect(keyCommand(open, "S", "up", false)).toBeUndefined();
    // A repeat S-down while the strip is open must not fall through to a shot.
    expect(keyCommand(open, "s", "down", true)).toBeUndefined();
  });

  it("does NOT shadow D: the region veil stays reachable while the strip is open", () => {
    expect(keyCommand(open, "d", "down", false)).toEqual({ cmd: "shoot-arm" });
    expect(keyCommand(open, "d", "up", false)).toEqual({ cmd: "shoot-release" });
  });

  it("is a layer, not a mode: unclaimed keys keep their armed meaning", () => {
    expect(keyCommand(open, " ", "down", false)).toEqual({ cmd: "talk-start" });
    // Enter IS claimed while the strip is open: picking a rung already changed
    // the mode, so Enter (like Esc/K) just closes the strip — it must never
    // send the turn from inside the config layer.
    expect(keyCommand(open, "Enter", "down", false)).toEqual({ cmd: "config-close" });
    expect(keyCommand(open, "c", "down", false)).toEqual({ cmd: "ink-clear" });
  });
});

describe("keyCommand: tweak mode (the explicit handover)", () => {
  const tweak: KeyState = { ...base, mode: "tweak" };

  it("T enters tweak from armed ink mode, once per press (repeats/keyups pass)", () => {
    expect(keyCommand(base, "t", "down", false)).toEqual({ cmd: "tweak-toggle" });
    expect(keyCommand(base, "T", "down", false)).toEqual({ cmd: "tweak-toggle" });
    expect(keyCommand(base, "t", "down", true)).toBeUndefined(); // key-repeat
    expect(keyCommand(base, "t", "up", false)).toBeUndefined(); // keyup
  });

  it("T is inert in vscode mode (the handover owns the keys) and while disarmed", () => {
    expect(keyCommand({ ...base, mode: "vscode" }, "t", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, armed: false }, "t", "down", false)).toBeUndefined();
  });

  it("in tweak: T resumes, Esc steps out, backtick still arm-toggles; repeats pass", () => {
    expect(keyCommand(tweak, "t", "down", false)).toEqual({ cmd: "tweak-toggle" });
    expect(keyCommand(tweak, "T", "down", false)).toEqual({ cmd: "tweak-toggle" });
    expect(keyCommand(tweak, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    // The arm layer sits above the tweak layer — backtick works from anywhere.
    expect(keyCommand(tweak, "`", "down", false)).toEqual({ cmd: "arm-toggle" });
    // A held T (or Esc) must not toggle in and out on every repeat.
    expect(keyCommand(tweak, "t", "down", true)).toBeUndefined();
    expect(keyCommand(tweak, "Escape", "down", true)).toBeUndefined();
  });

  it("the page keeps EVERYTHING else — rule §3.2's exhaustiveness, flipped", () => {
    // The whole tiny keyboard falls through to the app: the handover is the
    // point of the mode. Assert every key, both phases — an accidental claim
    // here would swallow a keystroke the user aimed at their own UI.
    const pageKeys = [
      " ",
      "d",
      "D",
      "s",
      "S",
      "c",
      "C",
      "e",
      "E",
      "j",
      "J",
      "v",
      "V",
      "k",
      "K",
      "Enter",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
    ];
    for (const k of pageKeys) {
      expect(keyCommand(tweak, k, "down", false)).toBeUndefined();
      expect(keyCommand(tweak, k, "up", false)).toBeUndefined();
    }
    // Even the config strip's layer yields during tweak: a stale configOpen
    // flag must not let the digit row claim keys the page owns.
    const tweakWithStrip: KeyState = { ...tweak, configOpen: true };
    expect(keyCommand(tweakWithStrip, "1", "down", false)).toBeUndefined();
    expect(keyCommand(tweakWithStrip, "s", "down", false)).toBeUndefined();
    expect(keyCommand(tweakWithStrip, "Enter", "down", false)).toBeUndefined();
  });
});

describe("keyCommand: vscode jump mode (the tweak-shaped handover with the dblclick jump)", () => {
  const vscode: KeyState = { ...base, mode: "vscode" };

  it("J enters vscode mode from armed ink mode, once per press (repeats/keyups pass)", () => {
    expect(keyCommand(base, "j", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(base, "J", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(base, "j", "down", true)).toBeUndefined(); // key-repeat
    expect(keyCommand(base, "j", "up", false)).toBeUndefined(); // keyup
  });

  it("J is inert in tweak mode (the handover owns the keys) and while disarmed", () => {
    expect(keyCommand({ ...base, mode: "tweak" }, "j", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, armed: false }, "j", "down", false)).toBeUndefined();
  });

  it("in vscode mode: J resumes, Esc steps out, backtick still arm-toggles; repeats pass", () => {
    expect(keyCommand(vscode, "j", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(vscode, "J", "down", false)).toEqual({ cmd: "vscode-toggle" });
    expect(keyCommand(vscode, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    expect(keyCommand(vscode, "`", "down", false)).toEqual({ cmd: "arm-toggle" });
    expect(keyCommand(vscode, "j", "down", true)).toBeUndefined();
    expect(keyCommand(vscode, "Escape", "down", true)).toBeUndefined();
  });

  it("the page keeps EVERYTHING else — the same exhaustive handover as tweak", () => {
    // The double-click is the mode's only claimed gesture (pointer-side, in
    // the modality); the keyboard belongs to the page except V/Esc above.
    const pageKeys = [
      " ",
      "d",
      "D",
      "s",
      "S",
      "c",
      "C",
      "e",
      "E",
      "t",
      "T",
      "v",
      "V",
      "k",
      "K",
      "Enter",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
    ];
    for (const k of pageKeys) {
      expect(keyCommand(vscode, k, "down", false)).toBeUndefined();
      expect(keyCommand(vscode, k, "up", false)).toBeUndefined();
    }
    // The strip layer yields during vscode mode too, like tweak.
    const vscodeWithStrip: KeyState = { ...vscode, configOpen: true };
    expect(keyCommand(vscodeWithStrip, "1", "down", false)).toBeUndefined();
    expect(keyCommand(vscodeWithStrip, "s", "down", false)).toBeUndefined();
    expect(keyCommand(vscodeWithStrip, "Enter", "down", false)).toBeUndefined();
  });
});

describe("keyCommand: H (the universal help convention)", () => {
  it("H toggles help wherever the armed base is live", () => {
    expect(keyCommand(base, "h", "down", false)).toEqual({ cmd: "help-toggle" });
    expect(keyCommand(base, "H", "down", false)).toEqual({ cmd: "help-toggle" });
  });

  it("H stays the page's in the handover modes, and does nothing disarmed", () => {
    expect(keyCommand({ ...base, mode: "tweak" }, "h", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, mode: "vscode" }, "h", "down", false)).toBeUndefined();
    expect(keyCommand({ ...base, armed: false }, "h", "down", false)).toBeUndefined();
  });
});

describe("intentKeyHints / keymapHelp (the displayed keymap IS the working keymap)", () => {
  const labels = (state: KeyState): string[] => intentKeyHints(state).map((h) => h.label);

  it("armed ink mode lists the whole tiny keyboard, mode entrances included", () => {
    const rows = labels(base);
    expect(rows).toContain("hold to talk");
    expect(rows).toContain("hold + drag: region shot");
    expect(rows).toContain("jump to code");
    expect(rows).toContain("screen share (live)");
    expect(rows).toContain("tweak the app");
    expect(rows).toContain("help");
    expect(rows).toContain("send the turn");
  });

  it("the handover modes shrink to their claimed keys (plus the arm row)", () => {
    expect(labels({ ...base, mode: "tweak" })).toEqual(["disarm", "resume the turn", "resume"]);
    expect(labels({ ...base, mode: "vscode" })).toEqual(["disarm", "resume the turn", "resume"]);
    // The open picker's rows take over (its Escape shadows the vscode one).
    expect(labels({ ...base, mode: "vscode", pickerOpen: true })).toEqual([
      "disarm",
      "pick a row",
      "jump to row",
      "open in VS Code",
      "dismiss",
      "resume the turn",
    ]);
  });

  it("disarmed, the only row is how to arm", () => {
    expect(labels({ ...base, armed: false })).toEqual(["arm"]);
  });

  it("keymapHelp diffs the meta layers: the strip shows its own rows", () => {
    const sections = keymapHelp();
    const byTitle = new Map(sections.map((s) => [s.title, s.hints.map((h) => h.label)]));
    expect(byTitle.has("correct mode")).toBe(false); // removed in the append-only pivot
    expect(byTitle.get("config strip")).toEqual([
      "pick a tier",
      "linter: off → openai → gemini",
      "save for site",
      "reset to file",
      "advanced editor",
      "close",
    ]);
    expect(byTitle.get("off")).toEqual(["arm"]);
    // Enter/Esc claimed by the strip shadow the armed rows — the armed
    // section still shows them (it is computed in the armed base state).
    expect(byTitle.get("armed")).toContain("send the turn");
  });
});

describe("keyCommand: the jump-picker layer (vscode mode's double-click popup)", () => {
  const open: KeyState = { ...base, mode: "vscode", pickerOpen: true };

  it("claims arrows (repeats included — held ↓ scrolls), digits, Enter, Esc", () => {
    expect(keyCommand(open, "ArrowDown", "down", false)).toEqual({ cmd: "jump-move", delta: 1 });
    expect(keyCommand(open, "ArrowUp", "down", false)).toEqual({ cmd: "jump-move", delta: -1 });
    expect(keyCommand(open, "ArrowDown", "down", true)).toEqual({ cmd: "jump-move", delta: 1 });
    expect(keyCommand(open, "Enter", "down", false)).toEqual({ cmd: "jump-commit" });
    expect(keyCommand(open, "3", "down", false)).toEqual({ cmd: "jump-commit", index: 2 });
    // Esc dismisses the picker — NOT a step-out: jump mode survives.
    expect(keyCommand(open, "Escape", "down", false)).toEqual({ cmd: "jump-close" });
  });

  it("J still exits jump mode from under the popup (unclaimed → the vscode layer)", () => {
    expect(keyCommand(open, "j", "down", false)).toEqual({ cmd: "vscode-toggle" });
  });

  it("is inert while the picker is closed, and outside vscode mode", () => {
    const closed: KeyState = { ...base, mode: "vscode" };
    expect(keyCommand(closed, "ArrowDown", "down", false)).toBeUndefined();
    expect(keyCommand(closed, "1", "down", false)).toBeUndefined();
    // A stale pickerOpen outside vscode mode claims nothing.
    expect(keyCommand({ ...base, pickerOpen: true }, "ArrowDown", "down", false)).toBeUndefined();
  });
});
