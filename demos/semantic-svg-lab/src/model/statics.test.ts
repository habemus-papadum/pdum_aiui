import { expect, it } from "vitest";
import { solveBeam } from "./statics";

it.each([
  [0, 120, 0],
  [25, 90, 30],
  [50, 60, 60],
  [100, 0, 120],
])("resolves the known load-sharing case at %s percent", (positionPercent, left, right) => {
  expect(solveBeam({ load: 120, positionPercent })).toMatchObject({
    left,
    right,
    horizontalAtA: 0,
  });
});
it("balances vertical force and moment across the supported input domain", () => {
  for (let load = 20; load <= 200; load += 5)
    for (let positionPercent = 0; positionPercent <= 100; positionPercent++) {
      const result = solveBeam({ load, positionPercent });
      expect(Math.abs(result.forceResidual)).toBeLessThan(1e-10);
      expect(Math.abs(result.momentResidual)).toBeLessThan(1e-10);
      expect(result.left).toBeGreaterThanOrEqual(0);
      expect(result.right).toBeGreaterThanOrEqual(0);
    }
});
it("scales linearly with the load and reflects when the load position is mirrored", () => {
  const a = solveBeam({ load: 80, positionPercent: 37 });
  const b = solveBeam({ load: 160, positionPercent: 37 });
  const mirrored = solveBeam({ load: 80, positionPercent: 63 });
  expect(b.left).toBe(a.left * 2);
  expect(b.right).toBe(a.right * 2);
  expect(mirrored.left).toBe(a.right);
  expect(mirrored.right).toBe(a.left);
});
it("rejects unsupported loads and positions instead of claiming a solution", () => {
  for (const load of [NaN, Infinity, 0, -20, 201, 122])
    expect(() => solveBeam({ load, positionPercent: 50 })).toThrow();
  for (const positionPercent of [-1, 101, NaN, 1.5])
    expect(() => solveBeam({ load: 120, positionPercent })).toThrow();
});
