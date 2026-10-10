import { rehydrate } from "./compile.ts";
import { canonicalJson, freeze } from "./json.ts";
import {
  type CompiledPrompt,
  type Contribution,
  PromptError,
  type Selection,
  type SemanticRecord,
} from "./model.ts";
import { parseRecord, withRecordOptions } from "./record.ts";

/** Query exact emitted intervals; source ownership may remain coarse. */
export function mappingIndex(compiled: CompiledPrompt) {
  const occurrences = new Map(compiled.occurrences.map((item) => [item.id, item]));
  const parts = new Map(compiled.parts.map((item) => [item.id, item]));
  const ranges = new Map<string, Contribution[]>();
  for (const item of compiled.contributions) {
    const list = ranges.get(item.part) ?? [];
    list.push(item);
    ranges.set(item.part, list);
  }
  return {
    explain(partId: string, start?: number, end?: number) {
      const part = parts.get(partId);
      if (!part) throw new PromptError("OUTPUT_ADDRESS", `Unknown part ${partId}.`);
      if (part.type === "image" && (start !== undefined || end !== undefined))
        throw new PromptError(
          "OUTPUT_ADDRESS",
          "Image parts have atomic addresses, not text offsets.",
        );
      if (
        part.type === "text" &&
        (start !== undefined || end !== undefined) &&
        (!Number.isInteger(start) ||
          !Number.isInteger(end) ||
          (start as number) < 0 ||
          (end as number) < (start as number) ||
          (end as number) > part.text.length)
      )
        throw new PromptError("OUTPUT_ADDRESS", "Invalid half-open UTF-16 range.");
      const candidates = ranges.get(partId) ?? [];
      // Contribution intervals are sorted and partition text. Binary-search the first overlap.
      let low = 0;
      let high = candidates.length;
      if (start !== undefined)
        while (low < high) {
          const middle = (low + high) >>> 1;
          if ((candidates[middle].end ?? Infinity) <= start) low = middle + 1;
          else high = middle;
        }
      const result = [];
      for (let i = low; i < candidates.length; i++) {
        const item = candidates[i];
        if (end !== undefined && (item.start ?? 0) >= end) break;
        if (start === end && start !== undefined) break;
        const chain = [];
        let occurrence = occurrences.get(item.occurrence);
        while (occurrence) {
          chain.push(occurrence);
          occurrence = occurrence.parent ? occurrences.get(occurrence.parent) : undefined;
        }
        result.push({
          contribution: item,
          owners: chain,
          sourcePrecision:
            item.origin ||
            chain.some((owner) => owner.origin || owner.definitionOrigin || owner.origins?.length)
              ? ("owner" as const)
              : ("unavailable" as const),
        });
      }
      return result;
    },
    forOccurrence(id: string, descendants = true) {
      if (!occurrences.has(id)) throw new PromptError("OCCURRENCE", `Unknown occurrence ${id}.`);
      const contains = (candidate: string) => {
        let item = occurrences.get(candidate);
        while (item) {
          if (item.id === id) return true;
          if (!descendants || !item.parent) break;
          item = occurrences.get(item.parent);
        }
        return false;
      };
      return compiled.contributions.filter((item) => contains(item.occurrence));
    },
  };
}
export function measurePrompt(compiled: CompiledPrompt) {
  const exclusive: Record<string, { codeUnits: number; images: number }> = {};
  for (const part of compiled.contributions) {
    const counts = exclusive[part.occurrence] ?? { codeUnits: 0, images: 0 };
    if (part.start !== undefined && part.end !== undefined)
      counts.codeUnits += part.end - part.start;
    else counts.images++;
    exclusive[part.occurrence] = counts;
  }
  return freeze({
    scope: "current-content" as const,
    codeUnits: compiled.parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0),
    codePoints: compiled.parts.reduce(
      (n, p) => n + (p.type === "text" ? Array.from(p.text).length : 0),
      0,
    ),
    utf8Bytes: compiled.parts.reduce(
      (n, p) => n + (p.type === "text" ? new TextEncoder().encode(p.text).length : 0),
      0,
    ),
    images: compiled.parts.filter((part) => part.type === "image").length,
    tokens: { certainty: "unknown" as const, value: null },
    exclusive,
  });
}
export interface TextEdit {
  before: { start: number; end: number };
  after: { start: number; end: number };
}
/** Bounded enclosing edit; no claim of minimum/semantic edit distance. Boundaries avoid surrogate splits. */
export function textEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const a = Array.from(before);
  const b = Array.from(after);
  let head = 0;
  let tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return {
    before: {
      start: a.slice(0, head).join("").length,
      end: a.slice(0, a.length - tail).join("").length,
    },
    after: {
      start: b.slice(0, head).join("").length,
      end: b.slice(0, b.length - tail).join("").length,
    },
  };
}
export function comparePrompts(beforeRecord: SemanticRecord, afterRecord: SemanticRecord) {
  const before = rehydrate(beforeRecord);
  const after = rehydrate(afterRecord);
  const size = Math.max(before.parts.length, after.parts.length);
  const changes = Array.from({ length: size }, (_, index) => {
    const a = before.parts[index];
    const b = after.parts[index];
    if (!a || !b) return { index, kind: a ? "removed" : "added", confidence: "positional" };
    if (a.type !== b.type) return { index, kind: "replaced", confidence: "positional" };
    if (a.type === "text" && b.type === "text")
      return {
        index,
        kind: a.text === b.text ? "same" : "changed",
        edit: textEdit(a.text, b.text),
        confidence: "positional",
      };
    if (a.type === "image" && b.type === "image") {
      const known =
        a.asset.digest && b.asset.digest
          ? a.asset.digest === b.asset.digest
          : a.asset.id === b.asset.id && a.asset.revision && b.asset.revision
            ? a.asset.revision === b.asset.revision
            : undefined;
      return {
        index,
        kind: known === undefined ? "unknown-content" : known ? "same-content" : "changed-content",
        metadataChanged: canonicalJson(a.asset) !== canonicalJson(b.asset),
        confidence: "positional",
      };
    }
    return { index, kind: "unknown", confidence: "positional" };
  });
  const keyed = (value: CompiledPrompt) =>
    new Map(value.occurrences.filter((o) => o.key !== undefined).map((o) => [o.id, o]));
  const a = keyed(before);
  const b = keyed(after);
  const matches = [...a].flatMap(([id, occurrence]) => {
    const match = b.get(id);
    return match && match.key === occurrence.key && match.kind === occurrence.kind
      ? [{ before: id, after: id, reason: "scoped-key" as const }]
      : [];
  });
  return freeze({
    before,
    after,
    changes,
    matches,
    semanticChanged: beforeRecord.fingerprint !== afterRecord.fingerprint,
    outputEqual: canonicalJson(before.parts) === canonicalJson(after.parts),
    matching: "scoped-keys; positional output comparison, no move inference",
  });
}

