/**
 * bar.test.ts — the command bar as a projection: caps are renders of
 * (state, ctx, claims), so lit/enabled/shown/reveals can never drift.
 */
import { describe, expect, it } from "vitest";
import { type BarInputs, barModel, type CapSpec } from "./bar";
import type { ClaimStatus } from "./claims";
import type { EngineState } from "./engine";

interface Ctx {
  bound: boolean;
}

const caps: readonly CapSpec<Ctx>[] = [
  {
    command: "ink",
    hint: { key: "i", label: "ink" },
    litWhen: ({ state }) => state.ink === true,
    enabledWhen: ({ ctx }) => ctx.bound,
    reveals: "ink-fade-slider",
  },
  {
    command: "set:video",
    payload: true,
    hint: ({ claims }) => ({
      key: "v",
      label: claims.videoSample?.phase === "pending" ? "video (warming…)" : "video",
    }),
    litWhen: ({ state }) => state.video === true,
  },
  {
    command: "send",
    hint: { key: "⏎", label: "send" },
    showWhen: ({ state }) => state.phase === "turn",
  },
];

const inputs = (
  state: Partial<Record<string, string | boolean>>,
  claims: Record<string, ClaimStatus> = {},
  ctx: Ctx = { bound: true },
): BarInputs<Ctx> => ({
  state: Object.freeze({ phase: "armed", ink: false, video: false, ...state }) as EngineState,
  ctx,
  claims,
});

describe("barModel", () => {
  it("projects lit/enabled and keeps declaration order", () => {
    const bar = barModel(caps, inputs({ ink: true }));
    expect(bar.map((c) => c.command)).toEqual(["ink", "set:video"]); // send hidden: not in turn
    expect(bar[0]).toMatchObject({ lit: true, enabled: true, reveals: "ink-fade-slider" });
    expect(bar[1]).toMatchObject({ lit: false, enabled: true, payload: true });
  });

  it("reveals only while lit — declared tenancy, not imperative mounting", () => {
    const [ink] = barModel(caps, inputs({ ink: false }));
    expect(ink.reveals).toBeUndefined();
  });

  it("gates enabled from context facts", () => {
    const [ink] = barModel(caps, inputs({}, {}, { bound: false }));
    expect(ink.enabled).toBe(false);
  });

  it("caps can render claim status — the operation's 'neither on nor off'", () => {
    const bar = barModel(caps, inputs({}, { videoSample: { phase: "pending" } }));
    expect(bar[1].hint.label).toBe("video (warming…)");
  });

  it("shows mode-scoped caps only in their mode", () => {
    const bar = barModel(caps, inputs({ phase: "turn" }));
    expect(bar.map((c) => c.command)).toContain("send");
  });
});
