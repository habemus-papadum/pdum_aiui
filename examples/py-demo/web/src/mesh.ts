/**
 * Triangle meshes built out of {@link Vec3} primitives.
 *
 * Every geometric operation here is expressed in terms of {@link Vec3} and the
 * free functions {@link distance} and {@link centroid} from `vec3.ts`, so this
 * module is a dense set of cross-file references back into `vec3`. It mirrors
 * the Python `mesh.py` fixture.
 */

import { centroid, distance, Vec3 } from "./vec3";

/** A triangular face referencing three vertex indices into a mesh. */
export type Face = readonly [number, number, number];

/** An axis-aligned bounding box, as `{ min, max }` corner points. */
export interface BoundingBox {
  /** The corner with the smallest component in every axis. */
  readonly min: Vec3;
  /** The corner with the largest component in every axis. */
  readonly max: Vec3;
}

/**
 * A simple indexed triangle mesh.
 *
 * Vertices are stored as {@link Vec3} points and faces as index triples into
 * that vertex list. The class is immutable in the same sense as {@link Vec3}:
 * {@link Mesh.translate} returns a fresh mesh rather than mutating.
 */
export class Mesh {
  /** The mesh vertices as {@link Vec3} points. */
  readonly vertices: readonly Vec3[];
  /** Triangles as index triples into {@link vertices}. */
  readonly faces: readonly Face[];

  constructor(vertices: readonly Vec3[], faces: readonly Face[] = []) {
    this.vertices = vertices;
    this.faces = faces;
  }

  /** Axis-aligned bounding box of the vertices, as `{ min, max }` corners. */
  boundingBox(): BoundingBox {
    if (this.vertices.length === 0) {
      throw new RangeError("cannot compute a bounding box of an empty mesh");
    }
    const xs = this.vertices.map((v) => v.x);
    const ys = this.vertices.map((v) => v.y);
    const zs = this.vertices.map((v) => v.z);
    // Constructs Vec3 (from vec3.ts) for each extreme corner.
    const min = new Vec3(Math.min(...xs), Math.min(...ys), Math.min(...zs));
    const max = new Vec3(Math.max(...xs), Math.max(...ys), Math.max(...zs));
    return { min, max };
  }

  /** Centroid of all vertices (delegates to {@link centroid} in vec3.ts). */
  centroid(): Vec3 {
    return centroid(this.vertices);
  }

  /** Return a copy of the mesh shifted by `offset` (uses {@link Vec3.add}). */
  translate(offset: Vec3): Mesh {
    const moved = this.vertices.map((v) => v.add(offset));
    return new Mesh(moved, this.faces);
  }

  /** Length of every triangle edge (delegates to {@link distance} in vec3.ts). */
  edgeLengths(): number[] {
    const lengths: number[] = [];
    for (const [i, j, k] of this.faces) {
      const a = this.vertices[i];
      const b = this.vertices[j];
      const c = this.vertices[k];
      lengths.push(distance(a, b), distance(b, c), distance(c, a));
    }
    return lengths;
  }

  /** Area of a single triangular face via the cross-product rule. */
  faceArea(face: Face): number {
    const [i, j, k] = face;
    const a = this.vertices[i];
    const b = this.vertices[j];
    const c = this.vertices[k];
    const edge1 = b.sub(a);
    const edge2 = c.sub(a);
    return 0.5 * edge1.cross(edge2).length();
  }

  /** Total surface area: the sum of every face area. */
  area(): number {
    let total = 0;
    for (const face of this.faces) {
      total += this.faceArea(face);
    }
    return total;
  }
}

/** Build a simple tetrahedron mesh, handy for demos and tests. */
export function unitTetrahedron(): Mesh {
  const vertices: Vec3[] = [
    new Vec3(0, 0, 0),
    new Vec3(1, 0, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, 0, 1),
  ];
  const faces: Face[] = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  return new Mesh(vertices, faces);
}
