/**
 * bar.test.ts — the command bar as a tree presented linearly: depth rows,
 * lit-parents reveal children, enabled derived from the engine's
 * canDispatch, stable labels, widget descriptors.
 */
import { describe, expect, it } from "vitest";
import { type BarInputs, type BarNode, barModel } from "./bar";
import type { EngineState } from "./engine";

interface Ctx {
  bound: boolean;
}

const tree: readonly BarNode<Ctx>[] = [
  {
    command: "arm",
    hint: { key: "⏻", label: "arm" },
    litWhen: ({ state }) => state.phase !== "disarmed",
    children: [
      {
        command: "turn",
        hint: { key: "⌘B", label: "turn" },
        litWhen: ({ state }) => state.phase === "turn",
        children: [
          {
            command: "ink",
            hint: { key: "i", label: "ink" },
            litWhen: ({ state }) => state.ink === true,
            children: [{ kind: "widget", control: "inkFade", widget: "slider", label: "fade" }],
          },
          {
            command: "handsFree",
            hint: { key: "h", label: "hands-free" },
            litWhen: ({ state }) => state.talk === "handsFree",
            children: [{ command: "mute", hint: { key: "m", label: "mute" } }],
          },
        ],
      },
    ],
  },
  { command: "escape", hint: { key: "esc", label: "step out" } },
  { command: "help", hint: { key: "?", label: "help" } },
];

const inputs = (
  state: Partial<Record<string, string | boolean>>,
  can: (command: string) => boolean = () => true,
): BarInputs<Ctx> => ({
  state: Object.freeze({
    phase: "disarmed",
    ink: false,
    talk: "off",
    ...state,
  }) as EngineState,
  ctx: { bound: true },
  claims: {},
  canDispatch: can,
});

const rowCommands = (rows: ReturnType<typeof barModel>, depth: number): string[] =>
  rows
    .find((r) => r.depth === depth)
    ?.items.map((i) => (i.kind === "cap" ? i.command : `widget:${i.control}`)) ?? [];

describe("the tree, flattened into depth rows", () => {
  it("disarmed: only the root row exists", () => {
    const rows = barModel(tree, inputs({}));
    expect(rows).toHaveLength(1);
    expect(rowCommands(rows, 0)).toEqual(["arm", "escape", "help"]);
  });

  it("each lit tier reveals the next; unlit branches stay closed", () => {
    const rows = barModel(tree, inputs({ phase: "armed" }));
    expect(rowCommands(rows, 1)).toEqual(["turn"]); // armed reveals the turn tier
    expect(rows).toHaveLength(2); // turn not lit — its children stay closed

    const inTurn = barModel(tree, inputs({ phase: "turn" }));
    expect(rowCommands(inTurn, 2)).toEqual(["ink", "handsFree"]);
  });

  it("engaging a leaf mode reveals its own children — widgets included", () => {
    const rows = barModel(tree, inputs({ phase: "turn", ink: true, talk: "handsFree" }));
    expect(rowCommands(rows, 3)).toEqual(["widget:inkFade", "mute"]); // same depth, one row
  });
});

describe("enabled is derived, not hand-written", () => {
  it("caps default to the engine's canDispatch verdict", () => {
    const rows = barModel(
      tree,
      inputs({}, (command) => command === "arm"),
    );
    const [arm, stepOut, help] = rows[0].items;
    expect(arm).toMatchObject({ command: "arm", enabled: true });
    expect(stepOut).toMatchObject({ command: "escape", enabled: false });
    expect(help).toMatchObject({ command: "help", enabled: false });
  });

  it("enabledWhen remains as an explicit override", () => {
    const gated: readonly BarNode<Ctx>[] = [
      {
        command: "arm",
        hint: { key: "⏻", label: "arm" },
        enabledWhen: ({ ctx }) => ctx.bound,
      },
    ];
    const rows = barModel(gated, {
      ...inputs({}),
      ctx: { bound: false },
      canDispatch: () => true,
    });
    expect(rows[0].items[0]).toMatchObject({ enabled: false });
  });
});

describe("widgets", () => {
  it("travel as descriptors the host binds — never functions or DOM", () => {
    const rows = barModel(tree, inputs({ phase: "turn", ink: true }));
    const widget = rows.find((r) => r.depth === 3)?.items[0];
    expect(widget).toEqual({
      kind: "widget",
      control: "inkFade",
      widget: "slider",
      label: "fade",
      enabled: true,
    });
  });
});
