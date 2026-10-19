import type { TargetedDiagnostic } from "../semantic/diagnostics";
/** Four-joint, planar, ideal pin-jointed truss. Geometry is metres; force is newtons.
 * Equilibrium columns are member tensions and bilateral support reactions.
 * Rank/nullspace diagnostics are numerical, not a finite-motion or strength proof.
 */
export const JOINT_IDS = ["A", "B", "C", "D"] as const;
export type JointId = (typeof JOINT_IDS)[number];
export const SUPPORTS = ["none", "pin", "roller-y", "roller-x"] as const;
export type Support = (typeof SUPPORTS)[number];
export interface Point {
  x: number;
  y: number;
}
export interface Joint extends Point {
  id: JointId;
  support: Support;
}
export interface Member {
  id: string;
  a: JointId;
  b: JointId;
}
export interface Structure {
  revision: number;
  nextMember: number;
  joints: Joint[];
  members: Member[];
  load: { joint: JointId; magnitude: number };
}
export function initialStructure(revision = 0): Structure {
  return {
    revision,
    nextMember: 6,
    joints: [
      { id: "A", x: 0, y: 0, support: "pin" },
      { id: "B", x: 4, y: 0, support: "roller-y" },
      { id: "C", x: 3, y: 2.5, support: "none" },
      { id: "D", x: 1, y: 2.5, support: "none" },
    ],
    members: [
      { id: "m1", a: "A", b: "B" },
      { id: "m2", a: "B", b: "C" },
      { id: "m3", a: "C", b: "D" },
      { id: "m4", a: "D", b: "A" },
      { id: "m5", a: "A", b: "C" },
    ],
    load: { joint: "D", magnitude: 120 },
  };
}
export const jointRef = (id: JointId) => `joint/${id}`;
export const memberRef = (id: string) => `member/${id}`;
export const supportRef = (id: JointId) => `support/${id}`;
export const memberName = (m: Member) => [m.a, m.b].sort().join("");
export function jointById(s: Structure, id: JointId): Joint {
  const joint = s.joints.find((j) => j.id === id);
  if (!joint) throw new Error(`Unknown joint ${id}.`);
  return joint;
}
export function memberById(s: Structure, id: string): Member {
  const member = s.members.find((m) => m.id === id);
  if (!member) throw new Error(`Unknown member ${id}.`);
  return member;
}
export function hasReference(s: Structure, ref: string) {
  return (
    ref === "load/main" ||
    s.joints.some((j) => ref === jointRef(j.id) || ref === supportRef(j.id)) ||
    s.members.some((m) => ref === memberRef(m.id))
  );
}
export type StructureEdit =
  | { kind: "move"; joint: JointId; x: number; y: number }
  | { kind: "support"; joint: JointId; support: Support }
  | { kind: "load"; joint: JointId; magnitude: number }
  | { kind: "add"; a: JointId; b: JointId }
  | { kind: "remove"; member: string }
  | { kind: "reconnect"; member: string; a: JointId; b: JointId };

/** Validate structural edits at the operation boundary, including calls from tools. */
export function editStructure(
  s: Structure,
  edit: StructureEdit,
  expectedRevision: number,
): Structure {
  if (expectedRevision !== s.revision)
    throw new Error("The structure changed. Review the current drawing first.");
  if (!edit || typeof edit !== "object") throw new Error("An edit is required.");
  const validJoint = (id: JointId) => {
    if (!JOINT_IDS.includes(id)) throw new Error("Unknown joint.");
  };
  let joints = s.joints;
  let members = s.members;
  let load = s.load;
  let nextMember = s.nextMember;
  switch (edit.kind) {
    case "move": {
      validJoint(edit.joint);
      if (!Number.isFinite(edit.x) || !Number.isFinite(edit.y))
        throw new Error("Coordinates must be finite.");
      const x = Math.round(Math.max(0, Math.min(6, edit.x)) * 10) / 10;
      const y = Math.round(Math.max(0, Math.min(4, edit.y)) * 10) / 10;
      joints = joints.map((j) => (j.id === edit.joint ? { ...j, x, y } : j));
      break;
    }
    case "support":
      validJoint(edit.joint);
      if (!SUPPORTS.includes(edit.support)) throw new Error("Unknown support.");
      joints = joints.map((j) => (j.id === edit.joint ? { ...j, support: edit.support } : j));
      break;
    case "load":
      validJoint(edit.joint);
      if (!Number.isFinite(edit.magnitude) || edit.magnitude < 0 || edit.magnitude > 500)
        throw new Error("Load must be between 0 and 500 N.");
      load = { joint: edit.joint, magnitude: edit.magnitude };
      break;
    case "remove":
      if (!members.some((m) => m.id === edit.member)) throw new Error("Unknown member.");
      members = members.filter((m) => m.id !== edit.member);
      break;
    case "add":
    case "reconnect": {
      validJoint(edit.a);
      validJoint(edit.b);
      if (edit.a === edit.b) throw new Error("Choose two different joints.");
      const name = memberName({ id: "", a: edit.a, b: edit.b });
      const target = edit.kind === "reconnect" ? edit.member : null;
      if (edit.kind === "reconnect" && !members.some((m) => m.id === target))
        throw new Error("Unknown member.");
      if (members.some((m) => m.id !== target && memberName(m) === name))
        throw new Error(`${name} already exists.`);
      if (edit.kind === "add")
        members = [...members, { id: `m${nextMember++}`, a: edit.a, b: edit.b }];
      else members = members.map((m) => (m.id === target ? { ...m, a: edit.a, b: edit.b } : m));
      break;
    }
    default:
      throw new Error("Unknown edit.");
  }
  return { revision: s.revision + 1, nextMember, joints, members, load };
}

