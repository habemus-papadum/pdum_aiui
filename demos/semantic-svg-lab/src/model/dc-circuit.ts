import type { TargetedDiagnostic } from "../semantic/diagnostics";

export const RESISTORS = ["R1", "R2", "RL"] as const;
export type ResistorId = (typeof RESISTORS)[number];
export const PARTS = ["V1", ...RESISTORS] as const;
export type PartId = (typeof PARTS)[number];
export const PINS = ["V1/p", "V1/n", "R1/a", "R1/b", "R2/a", "R2/b", "RL/a", "RL/b"] as const;
export type PinId = (typeof PINS)[number];
export interface Wire {
  id: string;
  a: PinId;
  b: PinId;
}
export interface DCCircuit {
  revision: number;
  nextWire: number;
  supply: number;
  resistance: Record<ResistorId, number>;
  wires: Wire[];
}
export function initialDC(revision = 0): DCCircuit {
  return {
    revision,
    nextWire: 6,
    supply: 12,
    resistance: { R1: 1000, R2: 2000, RL: 2000 },
    wires: [
      { id: "w1", a: "V1/p", b: "R1/a" },
      { id: "w2", a: "R1/b", b: "R2/a" },
      { id: "w3", a: "R2/b", b: "V1/n" },
      { id: "w4", a: "R2/a", b: "RL/a" },
      { id: "w5", a: "RL/b", b: "R2/b" },
    ],
  };
}
export const pinRef = (pin: PinId) => `pin/${pin}`;
export const partRef = (part: PartId) => `part/${part}`;
export const wireRef = (id: string) => `wire/${id}`;
export function validDCRef(model: DCCircuit, ref: string) {
  return (
    PINS.some((pin) => ref === pinRef(pin)) ||
    PARTS.some((part) => ref === partRef(part)) ||
    model.wires.some((w) => ref === wireRef(w.id))
  );
}
export function dcLabel(model: DCCircuit, ref: string) {
  if (ref.startsWith("pin/")) return ref.slice(4).replace("/", " · ");
  if (ref.startsWith("part/")) return ref.slice(5);
  const wire = model.wires.find((w) => ref === wireRef(w.id));
  return wire ? `${wire.id.toUpperCase()} · ${wire.a} ↔ ${wire.b}` : ref;
}
export type DCEdit =
  | { kind: "connect"; a: PinId; b: PinId }
  | { kind: "disconnect"; wire: string }
  | { kind: "reconnect"; wire: string; a: PinId; b: PinId }
  | { kind: "resistance"; part: ResistorId; ohms: number }
  | { kind: "supply"; volts: number }
  | { kind: "detach-load" };
