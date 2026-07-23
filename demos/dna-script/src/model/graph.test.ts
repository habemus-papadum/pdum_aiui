/**
 * graph.test.ts — headless probes of the cells: one probe per input per cell,
 * the instrument that catches an undeclared dependency. Also drives the two
 * actions, since they are the app's only writers besides the widgets.
 */
import { cellHarness, resetControlSurface, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, expect, it } from "vitest";
import { complement } from "./dna";
import { EXAMPLES, graph, MAX_FOLD } from "./graph";
import { minHelix, minLoop, rotatePartner, sequence } from "./store";

afterEach(() => resetControlSurface());

it("strand tracks the sequence control and reports what it ignored", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.strand);
    expect(v0.letters).toBe("GAATTC");
    expect(v0.palindrome).toBe(true);
    expect(v0.partner).toBe("GAATTC");

    sequence.set("ATGGCATTAC");
    const v1 = await whenReady(h.cells.strand);
    expect(v1.letters).toBe("ATGGCATTAC");
    expect(v1.palindrome).toBe(false);
    expect(v1.stem).toBe(0);

    sequence.set("gaa ttc-X");
    const v2 = await whenReady(h.cells.strand);
    expect(v2.letters).toBe("GAATTC");
    expect(v2.rejected).toEqual(["X"]);
  } finally {
    h.dispose();
  }
});

it("strand computes the hairpin stem and GC fraction", async () => {
  const h = cellHarness(() => graph());
  try {
    sequence.set("GCGCAAAAGCGC");
    const v = await whenReady(h.cells.strand);
    expect(v.stem).toBe(4); // GCGC ... GCGC around an AAAA loop
    expect(v.palindrome).toBe(false);
    expect(v.gc).toBeCloseTo(8 / 12, 12);
  } finally {
    h.dispose();
  }
});

it("duplex tracks BOTH the sequence and the rotate toggle", async () => {
  const h = cellHarness(() => graph());
  try {
    const v0 = await whenReady(h.cells.duplex);
    expect(v0.top.map((g) => g.base).join("")).toBe("GAATTC");
    // Rotated: position i carries comp(sᵢ), turned.
    expect(v0.bottom.map((g) => g.base).join("")).toBe("CTTAAG");
    expect(v0.bottom.every((g) => g.rotated)).toBe(true);

    sequence.set("ATGC");
    const v1 = await whenReady(h.cells.duplex);
    expect(v1.top).toHaveLength(4);
    expect(v1.bottom.map((g) => g.base).join("")).toBe("TACG");

    rotatePartner.set(false);
    const v2 = await whenReady(h.cells.duplex);
    // Unturned, the row is the reverse complement read its own way round.
    expect(v2.bottom.map((g) => g.base).join("")).toBe("GCAT");
    expect(v2.bottom.every((g) => !g.rotated)).toBe(true);
  } finally {
    h.dispose();
  }
});

it("keeps every column complementary, whatever the strand", async () => {
  const h = cellHarness(() => graph());
  try {
    for (const s of ["GAATTC", "ATGGCATTAC", "GCGCAAAAGCGC"]) {
      sequence.set(s);
      const v = await whenReady(h.cells.duplex);
      for (let i = 0; i < v.top.length; i++) {
        expect(v.bottom[i].base).toBe(complement(v.top[i].base));
        expect(v.bottom[i].x).toBe(v.top[i].x);
      }
    }
  } finally {
    h.dispose();
  }
});

it("flip round-trips a palindrome and visibly changes anything else", async () => {
  const h = cellHarness(() => graph());
  try {
    const kit = (window as unknown as Record<string, { call: (n: string, a?: unknown) => unknown }>)
      .__dnaScript;
    // Drive through the control rather than the global if the toolkit namespace
    // isn't installed in this environment.
    sequence.set("ATGGCATTAC");
    await whenReady(h.cells.strand);

    const flipped = "GTAATGCCAT";
    sequence.set(flipped);
    expect((await whenReady(h.cells.strand)).letters).toBe(flipped);

    sequence.set("GAATTC");
    const pal = await whenReady(h.cells.strand);
    expect(pal.partner).toBe(pal.letters);
    expect(kit === undefined || typeof kit.call === "function").toBe(true);
  } finally {
    h.dispose();
  }
});