const RANK_TOLERANCE = 1e-10;
/** Small partial-pivot Gauss–Jordan reduction. The coefficient columns are dimensionless. */
function reduce(matrix: number[][], columns: number) {
  const rows = matrix.map((row) => [...row]);
  const pivots: number[] = [];
  let pivotRow = 0;
  for (let c = 0; c < columns && pivotRow < rows.length; c++) {
    let best = pivotRow;
    for (let r = pivotRow + 1; r < rows.length; r++)
      if (Math.abs(rows[r][c]) > Math.abs(rows[best][c])) best = r;
    if (Math.abs(rows[best][c]) <= RANK_TOLERANCE) continue;
    [rows[pivotRow], rows[best]] = [rows[best], rows[pivotRow]];
    const divisor = rows[pivotRow][c];
    rows[pivotRow] = rows[pivotRow].map((value) => value / divisor);
    for (let r = 0; r < rows.length; r++) {
      if (r === pivotRow) continue;
      const factor = rows[r][c];
      rows[r] = rows[r].map((value, k) => value - factor * rows[pivotRow][k]);
    }
    pivots.push(c);
    pivotRow++;
  }
  return { rows, pivots };
}
function nullBasis(matrix: number[][], columns: number): number[][] {
  const { rows, pivots } = reduce(matrix, columns);
  return Array.from({ length: columns }, (_, i) => i)
    .filter((i) => !pivots.includes(i))
    .map((free) => {
      const v = Array(columns).fill(0) as number[];
      v[free] = 1;
      pivots.forEach((p, row) => {
        v[p] = -rows[row][free];
      });
      const scale = Math.max(...v.map(Math.abs));
      return v.map((value) => value / scale);
    });
}
export type Diagnostic = TargetedDiagnostic;
export interface ForceTerm {
  ref: string;
  symbol: string;
  x: number;
  y: number;
  value: number | null;
}
export interface StructureResult {
  model: Structure;
  status: "solved" | "mechanism" | "indeterminate" | "invalid" | "numerical";
  rank: number;
  unknowns: number;
  mechanisms: number;
  redundancies: number;
  loadCompatible: boolean;
  diagnostics: Diagnostic[];
  forces: Record<string, number>;
  joints: Record<JointId, ForceTerm[]>;
  motion: Record<JointId, Point> | null;
  residual: number | null;
}
export function analyzeStructure(model: Structure): StructureResult {
  const diagnostics: Diagnostic[] = [];
  const dofs = model.joints.length * 2;
  const columns: { ref: string; symbol: string; vector: number[] }[] = [];
  const index = (id: JointId) => model.joints.findIndex((j) => j.id === id) * 2;
  for (const m of model.members) {
    const a = jointById(model, m.a),
      b = jointById(model, m.b);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-12) {
      diagnostics.push({
        id: `zero-${m.id}`,
        title: `${memberName(m)} has no direction`,
        detail: "Its endpoints coincide. Move either joint before solving.",
        refs: [memberRef(m.id), jointRef(m.a), jointRef(m.b)],
      });
      continue;
    }
    const vector = Array(dofs).fill(0) as number[];
    vector[index(m.a)] = (b.x - a.x) / length;
    vector[index(m.a) + 1] = (b.y - a.y) / length;
    vector[index(m.b)] = -vector[index(m.a)];
    vector[index(m.b) + 1] = -vector[index(m.a) + 1];
    columns.push({ ref: memberRef(m.id), symbol: `N_{${memberName(m)}}`, vector });
  }
  for (const j of model.joints) {
    for (const axis of ["x", "y"] as const) {
      if (j.support !== "pin" && j.support !== `roller-${axis}`) continue;
      const vector = Array(dofs).fill(0) as number[];
      vector[index(j.id) + (axis === "y" ? 1 : 0)] = 1;
      columns.push({ ref: supportRef(j.id), symbol: `R_{${j.id}${axis}}`, vector });
    }
  }
  const n = columns.length;
  const matrix = Array.from({ length: dofs }, (_, row) => columns.map((c) => c.vector[row]));
  const rhs = Array(dofs).fill(0) as number[];
  rhs[index(model.load.joint) + 1] = model.load.magnitude;
  const { rows, pivots } = reduce(
    matrix.map((row, i) => [...row, rhs[i]]),
    n,
  );
  const rank = pivots.length;
  const mechanisms = dofs - rank;
  const redundancies = n - rank;
  const loadCompatible = rows
    .slice(rank)
    .every((r) => Math.abs(r[n]) <= 1e-7 * Math.max(1, model.load.magnitude));
  const modes = nullBasis(
    columns.map((c) => c.vector),
    dofs,
  );
  // Prefer a mode coupled to this load, otherwise show the first available freedom.
  const mode = modes.sort(
    (a, b) => Math.abs(b[index(model.load.joint) + 1]) - Math.abs(a[index(model.load.joint) + 1]),
  )[0];
  const motion = mode
    ? (Object.fromEntries(
        model.joints.map((j, i) => [j.id, { x: mode[2 * i], y: mode[2 * i + 1] }]),
      ) as Record<JointId, Point>)
    : null;
  let status: StructureResult["status"] = diagnostics.length
    ? "invalid"
    : mechanisms
      ? "mechanism"
      : redundancies
        ? "indeterminate"
        : "solved";
  const candidate = Array(n).fill(0) as number[];
  pivots.forEach((p, r) => {
    candidate[p] = rows[r][n];
  });
  const residual =
    status === "solved"
      ? Math.max(
          ...matrix.map((row, i) =>
            Math.abs(row.reduce((sum, a, c) => sum + a * candidate[c], 0) - rhs[i]),
          ),
        )
      : null;
  if (
    residual !== null &&
    (!Number.isFinite(residual) || residual > 1e-7 * Math.max(1, model.load.magnitude))
  )
    status = "numerical";
  const forces: Record<string, number> = {};
  if (status === "solved")
    columns.forEach((c, i) => {
      forces[c.symbol] = candidate[i];
    });
  const joints = Object.fromEntries(
    model.joints.map((j) => {
      const i = index(j.id);
      const terms: ForceTerm[] = columns
        .filter((c) => c.vector[i] !== 0 || c.vector[i + 1] !== 0)
        .map((c) => ({
          ref: c.ref,
          symbol: c.symbol,
          x: c.vector[i],
          y: c.vector[i + 1],
          value: status === "solved" ? forces[c.symbol] : null,
        }));
      if (j.id === model.load.joint)
        terms.push({ ref: "load/main", symbol: "W", x: 0, y: -1, value: model.load.magnitude });
      return [j.id, terms];
    }),
  ) as Record<JointId, ForceTerm[]>;
  if (status !== "invalid" && mechanisms)
    diagnostics.push({
      id: "mechanism",
      title: `${mechanisms} free motion${mechanisms === 1 ? "" : "s"}`,
      detail: loadCompatible
        ? "This load can balance, but the frame still has an unconstrained infinitesimal motion. Member forces are withheld."
        : "This load cannot balance: it acts along an unconstrained motion. Add a connection or change a support.",
      refs: model.joints
        .filter((j) => motion && Math.hypot(motion[j.id].x, motion[j.id].y) > 1e-7)
        .map((j) => jointRef(j.id)),
    });
  const selfStress = redundancies ? nullBasis(matrix, n) : [];
  if (status !== "invalid" && redundancies)
    diagnostics.push({
      id: "redundancy",
      title: `${redundancies} redundant constraint${redundancies === 1 ? "" : "s"}`,
      detail:
        "Equilibrium does not select unique forces. Member stiffness and deformation would be needed; this study does not assume them.",
      refs: columns
        .filter((_, i) => selfStress.some((v) => Math.abs(v[i]) > 1e-7))
        .map((c) => c.ref)
        .filter((ref, i, refs) => refs.indexOf(ref) === i),
    });
  if (status === "numerical")
    diagnostics.push({
      id: "numerical",
      title: "Numerical solution unresolved",
      detail: "The force residual is too large to show a reliable solution. Change the geometry.",
      refs: model.joints.map((j) => jointRef(j.id)),
    });
  return {
    model,
    status,
    rank,
    unknowns: n,
    mechanisms,
    redundancies,
    loadCompatible,
    diagnostics,
    forces,
    joints,
    motion: status === "invalid" ? null : motion,
    residual,
  };
}
export const forceFor = (r: StructureResult, m: Member): number | undefined =>
  r.forces[`N_{${memberName(m)}}`];
export const forceKind = (n: number | undefined) =>
  n === undefined ? "unknown" : Math.abs(n) < 1e-7 ? "zero" : n > 0 ? "tension" : "compression";
export function missingBrace(s: Structure): { a: JointId; b: JointId } | null {
  for (const [a, b] of [
    ["A", "C"],
    ["B", "D"],
  ] as const)
    if (!s.members.some((m) => memberName(m) === `${a}${b}`)) return { a, b };
  return null;
}
