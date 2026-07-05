import { describe, expect, it } from "vitest";
import { type KeyState, keyCommand } from "./keymap";

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
