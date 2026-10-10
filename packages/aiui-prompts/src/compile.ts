import { canonicalJson, freeze } from "./json.ts";
import {
  type Asset,
  type ChunkBoundary,
  type ChunkCut,
  COMPILER,
  type CompiledPrompt,
  type CompileOptions,
  type Contribution,
  type Decision,
  type Definition,
  type Occurrence,
  type Origin,
  type OutputPart,
  type Placement,
  PromptError,
  type PromptValue,
  RECORD_KIND,
  type SemanticRecord,
  type SemanticRegion,
} from "./model.ts";
import { occurrenceId, parseRecord, snapshot, withRecordOptions } from "./record.ts";
import { CONSERVATIVE_ESTIMATOR, estimateParts, type TokenEstimator } from "./tokens.ts";
import { projectTools } from "./tools-data.ts";

/**
 * What a compile needs beyond the record: the token estimator a `tokens`
 * elision counts with. The built-in conservative estimator is the default, so
 * a record compiled without one replays with nothing supplied; a host that
 * supplied its own must supply the same one again (its identity is in the
 * decision).
 */
export type CompileServices = Readonly<{ estimator?: TokenEstimator }>;

type TextAtom = {
  type: "text";
  text: string;
  occurrence: string;
  relation: Contribution["relation"];
  origin?: Origin;
  escapeXml?: boolean;
};
type Atom =
  | TextAtom
  | { type: "image"; asset: Asset; occurrence: string }
  | { type: "open" | "close"; region: Omit<SemanticRegion, "part" | "start" | "end"> }
  /** A chunk boundary: the chunk `index` of `occurrence` begins here. */
  | { type: "cut"; occurrence: string; index: number; boundary: ChunkBoundary | "image" };
type Environment = { depth: number; mode: "normal" | "math"; xml: boolean };
const nonempty = (atoms: readonly Atom[]) =>
  atoms.some((atom) => atom.type === "image" || (atom.type === "text" && atom.text.length > 0));
const xml = (text: string) => {
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    if (
      !(
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )
    )
      throw new PromptError("XML_CHARACTER", "Text contains an invalid XML 1.0 character.");
  }
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
};
const attribute = (text: string) =>
  xml(text)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");

