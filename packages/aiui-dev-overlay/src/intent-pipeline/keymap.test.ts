import { describe, expect, it } from "vitest";
import { type KeyState, keyCommand, TIER_BY_DIGIT } from "./keymap";

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
    expect(keyCommand(base, "e", "down", false)).toEqual({ cmd: "correct-toggle" });
    expect(keyCommand(base, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(base, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    expect(keyCommand(base, "x", "down", false)).toBeUndefined();
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

  it("digits 1..5 pick tiers, cheapest first, matching TIER_BY_DIGIT", () => {
    expect(TIER_BY_DIGIT).toEqual(["mock", "standard", "rapid", "premium", "flagship"]);
    expect(keyCommand(open, "1", "down", false)).toEqual({ cmd: "config-tier", tier: "mock" });
    expect(keyCommand(open, "3", "down", false)).toEqual({ cmd: "config-tier", tier: "rapid" });
    expect(keyCommand(open, "5", "down", false)).toEqual({ cmd: "config-tier", tier: "flagship" });
    expect(keyCommand(open, "6", "down", false)).toBeUndefined();
    expect(keyCommand(open, "0", "down", false)).toBeUndefined();
    // Digits mean nothing when the strip is closed.
    expect(keyCommand(base, "3", "down", false)).toBeUndefined();
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
    expect(keyCommand(open, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(open, "c", "down", false)).toEqual({ cmd: "ink-clear" });
  });
});
