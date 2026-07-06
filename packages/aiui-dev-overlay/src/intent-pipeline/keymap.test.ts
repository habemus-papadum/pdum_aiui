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
    // key-repeat while held must not toggle anything off
    expect(keyCommand({ ...base, talking: true }, " ", "down", true)).toEqual({
      cmd: "talk-start",
    });
    expect(keyCommand(base, " ", "up", false)).toBeUndefined();
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
    expect(keyCommand(base, "s", "down", false)).toEqual({ cmd: "shoot-arm" });
    expect(keyCommand(base, "S", "up", false)).toEqual({ cmd: "shoot-release" });
    expect(keyCommand(base, "c", "down", false)).toEqual({ cmd: "ink-clear" });
    expect(keyCommand(base, "e", "down", false)).toEqual({ cmd: "correct-toggle" });
    expect(keyCommand(base, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(base, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    expect(keyCommand(base, "x", "down", false)).toBeUndefined();
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

  it("the strip claims S entirely (no stray shoot-release on keyup)", () => {
    expect(keyCommand(open, "s", "up", false)).toBeUndefined();
    expect(keyCommand(open, "S", "up", false)).toBeUndefined();
  });

  it("is a layer, not a mode: unclaimed keys keep their armed meaning", () => {
    expect(keyCommand(open, " ", "down", false)).toEqual({ cmd: "talk-start" });
    expect(keyCommand(open, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(open, "c", "down", false)).toEqual({ cmd: "ink-clear" });
  });
});
