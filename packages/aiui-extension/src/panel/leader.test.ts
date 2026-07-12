import { describe, expect, it } from "vitest";
import {
  LEADER_PENDING_TTL_MS,
  type LeaderState,
  leaderHelp,
  leaderHints,
  leaderHintText,
  leaderKeyEvent,
  leaderPendingFresh,
} from "./leader";

const state = (over: Partial<LeaderState> = {}): LeaderState => ({
  phase: "turn",
  inkOn: false,
  selectionPresent: false,
  talking: false,
  holdTalk: false,
  micMuted: false,
  ...over,
});

describe("leaderKeyEvent", () => {
  it("passes everything outside a turn — armed is presence, not capture (§13.6)", () => {
    for (const phase of ["armed", "tweak"] as const) {
      for (const key of ["i", "s", "a", "c", "t", "d", "Enter", "Escape", "x", "Shift"]) {
        expect(leaderKeyEvent(state({ phase }), key, "down", false)).toEqual({ kind: "pass" });
        expect(leaderKeyEvent(state({ phase }), key, "up", false)).toEqual({ kind: "pass" });
      }
    }
  });

  it("maps the bound keys to their actions (both cases)", () => {
    const table: Array<[string, string]> = [
      ["i", "ink"],
      ["I", "ink"],
      ["s", "shot"],
      ["S", "shot"],
      ["a", "selection"],
      ["A", "selection"],
      ["t", "tweak"],
      ["T", "tweak"],
      ["d", "disarm"],
      ["D", "disarm"],
      ["Enter", "send"],
      ["Escape", "cancel"],
      ["?", "help"],
    ];
    for (const [key, action] of table) {
      expect(leaderKeyEvent(state(), key, "down", false)).toEqual({ kind: "action", action });
    }
  });

  it("offers c only in ink mode; otherwise it blips like a typo", () => {
    expect(leaderKeyEvent(state({ inkOn: true }), "c", "down", false)).toEqual({
      kind: "action",
      action: "clear",
    });
    expect(leaderKeyEvent(state({ inkOn: false }), "c", "down", false)).toEqual({
      kind: "ignored",
      key: "c",
    });
  });

  it("an unknown key is swallowed and blipped — never a leak, never an exit", () => {
    for (const key of ["x", "1", "ArrowDown"]) {
      expect(leaderKeyEvent(state(), key, "down", false)).toEqual({ kind: "ignored", key });
    }
  });

  it("modifier keys are swallowed silently (the leader chord's own keys)", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(leaderKeyEvent(state(), key, "down", false)).toEqual({ kind: "stay" });
    }
  });

  it("repeats are swallowed without firing twice (bound and unbound alike)", () => {
    expect(leaderKeyEvent(state(), "i", "down", true)).toEqual({ kind: "stay" });
    expect(leaderKeyEvent(state(), "x", "down", true)).toEqual({ kind: "stay" });
  });

  it("keyups are swallowed wholesale while composing — except Space's (talk release)", () => {
    for (const key of ["i", "b", "Meta", "Escape"]) {
      expect(leaderKeyEvent(state(), key, "up", false)).toEqual({ kind: "stay" });
    }
    expect(leaderKeyEvent(state(), " ", "up", false)).toEqual({
      kind: "action",
      action: "talkRelease",
    });
  });
});

describe("leaderHints", () => {
  it("shows the base row set, adding c while inking", () => {
    const keys = (s: LeaderState) => leaderHints(s).map((h) => h.key);
    expect(keys(state())).toEqual(["i", "s", "a", "t", "d", "⏎", "␣", "h", "?", "esc"]);
    expect(keys(state({ inkOn: true }))).toEqual([
      "i",
      "s",
      "a",
      "c",
      "t",
      "d",
      "⏎",
      "␣",
      "h",
      "?",
      "esc",
    ]);
  });

  it("lights the ink cap while ink is on, and relabels it", () => {
    const ink = leaderHints(state({ inkOn: true })).find((h) => h.key === "i");
    expect(ink?.active).toBe(true);
    expect(ink?.label).toBe("ink off");
  });

  it("lights the selection cap when the page reports a selection", () => {
    const a = leaderHints(state({ selectionPresent: true })).find((h) => h.key === "a");
    expect(a?.active).toBe(true);
  });

  it("renders one strip line for the panel header", () => {
    expect(leaderHintText(state())).toBe(
      "i ink · s shot · a add selection · t tweak the page · d disarm (abandon all) · ⏎ send · " +
        "␣ talk (hold) · h hands-free talk · ? help · esc cancel turn",
    );
  });

  it("shows nothing outside a turn", () => {
    expect(leaderHints(state({ phase: "armed" }))).toEqual([]);
    expect(leaderHints(state({ phase: "tweak" }))).toEqual([]);
  });
});

describe("leaderPendingFresh", () => {
  it("accepts a recent pending press and rejects stale/absent ones", () => {
    const now = 1_000_000;
    expect(leaderPendingFresh({ at: now - 100 }, now)).toBe(true);
    expect(leaderPendingFresh({ at: now - LEADER_PENDING_TTL_MS }, now)).toBe(true);
    expect(leaderPendingFresh({ at: now - LEADER_PENDING_TTL_MS - 1 }, now)).toBe(false);
    expect(leaderPendingFresh(null, now)).toBe(false);
    expect(leaderPendingFresh(undefined, now)).toBe(false);
  });
});

describe("leaderHelp (the table generated from the real stack)", () => {
  it("sections cover every phase, and every in-turn binding appears", () => {
    const sections = leaderHelp();
    expect(sections.map((s) => s.title)).toEqual([
      "in a turn",
      "while inking",
      "armed, no turn",
      "tweak",
    ]);
    const inTurn = sections[0].hints.map((h) => h.key);
    expect(inTurn).toContain("⌘B"); // authored: the leader is a browser-global
    for (const key of ["i", "s", "a", "t", "d", "⏎", "␣", "h", "?", "esc"]) {
      expect(inTurn).toContain(key);
    }
    // The ink-only rows are DIFFED against the base — no repeats.
    expect(sections[1].hints.map((h) => h.key)).toEqual(["c"]);
  });
});
