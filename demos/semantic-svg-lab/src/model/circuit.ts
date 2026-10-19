/** A deliberately small circuit model. Presentation never supplies electrical identity. */
export const OCCURRENCES = ["a", "b"] as const;
export type Occurrence = (typeof OCCURRENCES)[number];
export type Part = "R1" | "M1";
export interface FeatureRef {
  occurrence: Occurrence;
  part: Part;
  feature: string;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Circuit {
  revision: number;
  stages: Record<Occurrence, { resistance: number }>;
}
export const RESISTANCE = { min: 100, max: 100_000, step: 100 } as const;
export const WORLD = { width: 1000, height: 520 };
export const STAGE_SIZE = { width: 310, height: 360 };
export const PLACEMENTS: Record<Occurrence, Point> = {
  a: { x: 90, y: 70 },
  b: { x: 600, y: 70 },
};

/** One shared definition; each occurrence owns its parameter override. */
export const STAGE = {
  id: "common-source",
  resistor: { x: 150, y: 100 },
  transistor: { x: 150, y: 230 },
  pins: [
    { part: "R1", feature: "upper", x: 150, y: 57, net: "vdd" },
    { part: "R1", feature: "lower", x: 150, y: 143, net: "out" },
    { part: "M1", feature: "gate", x: 102, y: 230, net: "in" },
    { part: "M1", feature: "drain", x: 150, y: 190, net: "out" },
    { part: "M1", feature: "source", x: 150, y: 270, net: "ground" },
    { part: "M1", feature: "bulk", x: 202, y: 230, net: "ground" },
  ] as const,
};

export interface Feature {
  ref: FeatureRef;
  key: string;
  label: string;
  point: Point;
  net?: string;
  hidden: boolean;
}
export function initialCircuit(): Circuit {
  return { revision: 0, stages: { a: { resistance: 4700 }, b: { resistance: 10000 } } };
}
export function featureKey(ref: FeatureRef): string {
  return `${ref.occurrence}/${ref.part}/${ref.feature}`;
}
export function netKey(occurrence: Occurrence, net: string): string {
  if (net === "vdd" || net === "ground") return net;
  if ((occurrence === "a" && net === "out") || (occurrence === "b" && net === "in"))
    return "interstage";
  return `${occurrence}/${net}`;
}
export function features(): Feature[] {
  return OCCURRENCES.flatMap((occurrence) => {
    const origin = PLACEMENTS[occurrence];
    const rows = [
      { part: "R1" as const, feature: "body", x: 150, y: 100 },
      { part: "R1" as const, feature: "value", x: 210, y: 108 },
      { part: "M1" as const, feature: "body", x: 148, y: 230 },
      ...STAGE.pins,
    ];
    return rows.map((row) => {
      const ref = { occurrence, part: row.part, feature: row.feature };
      return {
        ref,
        key: featureKey(ref),
        label: `${occurrence.toUpperCase()} · ${row.part} · ${row.feature}`,
        point: { x: origin.x + row.x, y: origin.y + row.y },
        hidden: row.feature === "bulk",
        ...("net" in row ? { net: netKey(occurrence, row.net) } : {}),
      };
    });
  });
}
export function resolveFeature(key: string): Feature {
  const result = features().find((feature) => feature.key === key);
  if (!result) throw new Error(`Unknown circuit feature: ${key}`);
  return result;
}
export function resistanceLabel(ohms: number): string {
  return `${Number((ohms / 1000).toFixed(3))} kΩ`;
}
export function editResistance(
  circuit: Circuit,
  key: string,
  ohms: number,
  expectedRevision: number,
): Circuit {
  if (expectedRevision !== circuit.revision)
    throw new Error("The circuit changed. Inspect the current revision before applying this edit.");
  const feature = resolveFeature(key);
  if (feature.ref.part !== "R1" || feature.ref.feature !== "value")
    throw new Error("Select a resistor value to edit it.");
  if (
    !Number.isFinite(ohms) ||
    ohms < RESISTANCE.min ||
    ohms > RESISTANCE.max ||
    Math.abs(ohms / RESISTANCE.step - Math.round(ohms / RESISTANCE.step)) > 1e-9
  ) {
    throw new Error("Resistance must be 0.1–100 kΩ in steps of 0.1 kΩ.");
  }
  const occurrence = feature.ref.occurrence;
  if (circuit.stages[occurrence].resistance === ohms) return circuit;
  return {
    revision: circuit.revision + 1,
    stages: { ...circuit.stages, [occurrence]: { resistance: ohms } },
  };
}
export function parseCircuit(value: unknown): Circuit {
  if (!value || typeof value !== "object") throw new Error("Invalid circuit.");
  const candidate = value as Circuit;
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0)
    throw new Error("Invalid revision.");
  let checked = initialCircuit();
  for (const occurrence of OCCURRENCES) {
    checked = editResistance(
      checked,
      `${occurrence}/R1/value`,
      candidate.stages?.[occurrence]?.resistance,
      checked.revision,
    );
  }
  return { ...checked, revision: candidate.revision };
}
export interface History {
  current: Circuit;
  past: Circuit[];
  future: Circuit[];
}
export function commit(history: History, next: Circuit): History {
  if (next === history.current) return history;
  return { current: next, past: [...history.past, history.current].slice(-50), future: [] };
}
export function travel(history: History, direction: "undo" | "redo"): History {
  const source = direction === "undo" ? history.past : history.future;
  const previous = source.at(-1);
  if (!previous) return history;
  const current = { ...previous, revision: history.current.revision + 1 };
  return direction === "undo"
    ? { current, past: history.past.slice(0, -1), future: [...history.future, history.current] }
    : { current, past: [...history.past, history.current], future: history.future.slice(0, -1) };
}
export function describeCircuit(circuit: Circuit) {
  return {
    revision: circuit.revision,
    definition: STAGE.id,
    stages: OCCURRENCES.map((occurrence) => ({ occurrence, ...circuit.stages[occurrence] })),
    features: features(),
  };
}
