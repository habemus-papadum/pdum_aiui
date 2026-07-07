/**
 * 3-D vector geometry — the foundation of the TypeScript demo.
 *
 * {@link Vec3} and the free functions {@link distance} and {@link centroid} are
 * imported and used by `mesh.ts` and `pipeline.ts`, so this module is the root
 * of a dense set of cross-file references. It mirrors the Python `geometry.py`
 * fixture in spirit, giving the code reader parallel navigation targets across
 * both languages.
 */

/** A length-3 tuple of numbers, handy when interoperating with raw arrays. */
export type Vec3Tuple = readonly [number, number, number];

/**
 * An immutable 3-D vector backed by three numbers.
 *
 * Instances are treated as frozen: every arithmetic method returns a *new*
 * `Vec3` rather than mutating in place, which keeps them cheap to reason about
 * when threaded through the mesh and pipeline code.
 */
export class Vec3 {
  /** The x component. */
  readonly x: number;
  /** The y component. */
  readonly y: number;
  /** The z component. */
  readonly z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Build a {@link Vec3} from any length-3 iterable of numbers. */
  static fromArray(arr: Iterable<number>): Vec3 {
    const a = [...arr];
    if (a.length !== 3) {
      throw new RangeError(`expected 3 components, got ${a.length}`);
    }
    return new Vec3(a[0], a[1], a[2]);
  }

  /** Return the vector as a plain length-3 tuple. */
  toArray(): Vec3Tuple {
    return [this.x, this.y, this.z];
  }

  /** Scalar (dot) product with `other`. */
  dot(other: Vec3): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  /** Vector (cross) product with `other`. */
  cross(other: Vec3): Vec3 {
    return new Vec3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  /** Euclidean length (magnitude) of the vector. */
  length(): number {
    return Math.sqrt(this.dot(this));
  }

  /** Component-wise sum, returning a new vector. */
  add(other: Vec3): Vec3 {
    return new Vec3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  /** Component-wise difference, returning a new vector. */
  sub(other: Vec3): Vec3 {
    return new Vec3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** Scale every component by `scalar`, returning a new vector. */
  scale(scalar: number): Vec3 {
    return new Vec3(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  /** Return a unit vector pointing in the same direction. */
  normalized(): Vec3 {
    const len = this.length();
    if (len === 0) {
      throw new RangeError("cannot normalize a zero-length vector");
    }
    return this.scale(1 / len);
  }

  /** Human-readable representation, e.g. `Vec3(1, 2, 3)`. */
  toString(): string {
    return `Vec3(${this.x}, ${this.y}, ${this.z})`;
  }
}

/**
 * Euclidean distance between two points.
 *
 * Used by {@link Mesh.edgeLengths} in `mesh.ts`.
 */
export function distance(a: Vec3, b: Vec3): number {
  return a.sub(b).length();
}

/**
 * Arithmetic mean of a sequence of points.
 *
 * Used by {@link Mesh.centroid} in `mesh.ts`.
 */
export function centroid(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) {
    throw new RangeError("centroid of an empty point set is undefined");
  }
  let acc = new Vec3(0, 0, 0);
  for (const p of points) {
    acc = acc.add(p);
  }
  return acc.scale(1 / points.length);
}
