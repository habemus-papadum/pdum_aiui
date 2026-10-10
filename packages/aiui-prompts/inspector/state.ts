import type { CompiledPrompt } from "../src/model.ts";
import type { OutputRange } from "./preview.ts";

export interface InspectorState {
  selected: string | null;
  outlineCollapsed: Set<string>;
  contentFolded: Set<string>;
}

export function createState(): InspectorState {
  return { selected: null, outlineCollapsed: new Set(), contentFolded: new Set() };
}

export function descendants(compiled: CompiledPrompt, occurrence: string): Set<string> {
  const result = new Set([occurrence]);
  for (const item of compiled.occurrences) {
    if (item.parent && result.has(item.parent)) result.add(item.id);
  }
  return result;
}

export function parentChain(compiled: CompiledPrompt, occurrence: string): string[] {
  const result: string[] = [];
  const byId = new Map(compiled.occurrences.map((item) => [item.id, item]));
  let item = byId.get(occurrence);
  while (item?.parent) {
    result.push(item.parent);
    item = byId.get(item.parent);
  }
  return result;
}

export function ownersOfRange(compiled: CompiledPrompt, range: OutputRange): string[] {
  return [
    ...new Set(
      compiled.contributions
        .filter(
          (entry) =>
            entry.part === range.part &&
            entry.start !== undefined &&
            entry.end !== undefined &&
            entry.start < range.end &&
            entry.end > range.start,
        )
        .map((entry) => entry.occurrence),
    ),
  ];
}

/** Active outer folds obscure inner folds without deleting their independent state. */
export function visibleFolds(compiled: CompiledPrompt, state: InspectorState): string[] {
  return [...state.contentFolded].filter(
    (id) => !parentChain(compiled, id).some((parent) => state.contentFolded.has(parent)),
  );
}

export function foldedRanges(compiled: CompiledPrompt, state: InspectorState): OutputRange[] {
  const owners = new Set(
    visibleFolds(compiled, state).flatMap((id) => [...descendants(compiled, id)]),
  );
  const ranges = compiled.contributions
    .filter((entry) => owners.has(entry.occurrence))
    .flatMap((entry) =>
      entry.start === undefined || entry.end === undefined
        ? []
        : [{ part: entry.part, start: entry.start, end: entry.end }],
    )
    .sort((a, b) => a.part.localeCompare(b.part) || a.start - b.start);
  const merged: OutputRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous?.part === range.part && previous.end >= range.start) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function rangeFoldStatus(
  range: OutputRange,
  folds: readonly OutputRange[],
): "visible" | "partial" | "full" {
  let covered = 0;
  for (const fold of folds) {
    if (fold.part !== range.part) continue;
    covered += Math.max(0, Math.min(fold.end, range.end) - Math.max(fold.start, range.start));
  }
  return covered === 0 ? "visible" : covered >= range.end - range.start ? "full" : "partial";
}

/** No text concatenation or fake image marker is part of the canonical output. */
export function canonicalText(compiled: CompiledPrompt): string | null {
  if (compiled.parts.some((part) => part.type !== "text")) return null;
  return compiled.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export interface PromptComparison {
  sameRecord: boolean;
  sameOutput: boolean;
  beforeCodeUnits: number;
  afterCodeUnits: number;
  decisionsChanged: boolean;
}

/** Exact summary only. No fuzzy IDs, inferred moves, or editable scientific text. */
export function comparePrompts(before: CompiledPrompt, after: CompiledPrompt): PromptComparison {
  const count = (compiled: CompiledPrompt) =>
    compiled.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  return {
    sameRecord: before.recordFingerprint === after.recordFingerprint,
    sameOutput: JSON.stringify(before.parts) === JSON.stringify(after.parts),
    beforeCodeUnits: count(before),
    afterCodeUnits: count(after),
    decisionsChanged: JSON.stringify(before.decisions) !== JSON.stringify(after.decisions),
  };
}
