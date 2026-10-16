import { describe, expect, it } from "vitest";
import {
  EPOCH_COST,
  edgesOf,
  neighbors,
  pipelineText,
  ROWS_IN,
  schedule,
  stagesOf,
  totalCost,
} from "./pipeline";

const P = { epochs: 5, withEval: true };

describe("pipeline model", () => {
  it("names every node and edge in the text with the model's ids", () => {
    const text = pipelineText(P);
    expect(text.startsWith("flowchart LR")).toBe(true);
    for (const s of stagesOf(P)) expect(text).toMatch(new RegExp(`^\\s+${s.id}[\\[({]`, "m"));
    for (const e of edgesOf(P)) expect(text).toContain(`${e.from} ${e.id}@-->`);
    expect(text).toContain("|holdout|");
    expect(text).toContain("subgraph model[model]");
  });

  it("drops the evaluate stage and reroutes train to ship without eval", () => {
    const q = { epochs: 5, withEval: false };
    expect(stagesOf(q).map((s) => s.id)).not.toContain("eval");
    expect(edgesOf(q).map((e) => e.id)).toContain("e_train_ship");
    expect(edgesOf(q).map((e) => e.id)).not.toContain("e_train_eval");
    expect(pipelineText(q)).not.toContain("eval");
  });

  it("schedules stages back to back, train costing epochs", () => {
    const s = schedule(P, 0);
    expect(s.raw?.status).toBe("pending");
    expect(s.train?.end).toBeCloseTo(2 + 4 + 6 + 5 * EPOCH_COST);
    // raw 0–2, clean 2–6, feat 6–12, train 12–15, eval 15–18, ship 18–19, deploy 19–21
    const mid = schedule(P, 7);
    expect(mid.feat?.status).toBe("active");
    expect(mid.feat?.progress).toBeCloseTo(1 / 6);
    expect(mid.clean?.status).toBe("done");
    expect(mid.train?.status).toBe("pending");
    expect(schedule(P, totalCost(P) + 1).deploy?.status).toBe("done");
  });

  it("carries rows through the keep fractions", () => {
    const s = schedule(P, 0);
    expect(s.raw?.rowsIn).toBe(ROWS_IN);
    expect(s.clean?.rowsOut).toBe(Math.round(ROWS_IN * 0.82));
    expect(s.feat?.rowsIn).toBe(s.clean?.rowsOut);
  });

  it("lists a stage's edges in and out", () => {
    expect(neighbors(P, "feat")).toEqual({
      in: ["e_clean_feat", "e_ship_feat"],
      out: ["e_feat_train", "e_feat_eval"],
    });
  });
});