export function editDC(model: DCCircuit, edit: DCEdit, expectedRevision: number): DCCircuit {
  if (expectedRevision !== model.revision)
    throw new Error("The circuit changed. Review the current circuit before applying.");
  if (!edit || typeof edit !== "object") throw new Error("Provide a circuit edit.");
  let wires = model.wires,
    nextWire = model.nextWire,
    resistance = model.resistance,
    supply = model.supply;
  switch (edit.kind) {
    case "connect":
    case "reconnect": {
      if (!PINS.includes(edit.a) || !PINS.includes(edit.b)) throw new Error("Unknown terminal.");
      if (edit.a === edit.b) throw new Error("Choose two different terminals.");
      const target = edit.kind === "reconnect" ? edit.wire : null;
      if (edit.kind === "reconnect" && !wires.some((w) => w.id === target))
        throw new Error("Unknown wire.");
      if (
        wires.some(
          (w) =>
            w.id !== target &&
            ((w.a === edit.a && w.b === edit.b) || (w.a === edit.b && w.b === edit.a)),
        )
      )
        throw new Error("Those terminals already have a direct wire.");
      wires =
        edit.kind === "connect"
          ? [...wires, { id: `w${nextWire++}`, a: edit.a, b: edit.b }]
          : wires.map((w) => (w.id === target ? { ...w, a: edit.a, b: edit.b } : w));
      break;
    }
    case "disconnect":
      if (!wires.some((w) => w.id === edit.wire)) throw new Error("Unknown wire.");
      wires = wires.filter((w) => w.id !== edit.wire);
      break;
    case "resistance":
      if (
        !RESISTORS.includes(edit.part) ||
        !Number.isInteger(edit.ohms) ||
        edit.ohms < 100 ||
        edit.ohms > 100000
      )
        throw new Error("Choose a resistor and an integer resistance from 100 to 100000 Ω.");
      resistance = { ...resistance, [edit.part]: edit.ohms };
      break;
    case "supply":
      if (!Number.isFinite(edit.volts) || edit.volts < 1 || edit.volts > 24)
        throw new Error("Supply must be between 1 and 24 V.");
      supply = Math.round(edit.volts * 1000) / 1000;
      break;
    case "detach-load":
      wires = wires.filter((w) => !w.a.startsWith("RL/") && !w.b.startsWith("RL/"));
      break;
    default:
      throw new Error("Unknown circuit edit.");
  }
  return { revision: model.revision + 1, nextWire, wires, resistance, supply };
}
export interface Net {
  pins: PinId[];
  voltage: number | null;
  floating: boolean;
}
export interface Branch {
  part: ResistorId;
  a: PinId;
  b: PinId;
  current: number | null;
  drop: number | null;
  power: number | null;
}
export interface DCResult {
  model: DCCircuit;
  status: "solved" | "floating" | "short" | "numerical";
  nets: Net[];
  netOf: Record<PinId, number>;
  voltages: Record<PinId, number | null>;
  branches: Record<ResistorId, Branch>;
  sourceCurrent: number | null;
  output: number | null;
  kclResidual: number | null;
  powerResidual: number | null;
  loadConnected: boolean;
  goalMet: boolean;
  diagnostics: TargetedDiagnostic[];
}
/** Explicit wires establish equivalence classes. Resistors connect nets, not terminal identities. */
function connectivity(model: DCCircuit) {
  const parent = PINS.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i]));
  for (const w of model.wires) parent[root(PINS.indexOf(w.a))] = root(PINS.indexOf(w.b));
  const groups = new Map<number, PinId[]>();
  PINS.forEach((pin, i) => {
    const id = root(i);
    groups.set(id, [...(groups.get(id) ?? []), pin]);
  });
  const nets = [...groups.values()].map((pins) => ({
    pins,
    voltage: null as number | null,
    floating: false,
  }));
  const netOf = Object.fromEntries(
    nets.flatMap((net, i) => net.pins.map((pin) => [pin, i])),
  ) as Record<PinId, number>;
  return { nets, netOf };
}
/** Positive resistances and a referenced connected component produce a nonsingular nodal matrix.
 * Row scaling avoids using a pivot tolerance that depends on the unit of conductance.
 */