function compile(record: SemanticRecord, services: CompileServices = {}): CompiledPrompt {
  const estimator = services.estimator ?? CONSERVATIVE_ESTIMATOR;
  const definitions = new Map(record.definitions.map((definition) => [definition.id, definition]));
  const recorded = new Map(record.decisions.map((decision) => [decision.occurrence, decision]));
  const decisions: Decision[] = [...record.decisions];
  const occurrences: Occurrence[] = [];
  const text = (
    value: string,
    occurrence: string,
    relation: Contribution["relation"] = "authored",
    origin?: Origin,
    escapeXml = false,
  ): TextAtom => ({
    type: "text",
    text: value,
    occurrence,
    relation,
    ...(origin ? { origin } : {}),
    ...(escapeXml ? { escapeXml: true } : {}),
  });
  function joined(groups: Atom[][], separator: string, owner: string, escapeXml = false): Atom[] {
    const retained = groups.filter(nonempty);
    const result: Atom[] = [];
    for (const [i, group] of retained.entries()) {
      if (i && separator) result.push(text(separator, owner, "generated", undefined, escapeXml));
      result.push(...group);
    }
    return result;
  }
  function region(
    kind: SemanticRegion["kind"],
    owner: string,
    atoms: Atom[],
    mode?: "inline" | "display",
  ): Atom[] {
    const value = { id: `${owner}:region`, kind, occurrence: owner, ...(mode ? { mode } : {}) };
    return [{ type: "open", region: value }, ...atoms, { type: "close", region: value }];
  }
  function render(
    edge: Placement,
    id: string,
    parent: string | undefined,
    env: Environment,
  ): Atom[] {
    if (occurrences.length >= 50000)
      throw new PromptError("GRAPH_LIMIT", "Prompt occurrence expansion exceeds 50000.");
    const def = definitions.get(edge.definition) as Definition;
    occurrences.push({
      id,
      definition: def.id,
      kind: def.kind,
      ...(parent ? { parent } : {}),
      ...(def.origin ? { definitionOrigin: def.origin } : {}),
      ...(def.origin || edge.origin || edge.origins
        ? {
            origins: [
              ...(def.origin ? [def.origin] : []),
              ...(edge.origins ?? (edge.origin ? [edge.origin] : [])),
            ],
          }
        : {}),
      ...(edge.key !== undefined ? { key: edge.key } : {}),
      ...((edge.label ?? def.label) ? { label: edge.label ?? def.label } : {}),
      ...((edge.origin ?? def.origin) ? { origin: edge.origin ?? def.origin } : {}),
    });
    const children = (environment = env) =>
      "children" in def
        ? (def.children ?? []).map((child, i) =>
            render(child, occurrenceId(id, child, i), id, environment),
          )
        : [];
    if (env.mode === "math" && ["prompt", "section", "image", "xml", "math"].includes(def.kind))
      throw new PromptError("MATH_CONTENT", `Cannot place ${def.kind} inside TeX.`, id);
    if (env.xml && def.kind === "image")
      throw new PromptError(
        "XML_CONTENT",
        `Cannot place ${def.kind} in XML without an explicit textual projection.`,
        id,
      );
    switch (def.kind) {
      case "text":
        return [text(def.value, id, "authored", undefined, env.xml)];
      case "group":
      case "paragraph":
        return children().flat();
      case "prompt":
        return joined(children(), "\n\n", id, env.xml);
      case "join":
        return joined(children(), def.separator, id, env.xml);
      case "section": {
        const body = joined(children({ ...env, depth: env.depth + 1 }), "\n\n", id);
        if (!nonempty(body) && !def.keepEmpty) return [];
        if (env.depth > 6)
          throw new PromptError("HEADING_DEPTH", "Markdown heading depth exceeds six.", id);
        return [
          text(`${"#".repeat(env.depth)} `, id, "generated"),
          text(
            def.title.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&"),
            id,
            "escaped",
            undefined,
            env.xml,
          ),
          ...(nonempty(body) ? [text("\n\n", id, "generated"), ...body] : []),
        ];
      }
      case "math": {
        const body = children({ ...env, mode: "math" }).flat();
        return region(
          "math",
          id,
          [
            text(def.mode === "inline" ? "$" : "$$\n", id, "generated"),
            ...body,
            text(def.mode === "inline" ? "$" : "\n$$", id, "generated"),
          ],
          def.mode,
        );
      }
      case "image":
        return [{ type: "image", asset: def.asset, occurrence: id }];
      case "xml": {
        const attrs = Object.entries(def.attributes)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ` ${key}="${attribute(value)}"`)
          .join("");
        return region("xml", id, [
          text(`<${def.tag}${attrs}>`, id, "generated"),
          ...children({ ...env, xml: true }).flat(),
          text(`</${def.tag}>`, id, "generated"),
        ]);
      }
      case "tools": {
        if (env.mode === "math")
          throw new PromptError(
            "TOOLS_CONTEXT",
            "Tool projections cannot be placed inside a TeX body.",
            id,
          );
        const projection = projectTools(def.toolSnapshot, def.projection);
        for (const decision of projection.decisions)
          decisions.push({
            ...decision,
            occurrence: id,
            ...(env.xml
              ? { detail: { ...decision.detail, scope: "projection-before-xml-text-escaping" } }
              : {}),
          });
        return projection.segments.map((segment) =>
          text(segment.text, id, segment.relation, segment.origin, env.xml),
        );
      }
      case "marker": {
        const prefix = `[${def.name}${Object.entries(def.fields)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ` ${key}=${canonicalJson(value)}`)
          .join("")}`;
        const body = children().flat();
        if (body.some((atom) => atom.type === "image"))
          throw new PromptError(
            "MARKER_MEDIA",
            "Bracket markers require a textual asset projection, not atomic media.",
            id,
          );
        return region("marker", id, [
          text(prefix, id, "generated", undefined, env.xml),
          ...(nonempty(body) ? [text(" ", id, "generated"), ...body] : []),
          text("]", id, "generated", undefined, env.xml),
        ]);
      }
      case "choice": {
        const decision = recorded.get(id) as Decision;
        if (decision.selected === "omit") return [];
        const child = decision.selected === "short" ? (def.short as Placement) : def.full;
        return render(child, occurrenceId(id, child, decision.selected), id, env);
      }
      case "case": {
        const decision = recorded.get(id) as Decision;
        const child =
          decision.selected === "fallback"
            ? def.fallback
            : def.branches[Number(decision.selected)].value;
        return render(child, occurrenceId(id, child, decision.selected), id, env);
      }
      case "elide": {
        const groups = children();
        const keepLast = def.keep === "last";
        const marker = text(def.marker, id, "generated", undefined, env.xml);
        const framed = (kept: Atom[], omitted: number): Atom[] =>
          omitted === 0 ? kept : keepLast ? [marker, ...kept] : [...kept, marker];
        if (def.unit === "items") {
          const omitted = globalThis.Math.max(0, groups.length - def.limit);
          decisions.push({
            occurrence: id,
            kind: "elide",
            selected: omitted ? "clipped" : "full",
            detail: {
              unit: def.unit,
              limit: def.limit,
              keep: def.keep,
              original: groups.length,
              omitted,
            },
          });
          const kept = keepLast
            ? groups.slice(groups.length - def.limit)
            : groups.slice(0, def.limit);
          return framed(kept.flat(), omitted);
        }
        if (def.unit === "tokens") {
          // Whole children, as many as fit the budget from the kept end,
          // counted under the compile's estimator (pre-XML-escaping text).
          const counts = groups.map((group) => {
            const parts: ({ type: "text"; text: string } | { type: "image"; asset: Asset })[] = [];
            for (const atom of group) {
              if (atom.type === "text") parts.push({ type: "text", text: atom.text });
              else if (atom.type === "image") parts.push({ type: "image", asset: atom.asset });
            }
            return estimateParts(parts, estimator);
          });
          const order = [...groups.keys()];
          if (keepLast) order.reverse();
          const kept = new Set<number>();
          let used = 0;
          for (const index of order) {
            if (used + counts[index] > def.limit) break;
            used += counts[index];
            kept.add(index);
          }
          const omitted = groups.length - kept.size;
          decisions.push({
            occurrence: id,
            kind: "elide",
            selected: omitted ? "clipped" : "full",
            detail: {
              unit: def.unit,
              limit: def.limit,
              keep: def.keep,
              estimator: estimator.identity,
              original: groups.length,
              omitted,
              tokens: { original: counts.reduce((sum, n) => sum + n, 0), kept: used },
              ...(env.xml ? { scope: "content-before-xml-text-escaping" } : {}),
            },
          });
          return framed(groups.filter((_, index) => kept.has(index)).flat(), omitted);
        }
        const atoms = groups.flat();
        if (atoms.some((atom) => atom.type === "image"))
          throw new PromptError(
            "ELISION_MEDIA",
            "Character/line elision only accepts text; use item selection for media.",
            id,
          );
        if (atoms.some((atom) => atom.type === "cut"))
          throw new PromptError(
            "CHUNK_ELISION",
            "A character/line elision cannot window through a chunk's cuts; elide the content, then chunk it.",
            id,
          );
        const source = atoms
          .filter((atom): atom is TextAtom => atom.type === "text")
          .map((atom) => atom.text)
          .join("");
        // Limits count pre-XML-escaping content; final contribution offsets/counts use emitted UTF-16.
        const units =
          def.unit === "characters" ? Array.from(source) : source.length ? source.split("\n") : [];
        const original = units.length;
        const omitted = globalThis.Math.max(0, original - def.limit);
        decisions.push({
          occurrence: id,
          kind: "elide",
          selected: omitted ? "clipped" : "full",
          detail: {
            unit: def.unit,
            limit: def.limit,
            keep: def.keep,
            original,
            omitted,
            ...(env.xml ? { scope: "content-before-xml-text-escaping" } : {}),
          },
        });
        if (!omitted) return atoms;
        const separator = def.unit === "characters" ? "" : "\n";
        const retainedText = (
          keepLast ? units.slice(original - def.limit) : units.slice(0, def.limit)
        ).join(separator);
        // The kept window in source coordinates: a head keeps [0, n), a tail
        // keeps [length - n, length). Text is clipped at the window's edges;
        // a math/XML/marker scope must lie wholly inside or wholly outside.
        const windowStart = keepLast ? source.length - retainedText.length : 0;
        const windowEnd = windowStart + retainedText.length;
        const spans = new Map<string, { start: number; end: number }>();
        let cursor = 0;
        for (const atom of atoms) {
          if (atom.type === "open") spans.set(atom.region.id, { start: cursor, end: cursor });
          else if (atom.type === "close") {
            const span = spans.get(atom.region.id);
            if (span) span.end = cursor;
          } else if (atom.type === "text") cursor += atom.text.length;
        }
        const inside = (span: { start: number; end: number }) =>
          span.start >= windowStart && span.end <= windowEnd;
        const outside = (span: { start: number; end: number }) =>
          span.end <= windowStart || span.start >= windowEnd;
        for (const span of spans.values())
          if (span.end > span.start && !inside(span) && !outside(span))
            throw new PromptError(
              "ATOMIC_ELISION",
              "Elision would cut a math/XML/marker scope; choose an authored alternative.",
              id,
            );
        const retained: Atom[] = [];
        cursor = 0;
        for (const atom of atoms) {
          if (atom.type === "open" || atom.type === "close") {
            const span = spans.get(atom.region.id);
            if (span && span.end > span.start && inside(span)) retained.push(atom);
            continue;
          }
          if (atom.type !== "text") continue;
          const start = globalThis.Math.max(cursor, windowStart);
          const end = globalThis.Math.min(cursor + atom.text.length, windowEnd);
          if (end > start)
            retained.push({ ...atom, text: atom.text.slice(start - cursor, end - cursor) });
          cursor += atom.text.length;
        }
        return framed(retained, omitted);
      }
      case "chunk":
        return chunked(def, id, children().flat(), env);
    }
  }
  /**
   * The partition. Content is measured in VIRTUAL slots — one per text code
   * unit, one per image — so a cut beside an image is a position like any
   * other; math/XML/marker scopes are atomic spans no cut may enter. Windows
   * fill greedily from the start: the farthest end within the budget is found
   * by bisection (an estimator is monotone in prefixes), then the cut is the
   * last position in the window of the strongest boundary kind listed. The
   * whitespace at a cut stays with the chunk before it; nothing is omitted.
   */
  function chunked(
    def: Extract<Definition, { kind: "chunk" }>,
    id: string,
    atoms: Atom[],
    env: Environment,
  ): Atom[] {
    if (atoms.some((atom) => atom.type === "cut"))
      throw new PromptError("CHUNK_NESTED", "A chunk cannot contain another chunk.", id);
    const chars: string[] = [];
    const images: (Asset | undefined)[] = [];
    const spans: { start: number; end: number }[] = [];
    const openAt = new Map<string, number>();
    for (const atom of atoms) {
      if (atom.type === "text")
        for (let i = 0; i < atom.text.length; i++) {
          chars.push(atom.text[i]);
          images.push(undefined);
        }
      else if (atom.type === "image") {
        chars.push("");
        images.push(atom.asset);
      } else if (atom.type === "open") openAt.set(atom.region.id, chars.length);
      else if (atom.type === "close") {
        const start = openAt.get(atom.region.id);
        if (start !== undefined && chars.length > start) spans.push({ start, end: chars.length });
      }
    }
    const total = chars.length;
    // Prefix tables: the text before each slot, and the image cost before each slot.
    const allText = chars.join("");
    const textBefore = new Array<number>(total + 1);
    const imagesBefore = new Array<number>(total + 1);
    textBefore[0] = 0;
    imagesBefore[0] = 0;
    for (let i = 0; i < total; i++) {
      textBefore[i + 1] = textBefore[i] + chars[i].length;
      const asset = images[i];
      imagesBefore[i + 1] =
        imagesBefore[i] + (asset && def.unit === "tokens" ? estimator.image(asset) : 0);
    }
    const count = (value: string) =>
      def.unit === "tokens" ? estimator.text(value) : Array.from(value).length;
    const measure = (from: number, to: number) =>
      count(allText.slice(textBefore[from], textBefore[to])) +
      imagesBefore[to] -
      imagesBefore[from];
    const markerCost = def.marker ? count(def.marker) : 0;
    const ch = (i: number): string | undefined =>
      i < 0 || i >= total || images[i] !== undefined ? undefined : chars[i];
    const isImage = (i: number) => i >= 0 && i < total && images[i] !== undefined;
    const space = (value: string | undefined) => value !== undefined && /\s/.test(value);
    const blocked = (k: number) => {
      if (spans.some((span) => span.start < k && k < span.end)) return true;
      const before = ch(k - 1);
      const after = ch(k);
      return (
        before !== undefined &&
        after !== undefined &&
        /[\uD800-\uDBFF]/.test(before) &&
        /[\uDC00-\uDFFF]/.test(after)
      );
    };
    const kindsAt = (k: number): Set<ChunkBoundary> => {
      const kinds = new Set<ChunkBoundary>(["character"]);
      const before = ch(k - 1);
      const after = ch(k);
      if (before === "\n" && after !== "\n") {
        kinds.add("line");
        if (ch(k - 2) === "\n") kinds.add("paragraph");
      }
      if (space(before) && after !== undefined && !space(after)) {
        kinds.add("word");
        let j = k - 1;
        while (j >= 0 && space(ch(j))) j--;
        while (j >= 0 && /["')\]»”’]/.test(ch(j) ?? "")) j--;
        if (j >= 0 && /[.!?]/.test(ch(j) ?? "")) kinds.add("sentence");
      }
      return kinds;
    };
    const findCut = (start: number, end: number): ChunkCutAt | undefined => {
      for (let k = end; k > start; k--)
        if (!blocked(k) && (isImage(k - 1) || isImage(k))) return { at: k, boundary: "image" };
      for (const kind of def.boundaries)
        for (let k = end; k > start; k--)
          if (!blocked(k) && kindsAt(k).has(kind)) return { at: k, boundary: kind };
      return undefined;
    };
    const cuts: ChunkCutAt[] = [];
    let start = 0;
    while (start < total) {
      const budget = def.limit - (cuts.length ? markerCost : 0);
      if (budget < 0)
        throw new PromptError(
          "CHUNK_OVERFLOW",
          `The chunk marker alone exceeds the budget of ${def.limit} ${def.unit}.`,
          id,
        );
      // The farthest end within the budget: measure is monotone in the end.
      let low = start;
      let high = total;
      while (low < high) {
        const mid = low + globalThis.Math.ceil((high - low) / 2);
        if (measure(start, mid) <= budget) low = mid;
        else high = mid - 1;
      }
      const end = low;
      if (end === total) break;
      const cut = findCut(start, end);
      if (cut === undefined) {
        if (def.boundaries.includes("character"))
          throw new PromptError(
            "ATOMIC_CHUNK",
            `A budget of ${def.limit} ${def.unit} cannot hold an atomic math/XML/marker scope or image; raise the limit.`,
            id,
          );
        throw new PromptError(
          "CHUNK_OVERFLOW",
          `No ${def.boundaries.join("/")} boundary lies within the budget of ${def.limit} ${def.unit}; add a finer boundary or raise the limit.`,
          id,
        );
      }
      cuts.push(cut);
      start = cut.at;
    }
    const edges = [0, ...cuts.map((cut) => cut.at), total];
    const sizes = edges
      .slice(0, -1)
      .map((from, i) => measure(from, edges[i + 1]) + (i ? markerCost : 0));
    decisions.push({
      occurrence: id,
      kind: "chunk",
      selected: String(cuts.length + 1),
      detail: {
        unit: def.unit,
        limit: def.limit,
        boundaries: [...def.boundaries],
        ...(def.unit === "tokens" ? { estimator: estimator.identity } : {}),
        count: cuts.length + 1,
        cuts: cuts.map((cut) => ({ at: cut.at, boundary: cut.boundary })),
        sizes,
        ...(env.xml ? { scope: "content-before-xml-text-escaping" } : {}),
      },
    });
    // Re-emit the atoms with a cut (and the marker) at every boundary; a text
    // atom straddling a cut is split, a region opening at a cut follows it.
    const out: Atom[] = [];
    let cursor = 0;
    let next = 0;
    const emitCut = () => {
      out.push({ type: "cut", occurrence: id, index: next + 1, boundary: cuts[next].boundary });
      if (def.marker) out.push(text(def.marker, id, "generated", undefined, env.xml));
      next++;
    };
    const due = (position: number) => next < cuts.length && cuts[next].at === position;
    for (const atom of atoms) {
      if (atom.type === "text") {
        let offset = 0;
        while (next < cuts.length && cuts[next].at <= cursor + atom.text.length) {
          const at = cuts[next].at - cursor;
          if (at > offset) out.push({ ...atom, text: atom.text.slice(offset, at) });
          emitCut();
          offset = at;
        }
        if (offset < atom.text.length) out.push({ ...atom, text: atom.text.slice(offset) });
        cursor += atom.text.length;
      } else if (atom.type === "image") {
        if (due(cursor)) emitCut();
        out.push(atom);
        cursor += 1;
      } else {
        if (atom.type === "open" && due(cursor)) emitCut();
        out.push(atom);
      }
    }
    return out;
  }
  const atoms = render(record.root, "o", undefined, { depth: 1, mode: "normal", xml: false });
  const parts: OutputPart[] = [];
  const contributions: Contribution[] = [];
  const semanticRegions: SemanticRegion[] = [];
  const cuts: ChunkCut[] = [];
  const open = new Map<
    string,
    { value: Omit<SemanticRegion, "part" | "start" | "end">; part: string; start: number }
  >();
  function currentText(): { id: string; type: "text"; text: string } {
    let part = parts.at(-1);
    if (part?.type !== "text") {
      part = { id: `p${parts.length}`, type: "text", text: "" };
      parts.push(part);
    }
    return part as { id: string; type: "text"; text: string };
  }
  for (const atom of atoms) {
    if (atom.type === "image") {
      const part = { id: `p${parts.length}`, type: "image" as const, asset: atom.asset };
      parts.push(part);
      contributions.push({ occurrence: atom.occurrence, part: part.id, relation: "authored" });
    } else if (atom.type === "text") {
      if (!atom.text) continue;
      const part = currentText();
      const start = part.text.length;
      const emitted = atom.escapeXml ? xml(atom.text) : atom.text;
      const relation =
        atom.escapeXml && emitted !== atom.text && atom.relation !== "generated"
          ? "escaped"
          : atom.relation;
      part.text += emitted;
      const previous = contributions.at(-1);
      if (
        previous?.part === part.id &&
        previous.occurrence === atom.occurrence &&
        previous.relation === relation &&
        previous.end === start &&
        canonicalJson(previous.origin ?? null) === canonicalJson(atom.origin ?? null)
      )
        contributions[contributions.length - 1] = { ...previous, end: part.text.length };
      else
        contributions.push({
          occurrence: atom.occurrence,
          part: part.id,
          start,
          end: part.text.length,
          relation,
          ...(atom.origin ? { origin: atom.origin } : {}),
        });
    } else if (atom.type === "cut") {
      // Before the next emitted code unit: inside the open text part, or at
      // the start of whichever part comes next (an image, or new text).
      const last = parts.at(-1);
      cuts.push({
        occurrence: atom.occurrence,
        index: atom.index,
        boundary: atom.boundary,
        at:
          last?.type === "text"
            ? { part: last.id, offset: last.text.length }
            : { part: `p${parts.length}`, offset: 0 },
      });
    } else if (atom.type === "open") {
      const part = currentText();
      open.set(atom.region.id, { value: atom.region, part: part.id, start: part.text.length });
    } else {
      const start = open.get(atom.region.id);
      const part = currentText();
      if (!start || start.part !== part.id)
        throw new PromptError("REGION_PART", "A semantic region crossed a media boundary.");
      if (part.text.length > start.start)
        semanticRegions.push({
          ...start.value,
          part: part.id,
          start: start.start,
          end: part.text.length,
        });
      open.delete(atom.region.id);
    }
  }
  return freeze({
    recordFingerprint: record.fingerprint,
    compiler: COMPILER,
    parts,
    occurrences,
    contributions,
    decisions,
    diagnostics: [],
    semanticRegions,
    // Canonical positions: a cut at the end of a text part is the start of
    // the part that follows it (always an image — text would have coalesced).
    cuts: cuts.map((cut) => {
      const index = parts.findIndex((part) => part.id === cut.at.part);
      const part = parts[index];
      return part?.type === "text" && cut.at.offset === part.text.length && index + 1 < parts.length
        ? { ...cut, at: { part: parts[index + 1].id, offset: 0 } }
        : cut;
    }),
  });
}
type ChunkCutAt = { at: number; boundary: ChunkBoundary | "image" };

/** One part of a chunk: a verbatim range of a text part, or a whole image part. */
export type ChunkPart = Readonly<
  | { part: string; type: "text"; text: string; start: number; end: number }
  | { part: string; type: "image"; asset: Asset }
>;
export type ChunkSlice = Readonly<{ index: number; count: number; parts: readonly ChunkPart[] }>;
/**
 * The compiled prompt as the consecutive chunks a capped transport delivers,
 * each a run of part ranges in order. A prompt with no chunk occurrence is one
 * chunk. A chunked delivery needs exactly one chunk occurrence owning every
 * contribution: a heading beside the chunk would belong to no chunk and break
 * its budget, so that is refused rather than guessed.
 */
export function chunksOf(compiled: CompiledPrompt): readonly ChunkSlice[] {
  const owners = compiled.occurrences.filter((occurrence) => occurrence.kind === "chunk");
  if (owners.length > 1)
    throw new PromptError(
      "CHUNK_MULTIPLE",
      `A chunked delivery needs exactly one chunk occurrence; this prompt has ${owners.length}.`,
    );
  const whole: ChunkPart[] = compiled.parts.map((part) =>
    part.type === "text"
      ? { part: part.id, type: "text", text: part.text, start: 0, end: part.text.length }
      : { part: part.id, type: "image", asset: part.asset },
  );
  const owner = owners[0];
  if (!owner) return freeze([{ index: 0, count: 1, parts: whole }]);
  const parents = new Map(compiled.occurrences.map((item) => [item.id, item.parent]));
  const inFamily = (occurrence: string) => {
    let current: string | undefined = occurrence;
    while (current !== undefined) {
      if (current === owner.id) return true;
      current = parents.get(current);
    }
    return false;
  };
  if (compiled.contributions.some((contribution) => !inFamily(contribution.occurrence)))
    throw new PromptError(
      "CHUNK_SIBLINGS",
      "A chunked delivery needs the chunk to own every contribution; content beside it belongs to no chunk.",
      owner.id,
    );
  const cuts = [...compiled.cuts]
    .filter((cut) => cut.occurrence === owner.id)
    .sort((a, b) => a.index - b.index);
  const index = new Map(compiled.parts.map((part, i) => [part.id, i]));
  const positions = [
    { part: 0, offset: 0 },
    ...cuts.map((cut) => ({
      part: index.get(cut.at.part) ?? compiled.parts.length,
      offset: cut.at.offset,
    })),
    { part: compiled.parts.length, offset: 0 },
  ];
  const count = cuts.length + 1;
  return freeze(
    positions.slice(0, -1).map((from, i) => {
      const to = positions[i + 1];
      const parts: ChunkPart[] = [];
      for (const [pi, part] of compiled.parts.entries()) {
        if (pi < from.part || pi > to.part) continue;
        if (part.type === "image") {
          if ((pi > from.part || from.offset === 0) && pi < to.part)
            parts.push({ part: part.id, type: "image", asset: part.asset });
          continue;
        }
        const low = pi === from.part ? from.offset : 0;
        const high = pi === to.part ? to.offset : part.text.length;
        if (high > low)
          parts.push({
            part: part.id,
            type: "text",
            text: part.text.slice(low, high),
            start: low,
            end: high,
          });
      }
      return { index: i, count, parts };
    }),
  );
}

/** Compile a durable semantic record or snapshot an already evaluated authoring value. */
export function compilePrompt(
  value: SemanticRecord | PromptValue,
  options?: CompileOptions,
  services?: CompileServices,
): CompiledPrompt {
  const isRecord =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === RECORD_KIND;
  const record = isRecord
    ? options
      ? withRecordOptions(value as SemanticRecord, options)
      : parseRecord(value)
    : snapshot(value as PromptValue, options);
  return compile(record, services);
}
/** Exact re-derivation only: an unavailable compiler or changed record is a typed error.
 * A record whose `tokens` elisions were counted under a host estimator needs that estimator again. */
export function rehydrate(record: SemanticRecord, services?: CompileServices): CompiledPrompt {
  return compile(parseRecord(record), services);
}