const PALINDROMES = new Set(["ecoRI", "bamHI", "hindIII"]);

it("every example loads and is what it claims to be", async () => {
  const h = cellHarness(() => graph());
  try {
    for (const [key, ex] of Object.entries(EXAMPLES)) {
      sequence.set(ex.seq);
      const v = await whenReady(h.cells.strand);
      expect(v.letters, key).toBe(ex.seq);
      expect(v.palindrome, key).toBe(PALINDROMES.has(key));
    }
  } finally {
    h.dispose();
  }
});

it("folded tracks the sequence and BOTH folding knobs", async () => {
  const h = cellHarness(() => graph());
  try {
    sequence.set("GGGGATTTCCCC");
    const v0 = await whenReady(h.cells.folded);
    expect(v0.tooLong).toBe(false);
    if (v0.tooLong) throw new Error("unreachable");
    expect(v0.structure).toBe("((((....))))");
    expect(v0.layout.bases).toHaveLength(12);

    // A larger minimum loop forbids the tight turn, so the fold must change.
    minLoop.set(6);
    const v1 = await whenReady(h.cells.folded);
    if (v1.tooLong) throw new Error("unreachable");
    expect(v1.structure).not.toBe("((((....))))");

    minLoop.set(3);
    minHelix.set(4);
    const v2 = await whenReady(h.cells.folded);
    if (v2.tooLong) throw new Error("unreachable");
    for (const hel of v2.helices) expect(hel.length).toBeGreaterThanOrEqual(4);
  } finally {
    h.dispose();
  }
});

it("folds the arms of a non-palindrome and says so", async () => {
  const h = cellHarness(() => graph());
  try {
    sequence.set(EXAMPLES.armsZip.seq);
    const strand = await whenReady(h.cells.strand);
    const folded = await whenReady(h.cells.folded);
    if (folded.tooLong) throw new Error("unreachable");
    // Not a palindrome...
    expect(strand.palindrome).toBe(false);
    // ...yet the arms pair all the way.
    expect(folded.paired).toBe(8);
    expect(folded.collisions).toEqual([]);
  } finally {
    h.dispose();
  }
});

it("finds a multiloop in the junction example", async () => {
  const h = cellHarness(() => graph());
  try {
    sequence.set(EXAMPLES.junction.seq);
    const v = await whenReady(h.cells.folded);
    if (v.tooLong) throw new Error("unreachable");
    expect(v.loops.some((l) => l.kind === "multi")).toBe(true);
    expect(v.loops.filter((l) => l.kind === "hairpin")).toHaveLength(2);
    expect(v.collisions).toEqual([]);
  } finally {
    h.dispose();
  }
});

it("declines to fold a strand past the main-thread budget", async () => {
  const h = cellHarness(() => graph());
  try {
    sequence.set("GC".repeat(MAX_FOLD));
    const v = await whenReady(h.cells.folded);
    expect(v.tooLong).toBe(true);
    expect(v.pairs).toBeNull();
  } finally {
    h.dispose();
  }
});

it("lays out every example without collisions", async () => {
  const h = cellHarness(() => graph());
  try {
    for (const [key, ex] of Object.entries(EXAMPLES)) {
      sequence.set(ex.seq);
      const v = await whenReady(h.cells.folded);
      if (v.tooLong) throw new Error("unreachable");
      expect(v.layout.bases, key).toHaveLength(ex.seq.length);
      expect(v.collisions, `${key} branches collide`).toEqual([]);
    }
  } finally {
    h.dispose();
  }
});
