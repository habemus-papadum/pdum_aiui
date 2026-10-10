import type { CompiledPrompt } from "@habemus-papadum/aiui-prompts";
import { measurePrompt } from "@habemus-papadum/aiui-prompts/analysis";

export interface ContributionCost {
  /** Exact emitted UTF-16 code units, including generated syntax and escaping. */
  readonly codeUnits: number;
  /** Output image placements, not unique assets or image tokens. */
  readonly images: number;
}

export interface OccurrenceCost {
  readonly own: ContributionCost;
  readonly subtree: ContributionCost;
}

/**
 * Sum exclusive ownership once per hierarchy edge. Parent/child inclusive totals overlap;
 * they must never be added together as if they were exclusive costs. The leaf queue avoids
 * recursion and does not require occurrences to arrive in parent-before-child order.
 */
export function occurrenceCosts(
  compiled: CompiledPrompt,
  measurement: Pick<ReturnType<typeof measurePrompt>, "exclusive"> = measurePrompt(compiled),
): ReadonlyMap<string, OccurrenceCost> {
  type Pending = {
    parent?: string;
    children: number;
    own: ContributionCost;
    subtree: { codeUnits: number; images: number };
  };
  const pending = new Map<string, Pending>();
  for (const occurrence of compiled.occurrences) {
    if (pending.has(occurrence.id)) throw new Error("Duplicate compiled occurrence ID");
    const own = measurement.exclusive[occurrence.id] ?? { codeUnits: 0, images: 0 };
    pending.set(occurrence.id, {
      parent: occurrence.parent,
      children: 0,
      own: { ...own },
      subtree: { ...own },
    });
  }
  for (const item of pending.values()) {
    if (item.parent === undefined) continue;
    const parent = pending.get(item.parent);
    if (!parent) throw new Error("Compiled occurrence has a missing parent");
    parent.children++;
  }
  const ready = [...pending].filter(([, item]) => item.children === 0).map(([id]) => id);
  let processed = 0;
  for (let index = 0; index < ready.length; index++) {
    const item = pending.get(ready[index]) as Pending;
    processed++;
    if (item.parent === undefined) continue;
    const parent = pending.get(item.parent) as Pending;
    parent.subtree.codeUnits += item.subtree.codeUnits;
    parent.subtree.images += item.subtree.images;
    if (--parent.children === 0) ready.push(item.parent);
  }
  if (processed !== pending.size) throw new Error("Compiled occurrence hierarchy is cyclic");
  return new Map(
    [...pending].map(([id, item]) => [
      id,
      Object.freeze({ own: Object.freeze(item.own), subtree: Object.freeze(item.subtree) }),
    ]),
  );
}

export function contributionCostLabel(cost: ContributionCost): string {
  return `${cost.codeUnits} UTF-16 code units and ${cost.images} image placements`;
}
