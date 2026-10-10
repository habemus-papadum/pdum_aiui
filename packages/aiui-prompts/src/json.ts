/** Portable JSON boundary: never invoke getters or retain caller-owned objects. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function copyJson<T>(input: T): T {
  const active = new Set<object>();
  function visit(value: unknown, path: string): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value))
      return Object.is(value, -0) ? 0 : value;
    if (typeof value !== "object" || value === null)
      throw new TypeError(`Non-JSON value at ${path}`);
    if (active.has(value)) throw new TypeError(`Cyclic JSON at ${path}`);
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError(`Expected plain JSON at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`Symbol key at ${path}`);
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) throw new TypeError(`Accessor at ${path}.${key}`);
    }
    let result: JsonValue;
    if (Array.isArray(value)) {
      result = Array.from({ length: value.length }, (_, index) =>
        visit(descriptors[String(index)]?.value, `${path}[${index}]`),
      );
      if (
        Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      ) {
        throw new TypeError(`Non-index array property at ${path}`);
      }
    } else {
      const object: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable)
          throw new TypeError(`Non-enumerable JSON field at ${path}.${key}`);
        object[key] = visit(descriptor.value, `${path}.${key}`);
      }
      // Normalize prototypes without assigning special keys through the prototype setter.
      result = Object.fromEntries(Object.entries(object));
    }
    active.delete(value);
    return result;
  }
  return visit(input, "$") as T;
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Sorted object keys; arrays preserve order. Rejects non-JSON instead of silently dropping data. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(copyJson(value));
}

/** SHA-256 over UTF-8. The digest is portable across browser and Node synchronous callers. */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(length);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(length - 4, (bytes.length * 8) >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      words[i] =
        words[i - 16] +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[i - 7] +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          constants[i] +
          words[i]) |
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) state[i] = (state[i] + value) | 0;
  }
  return state.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
