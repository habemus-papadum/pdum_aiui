import { describe, expect, it } from "vitest";
import { GROUPS, gradientRows, gradientView } from "./gradients";
import { DEFAULT_PARAMS, initialStep, stepTraining, TERM_IDS, type TrainStep } from "./training";

const P = DEFAULT_PARAMS;

function at(step: number): TrainStep {
  return step === 0 ? initialStep() : stepTraining({ ...initialStep(), step: step - 1 }, P);
}

describe("the synthetic gradient view", () => {
  it("pairwise cosines are symmetric with a unit diagonal, all within [-1, 1]", () => {
    const v = gradientView(at(12), P);
    for (let i = 0; i < 4; i++) {
      expect(v.cos[i]?.[i]).toBe(1);
      for (let j = 0; j < 4; j++) {
        const c = v.cos[i]?.[j] as number;
        expect(c).toBeCloseTo(v.cos[j]?.[i] as number, 12);
        expect(Math.abs(c)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("alignment is derived from the geometry: Σ norm·align = ‖g_total‖", () => {
    for (const step of [0, 5, 50, 500]) {
      const v = gradientView(at(step), P);
      const lhs = TERM_IDS.reduce((s, id) => s + v.terms[id].norm * v.terms[id].align, 0);
      expect(lhs).toBeCloseTo(v.total, 9);
      for (const id of TERM_IDS) {
        expect(Math.abs(v.terms[id].align)).toBeLessThanOrEqual(1);
        expect(Math.abs(v.terms[id].stability)).toBeLessThanOrEqual(1);
        expect(v.terms[id].norm).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("each term's group profile is a distribution over the groups", () => {
    const v = gradientView(at(3), P);
    for (const id of TERM_IDS) {
      const g = v.terms[id].byGroup;
      expect(g).toHaveLength(GROUPS.length);
      expect(g.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
      for (const w of g) expect(w).toBeGreaterThanOrEqual(0);
    }
    // The value head belongs to the value term alone.
    const head = GROUPS.indexOf("value head");
    expect(v.terms.value.byGroup[head]).toBeGreaterThan(0.2);
    expect(v.terms.policy.byGroup[head]).toBe(0);
  });

  it("clipped samples contribute no surrogate gradient: more clipping, smaller policy norm", () => {
    const t = at(4);
    const calm = gradientView({ ...t, clip: { ...t.clip, clipped: 0 } }, P);
    const clipped = gradientView({ ...t, clip: { ...t.clip, clipped: 0.8 } }, P);
    expect(clipped.terms.policy.norm).toBeLessThan(calm.terms.policy.norm / 3);
  });

  it("the KL penalty opposes the policy gradient more as the policy drifts", () => {
    const t = at(4);
    const near = gradientView({ ...t, kl: 0.05 }, P);
    const far = gradientView({ ...t, kl: 1.5 }, P);
    const pk = (v: ReturnType<typeof gradientView>) =>
      v.cos[TERM_IDS.indexOf("policy")]?.[TERM_IDS.indexOf("kl")] as number;
    expect(pk(far)).toBeLessThan(pk(near));
    expect(pk(far)).toBeLessThan(0);
  });

  it("rows over a run carry one alignment and norm per term per step", () => {
    const rows = gradientRows([at(0), at(1), at(2)], P);
    expect(rows.map((r) => r.step)).toEqual([0, 1, 2]);
    for (const id of TERM_IDS) expect(typeof rows[1]?.align[id]).toBe("number");
  });
});