function solveNodal(a: number[][], b: number[]) {
  const rows = a.map((row, i) => {
    const scale = Math.max(...row.map(Math.abs));
    return [...row, b[i]].map((v) => v / scale);
  });
  for (let c = 0; c < b.length; c++) {
    let best = c;
    for (let r = c + 1; r < b.length; r++)
      if (Math.abs(rows[r][c]) > Math.abs(rows[best][c])) best = r;
    if (!Number.isFinite(rows[best][c]) || Math.abs(rows[best][c]) < 1e-12) return null;
    [rows[c], rows[best]] = [rows[best], rows[c]];
    const pivot = rows[c][c];
    rows[c] = rows[c].map((v) => v / pivot);
    for (let r = 0; r < b.length; r++)
      if (r !== c) {
        const factor = rows[r][c];
        rows[r] = rows[r].map((v, j) => v - factor * rows[c][j]);
      }
  }
  return rows.map((row) => row[b.length]);
}
/** Linear DC only: one ideal grounded voltage source, three positive resistors, ideal wires. */
export function analyzeDC(model: DCCircuit): DCResult {
  const { nets, netOf } = connectivity(model);
  const diagnostics: TargetedDiagnostic[] = [];
  const ground = netOf["V1/n"],
    high = netOf["V1/p"];
  const adjacency = nets.map(() => new Set<number>());
  const edges = RESISTORS.map((part) => {
    const a = `${part}/a` as PinId,
      b = `${part}/b` as PinId;
    adjacency[netOf[a]].add(netOf[b]);
    adjacency[netOf[b]].add(netOf[a]);
    return { part, a, b, na: netOf[a], nb: netOf[b], g: 1 / model.resistance[part] };
  });
  const visited = new Set<number>();
  nets.forEach((_, start) => {
    if (visited.has(start)) return;
    const component: number[] = [],
      stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      component.push(id);
      for (const next of adjacency[id]) stack.push(next);
    }
    if (!component.includes(ground) && !component.includes(high)) {
      component.forEach((i) => {
        nets[i].floating = true;
      });
      diagnostics.push({
        id: `floating-${start}`,
        title: "Floating resistor island",
        detail:
          "This passive island has no absolute voltage reference. Its resistor currents and voltage differences are zero; reconnect it to the referenced circuit.",
        refs: component.flatMap((i) => nets[i].pins.map(pinRef)),
      });
    }
  });
  let status: DCResult["status"] =
    ground === high ? "short" : nets.some((n) => n.floating) ? "floating" : "solved";
  if (status === "short")
    diagnostics.unshift({
      id: "source-short",
      title: "Supply terminals are shorted",
      detail: `Ideal wires require the same voltage at both terminals, while V1 requires ${model.supply} V between them. This ideal model has no solution. Remove a wire in the highlighted net.`,
      refs: [
        partRef("V1"),
        ...model.wires.filter((w) => netOf[w.a] === ground).map((w) => wireRef(w.id)),
      ],
    });
  if (status !== "short") {
    nets[ground].voltage = 0;
    nets[high].voltage = model.supply;
    const unknown = nets
      .map((_, i) => i)
      .filter((i) => i !== ground && i !== high && !nets[i].floating);
    const matrix = unknown.map(() => unknown.map(() => 0)),
      rhs = unknown.map(() => 0);
    for (const edge of edges) {
      if (edge.na === edge.nb) continue;
      for (const [from, to] of [
        [edge.na, edge.nb],
        [edge.nb, edge.na],
      ]) {
        const row = unknown.indexOf(from);
        if (row < 0) continue;
        matrix[row][row] += edge.g;
        const col = unknown.indexOf(to);
        if (col >= 0) matrix[row][col] -= edge.g;
        else rhs[row] += edge.g * (nets[to].voltage ?? 0);
      }
    }
    const solution = solveNodal(matrix, rhs);
    if (!solution) status = "numerical";
    else
      unknown.forEach((id, i) => {
        nets[id].voltage = solution[i];
      });
  }
  const currentAt = nets.map(() => 0);
  const branches = Object.fromEntries(
    edges.map((edge) => {
      const va = nets[edge.na].voltage,
        vb = nets[edge.nb].voltage;
      // An isolated positive-resistance network has arbitrary common potential,
      // but all branch differences/currents are zero. Do not discard that known fact.
      const passiveIsland =
        status !== "short" &&
        status !== "numerical" &&
        nets[edge.na].floating &&
        nets[edge.nb].floating;
      const drop = passiveIsland ? 0 : va === null || vb === null ? null : va - vb;
      const current = drop === null ? null : drop * edge.g;
      if (current !== null) {
        currentAt[edge.na] += current;
        currentAt[edge.nb] -= current;
      }
      return [
        edge.part,
        {
          part: edge.part,
          a: edge.a,
          b: edge.b,
          drop,
          current,
          power: current === null || drop === null ? null : current * drop,
        },
      ];
    }),
  ) as Record<ResistorId, Branch>;
  const residual =
    status === "short" || status === "numerical"
      ? null
      : Math.max(
          0,
          ...nets.map((net, i) =>
            !net.floating && i !== ground && i !== high ? Math.abs(currentAt[i]) : 0,
          ),
        );
  if (residual !== null && (!Number.isFinite(residual) || residual > 1e-9)) status = "numerical";
  if (status === "numerical") {
    diagnostics.unshift({
      id: "numerical",
      title: "Numerical solution unresolved",
      detail: "The nodal solve or current-balance check failed. Values are withheld.",
      refs: PARTS.map(partRef),
    });
    for (const net of nets) net.voltage = null;
    for (const branch of Object.values(branches)) {
      branch.current = null;
      branch.drop = null;
      branch.power = null;
    }
  }
  for (const pin of PINS)
    if (!model.wires.some((w) => w.a === pin || w.b === pin))
      diagnostics.push({
        id: `unwired-${pin}`,
        title: `${pin} has no wire`,
        detail:
          "This terminal has no explicit connection. An open resistor branch can carry zero current even when its terminal voltage is defined.",
        refs: [pinRef(pin)],
      });
  for (const edge of edges)
    if (edge.na === edge.nb)
      diagnostics.push({
        id: `bypassed-${edge.part}`,
        title: `${edge.part} is bypassed`,
        detail:
          "Both terminals belong to the same ideal-wire net. No voltage is dropped across this resistor.",
        refs: [partRef(edge.part), pinRef(edge.a), pinRef(edge.b)],
      });
  const sourceCurrent = status === "short" || status === "numerical" ? null : currentAt[high];
  if (sourceCurrent !== null && Math.abs(sourceCurrent) < 1e-10)
    diagnostics.push({
      id: "no-load-path",
      title: "No current drawn from V1",
      detail:
        "There is no conducting resistor path from the supply to its return. Inspect the return connection; a defined output voltage alone does not establish a working divider.",
      refs: [pinRef("V1/n"), pinRef("R2/b"), pinRef("R2/a")],
    });
  const output = nets[netOf["R2/a"]].voltage;
  const loadConnected =
    (netOf["RL/a"] === netOf["R2/a"] && netOf["RL/b"] === ground) ||
    (netOf["RL/b"] === netOf["R2/a"] && netOf["RL/a"] === ground);
  const goalMet =
    status === "solved" && loadConnected && output !== null && Math.abs(output - 6) <= 0.05;
  const powerResidual =
    sourceCurrent === null || Object.values(branches).some((b) => b.power === null)
      ? null
      : model.supply * sourceCurrent -
        Object.values(branches).reduce((sum, b) => sum + (b.power ?? 0), 0);
  return {
    model,
    status,
    nets,
    netOf,
    branches,
    sourceCurrent,
    output,
    loadConnected,
    goalMet,
    kclResidual: residual,
    powerResidual,
    diagnostics,
    voltages: Object.fromEntries(PINS.map((pin) => [pin, nets[netOf[pin]].voltage])) as Record<
      PinId,
      number | null
    >,
  };
}
export interface NetTerm {
  ref: string;
  symbol: string;
  current: number | null;
  sign: number;
}
/** All currents are outward from the selected net. Internal bypassed branches do not enter KCL. */
export function netTerms(result: DCResult, anchor: PinId): NetTerm[] {
  const node = result.netOf[anchor],
    terms: NetTerm[] = [];
  for (const part of RESISTORS) {
    const branch = result.branches[part],
      a = result.netOf[branch.a] === node,
      b = result.netOf[branch.b] === node;
    if (a !== b)
      terms.push({
        ref: partRef(part),
        symbol: `I_{${part}}`,
        sign: a ? 1 : -1,
        current: branch.current,
      });
  }
  if (result.netOf["V1/p"] !== result.netOf["V1/n"]) {
    if (node === result.netOf["V1/p"])
      terms.push({ ref: partRef("V1"), symbol: "I_s", sign: -1, current: result.sourceCurrent });
    if (node === result.netOf["V1/n"])
      terms.push({ ref: partRef("V1"), symbol: "I_s", sign: 1, current: result.sourceCurrent });
  }
  return terms;
}
/** A specific scripted repair. It says what it will connect before any ink is drawn. */
export function missingReturn(result: DCResult) {
  return result.netOf["R2/b"] !== result.netOf["V1/n"];
}
