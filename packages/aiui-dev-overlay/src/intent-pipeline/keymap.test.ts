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
    // V toggles the realtime screen share (the modality gates on submode).
    expect(keyCommand(base, "v", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "V", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "Enter", "down", false)).toEqual({ cmd: "send" });
    expect(keyCommand(base, "Escape", "down", false)).toEqual({ cmd: "step-out" });
    expect(keyCommand(base, "x", "down", false)).toBeUndefined();
  });

  it("V toggles the screen share only on ink-mode keydown, never repeats/keyup/correct", () => {
    expect(keyCommand(base, "v", "down", false)).toEqual({ cmd: "video-toggle" });
    expect(keyCommand(base, "v", "down", true)).toBeUndefined(); // key-repeat
    expect(keyCommand(base, "v", "up", false)).toBeUndefined(); // keyup
    // Inert in correct mode (that mode owns the pointer/keys for text selection).
    expect(keyCommand({ ...base, mode: "correct" }, "v", "down", false)).toBeUndefined();
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

  it("digits 1..5 pick tiers, cheapest first, matching TIER_BY_DIGIT", () => {
    expect(TIER_BY_DIGIT).toEqual([
      "mock",
      "standard",
      "rapid",
      "premium",
      "flagship",
      "live-gemini",
      "live-openai",
    ]);
    expect(keyCommand(open, "1", "down", false)).toEqual({ cmd: "config-tier", tier: "mock" });
    expect(keyCommand(open, "3", "down", false)).toEqual({ cmd: "config-tier", tier: "rapid" });
    expect(keyCommand(open, "5", "down", false)).toEqual({ cmd: "config-tier", tier: "flagship" });
    expect(keyCommand(open, "6", "down", false)).toEqual({
      cmd: "config-tier",
      tier: "live-gemini",
    });
    expect(keyCommand(open, "7", "down", false)).toEqual({
      cmd: "config-tier",
      tier: "live-openai",
    });
    expect(keyCommand(open, "8", "down", false)).toBeUndefined();
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

  it("T is inert in correct mode (it owns its keys) and while disarmed", () => {
    expect(keyCommand({ ...base, mode: "correct" }, "t", "down", false)).toBeUndefined();
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