export interface Measurement {
  readonly value: number | null;
  readonly unit: string;
  readonly certainty: "exact" | "estimated" | "unknown";
  readonly scope: string;
  readonly method: string;
}
export interface CandidateResult {
  readonly selection: Selection;
  readonly fingerprint?: string;
  readonly measurement?: Measurement;
  readonly error?: string;
  readonly verification?: Measurement;
}
/** Bounded exhaustive reference search over explicitly declared variants; never rewrites history or text. */
export function optimizePrompt(
  input: SemanticRecord,
  options: {
    budget: number;
    unit?: string;
    scope?: string;
    maxCandidates?: number;
    choices?: Readonly<Record<string, readonly ("full" | "short" | "omit")[]>>;
    measure?: (compiled: CompiledPrompt, record: SemanticRecord) => Measurement;
  },
) {
  const record = parseRecord(input);
  if (!Number.isFinite(options.budget) || options.budget < 0)
    throw new PromptError("BUDGET", "Budget must be nonnegative and finite.");
  const limit = options.maxCandidates ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new PromptError("SEARCH_LIMIT", "Candidate limit must be a positive safe integer.");
  const unit = options.unit ?? "utf16-code-units";
  const scope = options.scope ?? "current-content";
  const compiledBase = rehydrate(record);
  const definitions = new Map(record.definitions.map((d) => [d.id, d]));
  const declared = new Map<string, readonly ("full" | "short" | "omit")[]>();
  for (const occurrence of compiledBase.occurrences) {
    const definition = definitions.get(occurrence.definition);
    if (definition?.kind !== "choice") continue;
    declared.set(
      `${occurrence.id}:${definition.name}`,
      definition.short === undefined ? ["full", "omit"] : ["full", "short", "omit"],
    );
  }
  const choices = options.choices ?? Object.fromEntries(declared);
  const entries = Object.entries(choices).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, modes] of entries) {
    const allowed =
      declared.get(key) ??
      record.definitions
        .filter((d) => d.kind === "choice" && d.name === key)
        .map((d) =>
          d.kind === "choice" && d.short !== undefined
            ? ["full", "short", "omit"]
            : ["full", "omit"],
        )
        .reduce<string[] | undefined>(
          (prior, next) => (prior ? prior.filter((mode) => next.includes(mode)) : next),
          undefined,
        );
    if (
      !allowed ||
      !modes.length ||
      new Set(modes).size !== modes.length ||
      modes.some((mode) => !allowed.includes(mode))
    )
      throw new PromptError(
        "SELECTION",
        `Search selector ${key} must name a declared choice with available variants.`,
      );
  }
  const results: CandidateResult[] = [];
  const positions = entries.map(() => 0);
  const measure =
    options.measure ??
    ((compiled: CompiledPrompt): Measurement => ({
      value: measurePrompt(compiled).codeUnits,
      unit: "utf16-code-units",
      certainty: "exact",
      scope: "current-content",
      method: "utf16/1",
    }));
  let finished = false;
  let unknown = false;
  let fit:
    | { record: SemanticRecord; compiled: CompiledPrompt; measurement: Measurement }
    | undefined;
  while (!finished && results.length < limit) {
    const selection = {
      ...record.options.selection,
      ...Object.fromEntries(entries.map(([key, modes], i) => [key, modes[positions[i]]])),
    };
    let candidate: SemanticRecord | undefined;
    let compiled: CompiledPrompt | undefined;
    try {
      candidate = withRecordOptions(record, { selection });
      compiled = rehydrate(candidate);
    } catch (error) {
      // Invalid authored combinations remain in the ledger; estimator failures are not infeasibility.
      results.push({ selection, error: error instanceof Error ? error.message : String(error) });
    }
    if (candidate && compiled) {
      const evaluate = () => {
        try {
          return copyMeasurement(measure(rehydrate(candidate), candidate), unit, scope);
        } catch (error) {
          if (error instanceof PromptError && error.diagnostic.code === "MEASUREMENT") throw error;
          throw new PromptError(
            "MEASUREMENT",
            `Estimator failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      const measurement = evaluate();
      let verification: Measurement | undefined;
      if (measurement.certainty === "unknown" || measurement.value === null) unknown = true;
      else if (measurement.value <= options.budget) {
        verification = evaluate();
        if (
          verification.value !== null &&
          verification.certainty !== "unknown" &&
          verification.value <= options.budget
        ) {
          fit = { record: candidate, compiled, measurement: verification };
        } else unknown = true;
      }
      results.push({
        selection,
        fingerprint: candidate.fingerprint,
        measurement,
        ...(verification ? { verification } : {}),
      });
      if (fit) break;
    }
    if (!entries.length) finished = true;
    else
      for (let index = positions.length - 1; index >= 0; index--) {
        positions[index]++;
        if (positions[index] < entries[index][1].length) break;
        positions[index] = 0;
        if (index === 0) finished = true;
      }
  }
  return freeze({
    status: fit
      ? ("fit" as const)
      : unknown
        ? ("unknown-cost" as const)
        : finished
          ? ("infeasible" as const)
          : ("search-exhausted" as const),
    ...(fit ? { result: fit } : {}),
    candidates: results,
    budget: options.budget,
    unit,
    measurementScope: scope,
    algorithm: "bounded-enumeration/1",
    scope: "declared-candidate-space",
  });
}
function copyMeasurement(value: Measurement, unit: string, scope: string): Measurement {
  if (
    !value ||
    value.unit !== unit ||
    !value.method ||
    value.scope !== scope ||
    !["exact", "estimated", "unknown"].includes(value.certainty) ||
    (value.value !== null && (!Number.isFinite(value.value) || value.value < 0))
  )
    throw new PromptError(
      "MEASUREMENT",
      "Estimator returned invalid or incompatible measurement metadata.",
    );
  return freeze({ ...value });
}
