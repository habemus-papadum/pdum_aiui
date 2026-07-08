// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type KeyLayer, keyHints, resolveKey } from "./keys";

// A small synthetic stack in the shape real surfaces use: a base layer that
// owns the surface's keyboard, a predicate-activated config strip that claims
// a few keys on top of it, and a blocking dialog whose fallback swallows the
// whole keyboard. resolveKey is pure, so the whole behavior is table rows.
interface SynthState {
  stripOpen: boolean;
  dialogOpen: boolean;
  saving: boolean;
}

const base: KeyLayer<SynthState, string> = {
  name: "base",
  fallback: "pass",
  bindings: [
    {
      keys: [" "],
      // Held-space repeats are claimed-but-inert: they must not re-fire the
      // command AND must not fall through unprevented (page scroll).
      down: (_state, _key, repeat) => (repeat ? "swallow" : { command: "talk-start" }),
      up: () => ({ command: "talk-end" }),
    },
    // Down-only on purpose: the keyup must fall through to the page.
    { keys: ["s", "S"], down: () => ({ command: "shoot-viewport" }) },
    { keys: ["1"], down: () => ({ command: "tool-one" }) },
    { keys: ["Escape"], down: () => ({ command: "step-out" }) },
  ],
};

const strip: KeyLayer<SynthState, string> = {
  name: "strip",
  active: (state) => state.stripOpen,
  fallback: "pass",
  bindings: [
    // While a save is in flight the strip declines the digit, so the key
    // falls through to whatever it means below — a binding may answer "pass".
    { keys: ["1"], down: (state) => (state.saving ? "pass" : { command: "strip-pick-one" }) },
    { keys: ["s"], down: () => ({ command: "strip-save" }) },
    { keys: ["Escape"], down: () => ({ command: "strip-close" }) },
  ],
};

const dialog: KeyLayer<SynthState, string> = {
  name: "dialog",
  active: (state) => state.dialogOpen,
  fallback: "swallow",
  bindings: [
    { keys: ["Enter"], down: () => ({ command: "dialog-confirm" }) },
    { keys: ["Escape"], down: () => ({ command: "dialog-cancel" }) },
  ],
};

const stack = [dialog, strip, base];
const idle: SynthState = { stripOpen: false, dialogOpen: false, saving: false };

describe("resolveKey", () => {
  it("resolves top-down: the open strip shadows base 's'; closed, base keeps it", () => {
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "s", "down", false)).toEqual({
      command: "strip-save",
    });
    expect(resolveKey(stack, idle, "s", "down", false)).toEqual({ command: "shoot-viewport" });
  });

  it("active() gates layers, so Escape means whatever the topmost active layer says", () => {
    const everything = { stripOpen: true, dialogOpen: true, saving: false };
    expect(resolveKey(stack, everything, "Escape", "down", false)).toEqual({
      command: "dialog-cancel",
    });
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "Escape", "down", false)).toEqual({
      command: "strip-close",
    });
    expect(resolveKey(stack, idle, "Escape", "down", false)).toEqual({ command: "step-out" });
  });

  it("a swallow fallback claims the whole keyboard; pass fallbacks hand unbound keys to the page", () => {
    // The blocking dialog eats keys it doesn't bind — nothing leaks below it.
    expect(resolveKey(stack, { ...idle, dialogOpen: true }, "x", "down", false)).toBe("swallow");
    expect(resolveKey(stack, { ...idle, dialogOpen: true }, "s", "down", false)).toBe("swallow");
    // With only pass-fallback layers active, an unbound key stays the page's.
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "x", "down", false)).toBe("pass");
    expect(resolveKey(stack, idle, "x", "down", false)).toBe("pass");
  });

  it("a down-only binding does not eat keyups", () => {
    // "s" is bound (twice!) but neither binding has an up handler: the keyup
    // must reach the page, not vanish into a matched-but-silent binding.
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "s", "up", false)).toBe("pass");
    expect(resolveKey(stack, idle, "s", "up", false)).toBe("pass");
    // …while a binding that DOES answer keyup still claims it.
    expect(resolveKey(stack, idle, " ", "up", false)).toEqual({ command: "talk-end" });
  });

  it("a binding answering 'pass' falls through to lower layers like an unbound key", () => {
    const savingStrip = { ...idle, stripOpen: true, saving: true };
    expect(resolveKey(stack, savingStrip, "1", "down", false)).toEqual({ command: "tool-one" });
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "1", "down", false)).toEqual({
      command: "strip-pick-one",
    });
  });

  it("the repeat flag reaches handlers: held space swallows instead of re-firing", () => {
    expect(resolveKey(stack, idle, " ", "down", false)).toEqual({ command: "talk-start" });
    expect(resolveKey(stack, idle, " ", "down", true)).toBe("swallow");
  });

  it("keys match exactly — a layer that binds only lowercase lets shift-S skip past it", () => {
    // base lists both cases; the strip only "s", so "S" keeps its base meaning.
    expect(resolveKey(stack, { ...idle, stripOpen: true }, "S", "down", false)).toEqual({
      command: "shoot-viewport",
    });
  });
});

describe("keyHints (the displayed keymap IS the working keymap)", () => {
  // The synthetic stack again, with hints on the bindings that document
  // themselves — including a state-dependent one.
  const hinted: KeyLayer<SynthState, string>[] = [
    {
      name: "strip",
      active: (state) => state.stripOpen,
      fallback: "pass",
      bindings: [
        { keys: ["s"], down: () => ({ command: "strip-save" }), hint: { key: "S", label: "save" } },
        // No hint on purpose: the claim still shadows the base row for Escape.
        { keys: ["Escape"], down: () => ({ command: "strip-close" }) },
      ],
    },
    {
      name: "base",
      fallback: "pass",
      bindings: [
        {
          keys: [" "],
          down: () => ({ command: "talk-start" }),
          hint: (state) => (state.saving ? undefined : { key: "␣", label: "talk", icon: "🎙" }),
        },
        {
          keys: ["s", "S"],
          down: () => ({ command: "shoot-viewport" }),
          hint: { key: "S", label: "viewport shot", icon: "🖼" },
        },
        {
          keys: ["Escape"],
          down: () => ({ command: "step-out" }),
          hint: { key: "esc", label: "back" },
        },
      ],
    },
  ];

  it("collects active layers' hints top-down, shadowing lower rows by key claim", () => {
    expect(keyHints(hinted, idle).map((h) => h.label)).toEqual(["talk", "viewport shot", "back"]);
    // Strip open: its S row wins; its hint-less Escape claim HIDES base's
    // "back" row (mirroring resolveKey — the key no longer does that).
    expect(keyHints(hinted, { ...idle, stripOpen: true }).map((h) => h.label)).toEqual([
      "save",
      "talk",
      "viewport shot",
    ]);
  });

  it("a function hint describes per state; undefined hides the row", () => {
    expect(keyHints(hinted, { ...idle, saving: true }).map((h) => h.label)).toEqual([
      "viewport shot",
      "back",
    ]);
  });

  it("a swallow-fallback layer ends the walk — nothing below is reachable", () => {
    const blocking: KeyLayer<SynthState, string>[] = [
      {
        name: "dialog",
        active: (state) => state.dialogOpen,
        fallback: "swallow",
        bindings: [
          {
            keys: ["Enter"],
            down: () => ({ command: "ok" }),
            hint: { key: "⏎", label: "confirm" },
          },
        ],
      },
      ...hinted,
    ];
    expect(keyHints(blocking, { ...idle, dialogOpen: true }).map((h) => h.label)).toEqual([
      "confirm",
    ]);
  });
});
