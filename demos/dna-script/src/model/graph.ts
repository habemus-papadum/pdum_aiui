/**
 * graph.ts — the cell graph (playbook layer 2, disposable side), plus the agent
 * surface.
 *
 * The cells here are cheap and synchronous: the whole model is a parse and a
 * layout, and neither touches time, the network, or a worker. They are cells
 * rather than plain memos because they are the app's *named* derived values —
 * that is what puts them in `report`, gives them dependency edges, and lets a
 * component render them through `CellView` with attribution stamps attached.
 *
 * Every dependency arrives through the deps bundle; nothing is read inside
 * compute (the out-of-sync rule), and graph.test.ts moves each input in turn.
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import {
  formatSequence,
  gcFraction,
  isReversePalindrome,
  parseSequence,
  reverseComplement,
  stemLength,
} from "./dna";
import { dotBracket, foldSequence, helices, loops, pairedCount } from "./fold";
import { layoutFold, overlappingPairs } from "./foldLayout";
import { DEFAULT_METRICS, duplexLayout } from "./glyph";
import { appScope, minHelix, minLoop, rotatePartner, sequence } from "./store";

/**
 * Longest strand the main-thread folder will attempt. The search is O(n³);
 * at 160 bases that is ~4M steps, about the most that can run inside a
 * keystroke without the page stuttering.
 */
export const MAX_FOLD = 160;

/**
 * Strands worth having a button for. The first group is about the flat duplex;
 * the second is about folding, and each was chosen by running the folder and
 * keeping what it actually produced (see the note on each).
 */
export const EXAMPLES: Record<string, { label: string; seq: string; note: string }> = {
  ecoRI: { label: "EcoRI", seq: "GAATTC", note: "a six-base palindrome" },
  bamHI: { label: "BamHI", seq: "GGATCC", note: "another, GC-heavy at the ends" },
  hindIII: { label: "HindIII", seq: "AAGCTT", note: "AT-heavy at the ends" },
  plain: { label: "not a palindrome", seq: "ATGGCATTAC", note: "meshes, but has no symmetry" },
  armsZip: {
    label: "arms zip",
    seq: "GGGGATTTCCCC",
    note: "GGGG·CCCC arms close around an ATTT loop — the fragment is NOT a palindrome",
  },
  bulge: {
    label: "internal loop",
    seq: "GGGAAACCCAAAGGGAAACCC",
    note: "two helices with unpaired bases on both sides between them",
  },
  junction: {
    label: "junction",
    seq: "GCGCAAAAGCGCTTTTGCGCAAAAGCGC",
    note: "a multiloop: one stem branching into two hairpins",
  },
  tricky: {
    label: "not obvious",
    seq: "GCCGATAGCTCAGTTGGTAGAGCAGCGGATT",
    note: "a tRNA fragment — a bulged stem you would not find by eye",
  },
  gnarly: {
    label: "gnarly",
    seq: "GCGGATTTAGCTCAGTTGGGAGAGCGCCAGACTGAAGATCTGGAGGTCC",
    note: "49 bases: three helices, a bulge, an internal loop, and dangling tails",
  },
};

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  appScope.name,
  () => ({
    /** The strand as read: bases, what was ignored, and the facts about it. */
    strand: cell(
      () => ({ text: sequence.get() }),
      ({ text }) => {
        const { bases, rejected } = parseSequence(text);
        return {
          bases,
          rejected,
          letters: formatSequence(bases),
          partner: formatSequence(reverseComplement(bases)),
          palindrome: isReversePalindrome(bases),
          stem: stemLength(bases),
          gc: gcFraction(bases),
        };
      },
    ),

    /** Where every glyph sits in the two-row diagram, and which way up. */
    duplex: cell(
      () => ({ text: sequence.get(), rotate: rotatePartner.get() }),
      ({ text, rotate }) =>
        duplexLayout(parseSequence(text).bases, DEFAULT_METRICS, { rotateBottom: rotate }),
    ),

    /**
     * The strand folded onto itself: which bases pair, and where each one sits
     * on the page. Bounded by `MAX_FOLD` because the search is O(n³) and runs
     * on the main thread — past that it would jank the page, so it declines
     * rather than blocking. (A worker is the fix if long strands ever matter.)
     */
    folded: cell(
      () => ({ text: sequence.get(), minLoop: minLoop.get(), minHelix: minHelix.get() }),
      ({ text, minLoop: ml, minHelix: mh }) => {
        const bases = parseSequence(text).bases;
        if (bases.length > MAX_FOLD) {
          return { tooLong: true as const, length: bases.length, bases, pairs: null };
        }
        const pairs = foldSequence(bases, { minLoop: ml, minHelix: mh });
        const layout = layoutFold(bases, pairs, DEFAULT_METRICS);
        const structure = dotBracket(pairs);
        const found = loops(pairs);
        return {
          tooLong: false as const,
          bases,
          pairs,
          layout,
          structure,
          helices: helices(pairs),
          loops: found,
          paired: pairedCount(pairs),
          collisions: overlappingPairs(layout, DEFAULT_METRICS.width * 0.7),
        };
      },
    ),
  }),
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface: derived from the declarations -------------------------

const kit = agentToolkit(appScope.name);

/**
 * Replace the strand with its reverse complement. The buttons in the UI and the
 * agent tool below share this one implementation, so they cannot drift.
 * Returns what was written rather than reading the signal back — a write
 * commits at the next microtask.
 */
export function flipStrand(): string {
  const next = formatSequence(reverseComplement(parseSequence(sequence.get()).bases));
  sequence.set(next);
  return next;
}

/** Put a named example strand on the bench. Unknown names change nothing. */
export function loadExample(key: string): string | undefined {
  const example = EXAMPLES[key];
  if (!example) return undefined;
  sequence.set(example.seq);
  return example.seq;
}

/**
 * Replace the strand with its reverse complement — the same duplex, read from
 * the other side. A reverse palindrome comes back unchanged; anything else
 * visibly does not, which is the cheapest test for whether you are looking at
 * one.
 */
action({
  scope: appScope,
  name: "flip",
  run: () => ({ sequence: flipStrand() }),
});

/** Load one of the named example strands onto the bench. */
action({
  scope: appScope,
  name: "loadExample",
  params: { name: `one of: ${Object.keys(EXAMPLES).join(", ")}` },
  run: (args) => {
    const key = String(args?.name ?? "");
    const loaded = loadExample(key);
    if (loaded === undefined) {
      return { error: `unknown example "${key}"`, known: Object.keys(EXAMPLES) };
    }
    return { sequence: loaded, note: EXAMPLES[key].note };
  },
});

registerStandardTools(kit);
