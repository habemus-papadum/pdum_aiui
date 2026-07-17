/**
 * The lowering pipeline's render layer: how the folded IR ({@link ComposedItem}s)
 * becomes the prompt body an agent reads. Pass 5 of {@link composeIntent}
 * (`renderPrompt`) assembles the body from the item stream and, as it does,
 * records a {@link PromptSpan} for every non-text part — the offset-annotated
 * structure a consumer (the trace hero) uses to render the raw text with
 * hover-previews and a de-emphasized preamble instead of re-parsing it.
 *
 * Pure string logic, browser-safe (no DOM, no deps) — the same code runs in the
 * preview and in the channel's committed lowering, so both read identically.
 * Split out of engine.ts (2026-07-17) so "how does a shot render into the
 * prompt?" is a one-file question; the compiler and the state machine stay next
 * door in engine.ts, the shared shapes in types.ts.
 */
import type { ComposedIntent, ComposedItem, ComposeOptions, PromptSpan, ShotShare } from "./types";

/**
 * Pass 5 — render: fold the placed/interleaved items into the transcript and
 * the lowered prompt body, plus the {@link PromptSpan} annotations over that
 * body. The prompt text is byte-identical to the pre-spans renderer; `spans` is
 * additive metadata a consumer may ignore.
 *
 * Spans are produced HERE because this is the one place that knows every part's
 * rendered text and its offset. Offsets are derived from the assembled string
 * (a running cursor over the `join(" ")`, then shifted by the leading trim) so
 * the final `.trim()` can never desync them.
 */
export function renderPrompt(
  items: ComposedItem[],
  corrections: ComposedIntent["corrections"],
  policy: "replace" | "note",
  options: ComposeOptions,
): ComposedIntent {
  const components = items.flatMap((item) => item.components ?? []);
  const transcript = items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join(" ")
    .trim();

  const parts: string[] = [];
  const rawSpans: PromptSpan[] = [];
  let cursor = 0; // offset of the next part's start in parts.join(" ")
  /** Append a rendered part, returning the [start, end) it occupies pre-trim. */
  const append = (text: string): { start: number; end: number } => {
    if (parts.length > 0) {
      cursor += 1; // the single space the join inserts before this part
    }
    const start = cursor;
    parts.push(text);
    cursor += text.length;
    return { start, end: cursor };
  };

  for (const item of items) {
    if (item.kind === "text" && item.text) {
      append(item.text);
    } else if (item.kind === "shot" && item.marker) {
      const { start, end } = append(renderShot(item, options.cwd));
      rawSpans.push({
        kind: "shot",
        start,
        end,
        marker: item.marker,
        ...(item.path !== undefined ? { path: item.path } : {}),
        ...(item.thumb !== undefined ? { thumb: item.thumb } : {}),
        ...(item.viewport ? { viewport: true } : {}),
        ...(item.origin !== undefined ? { origin: item.origin } : {}),
        ...(item.share !== undefined ? { share: item.share } : {}),
        components: item.components ?? [],
      });
    } else if (item.kind === "code-selection") {
      const { start, end } = append(renderCodeSelection(item));
      rawSpans.push({
        kind: "code-selection",
        start,
        end,
        ...(item.marker !== undefined ? { marker: item.marker } : {}),
        ...(item.sourceLoc !== undefined ? { sourceLoc: item.sourceLoc } : {}),
        ...(item.lines !== undefined ? { lines: item.lines } : {}),
      });
    } else if (item.kind === "app-selection") {
      const { start, end } = append(renderAppSelection(item));
      rawSpans.push({
        kind: "app-selection",
        start,
        end,
        ...(item.marker !== undefined ? { marker: item.marker } : {}),
        ...(item.sourceLoc !== undefined ? { sourceLoc: item.sourceLoc } : {}),
        ...(item.cell !== undefined ? { cell: item.cell } : {}),
        ...(item.cellLoc !== undefined ? { cellLoc: item.cellLoc } : {}),
        ...(item.tex !== undefined ? { tex: item.tex } : {}),
      });
    } else if (item.kind === "navigation") {
      const { start, end } = append(renderNavigation(item));
      rawSpans.push({ kind: "navigation", start, end, from: item.from ?? "", to: item.to ?? "" });
    } else if (item.kind === "tab-switch") {
      const { start, end } = append(renderTabSwitch(item));
      rawSpans.push({ kind: "tab-switch", start, end, from: item.from ?? "", to: item.to ?? "" });
    }
  }
  if (policy === "note") {
    for (const correction of corrections) {
      // A note-policy correction is prose, not a positional item — no span.
      append(`(transcription fix: "${correction.original}" → ${correction.instruction})`);
    }
  }

  const raw = parts.join(" ");
  const leading = raw.length - raw.trimStart().length;
  const prompt = raw.trim();
  const clamp = (n: number): number => Math.max(0, Math.min(prompt.length, n - leading));
  const spans = rawSpans
    .map((span): PromptSpan => ({ ...span, start: clamp(span.start), end: clamp(span.end) }))
    .filter((span) => span.end > span.start);

  return {
    transcript,
    items,
    corrections,
    components,
    prompt,
    spans,
    meta: {},
  };
}

// ── selection rendering (the deferred decision) ──────────────────────────────

/** At or below this many characters a selection is inlined; above, fenced. */
export const SHORT_SELECTION_CHARS = 240;

/**
 * One contributed code selection, rendered at its position in the prose. The
 * short/long rule (formerly the bus host's `contributionToText`, now a compose
 * pass so the decision happens at LOWERING time): a **short** selection is
 * inlined — "Regarding `file:line`: `code`" — the location and the code right
 * in the sentence; a **long** one becomes a fenced block under its location
 * header, set apart from the prose like a multi-line screenshot block.
 *
 * Exported (P3/RT4): the channel's realtime resolver (`live-resolve.ts`)
 * re-attaches a selection the live model referenced by bare id (`code_1`)
 * with THIS exact rendering — one implementation, per the defer-rendering
 * rule. The parameter is the `ComposedItem` subset the rendering reads, so a
 * caller need not fabricate a full item.
 */
export function renderCodeSelection(
  item: Pick<ComposedItem, "text" | "sourceLoc" | "lines">,
): string {
  const text = item.text ?? "";
  const loc = item.sourceLoc !== undefined ? `\`${item.sourceLoc}\`` : "the selection";
  if (text.trim().length <= SHORT_SELECTION_CHARS) {
    return `Regarding ${loc}: \`${text.trim()}\``;
  }
  const n = item.lines ?? text.split("\n").length;
  return `\nRegarding ${loc} (${n} lines):\n\`\`\`\n${text}\n\`\`\`\n`;
}

/**
 * One on-screen (app) selection, rendered at its position in the prose — the
 * same short/long rule code selections use, worded for page text rather than
 * source: a **short** selection is inlined — `Regarding the on-screen
 * selection "…" (authored at file:line:col)` — and a **long** one becomes a
 * fenced block under the same header. The attribution parenthetical (the
 * authored-at locator, the producing cell, the TeX source of selected
 * mathematics) keeps the wording the context preamble used, now placed where
 * the selection actually sits in the stream. (The preamble path —
 * `selectionSections` in the channel's prompt-context — remains only for the
 * text modality's send-time `context` chunk.)
 *
 * Exported (P3/RT4): the channel's realtime resolver (`live-resolve.ts`)
 * re-attaches a selection the live model referenced by bare id (`sel_2`)
 * with THIS exact rendering — one implementation, per the defer-rendering
 * rule. The parameter is the `ComposedItem` subset the rendering reads.
 */
/** A URL as the short label a prompt should carry: path+query+hash (or the
 * full string when it doesn't parse — tests, exotic schemes). */
function pageLabel(url: string | undefined): string {
  if (url === undefined || url === "") {
    return "?";
  }
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || url;
  } catch {
    return url;
  }
}

/**
 * The navigation boundary, lowered: one parenthetical the model reads as "the
 * page changed here — references above are to the old page". Deliberately
 * plain; refinements belong here (the shared lowering), never in the watcher.
 */
export function renderNavigation(item: Pick<ComposedItem, "from" | "to">): string {
  return `(page navigation: now on ${pageLabel(item.to)} — content above was on ${pageLabel(item.from)})`;
}

/**
 * The tab boundary, lowered: distinct from a same-tab navigation — the user
 * turned to a different tab, so references above are to the tab they left.
 * Deliberately plain; refinements belong here (the shared lowering).
 */
export function renderTabSwitch(item: Pick<ComposedItem, "from" | "to">): string {
  return `(switched tabs: now looking at ${pageLabel(item.to)} — content above was on ${pageLabel(item.from)})`;
}

export function renderAppSelection(
  item: Pick<ComposedItem, "text" | "sourceLoc" | "cell" | "cellLoc" | "tex">,
): string {
  const attribution: string[] = [];
  if (item.sourceLoc !== undefined) {
    attribution.push(`authored at ${item.sourceLoc}`);
  }
  if (item.cell !== undefined) {
    // The definition site (the `cell(...)` call) rides along when stamped —
    // the file an agent should open for "the computation behind this".
    attribution.push(
      `produced by cell ${item.cell}${item.cellLoc !== undefined ? ` defined at ${item.cellLoc}` : ""}`,
    );
  }
  if (item.tex !== undefined) {
    attribution.push(`rendered mathematics — TeX source: ${item.tex}`);
  }
  const attr = attribution.length > 0 ? ` (${attribution.join("; ")})` : "";
  const text = (item.text ?? "").trim();
  if (text.length <= SHORT_SELECTION_CHARS) {
    return `Regarding the on-screen selection "${text}"${attr}`;
  }
  return `\nRegarding this on-screen selection${attr}:\n\`\`\`\n${text}\n\`\`\`\n`;
}

// ── shot rendering (the inline block) ────────────────────────────────────────

/** Cells listed per element before collapsing behind `cells-omitted`/"+N more". */
const MAX_CELLS_IN_PROMPT = 4;

/**
 * Elements listed per shot before collapsing behind `elements-omitted`. A huge
 * drag legitimately frames many panels (the locator reports what was framed);
 * the prompt needs reference points, not a full inventory, and document order
 * keeps the visually-first panels.
 */
const MAX_ELEMENTS_IN_PROMPT = 8;

/**
 * One shot, inlined at its position in the prose. ONE format (the old
 * xml-vs-text `shotFormat` knob is retired, 2026-07-17 render audit): a
 * plain-text bracket line names the image, and an XML block carries the
 * located-element metadata — only when any elements were located:
 *
 *   [screenshot located at .aiui-cache/traces/…/shot_1.png]
 *   <screenshot-metadata path=".aiui-cache/traces/…/shot_1.png">
 *     <element name="Legend" source="src/Legend.tsx:30:2">
 *       <cell name="colorScale" source="src/Legend.tsx:41:8"/>
 *       <cell name="ticks"/>
 *     </element>
 *   </screenshot-metadata>
 *
 * Everything is relativized against `cwd` — the image path *and* every
 * source location. The bracket line's variants:
 *
 *  - a pasted image reads `[pasted image located at …]` — mechanically a shot
 *    (marker space, disk blob, takenAt anchoring), but the model must never
 *    mistake clipboard content for what was on screen;
 *  - a missing capture keeps its marker so the reference stays resolvable:
 *    `[screenshot shot_2 located at MISSING]`;
 *  - a whole-viewport shot is suffixed `(full viewport)` and carries no
 *    element metadata by design;
 *  - a frame sampled by a video share is an ordinary screenshot — taken by
 *    the sampler instead of the S key — annotated from {@link ShotShare}: a
 *    continuous (machine-gun) frame dates itself with its offset right at the
 *    path (`… at +5.0s`); a smart-mode frame reads `(captured on change)` —
 *    it exists exactly because the user touched the app, and its position in
 *    the prose already dates it.
 */
function renderShot(item: ComposedItem, cwd: string | undefined): string {
  const label = item.origin === "paste" ? "pasted image" : "screenshot";
  const subject = item.path ? label : `${label} ${item.marker}`;
  const target = item.path ? relativizePath(item.path, cwd) : "MISSING";
  const at = item.share?.mode === "continuous" ? ` at +${formatOffset(item.share.offsetMs)}` : "";
  const notes: string[] = [];
  if (item.share !== undefined && item.share.mode !== "continuous") {
    notes.push("captured on change");
  }
  if (item.viewport) {
    notes.push("full viewport");
  }
  const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  const head = `[${subject} located at ${target}${at}${note}]`;
  const components = item.components ?? [];
  if (item.viewport || components.length === 0) {
    return head;
  }
  const attrs: string[] = [
    item.path
      ? `path="${escapeXml(relativizePath(item.path, cwd))}"`
      : `marker="${escapeXml(item.marker ?? "")}"`,
  ];
  if (components.length > MAX_ELEMENTS_IN_PROMPT) {
    attrs.push(`elements-omitted="${components.length - MAX_ELEMENTS_IN_PROMPT}"`);
  }
  const lines = components.slice(0, MAX_ELEMENTS_IN_PROMPT).map((c) => {
    const el: string[] = [`name="${escapeXml(c.component)}"`];
    if (c.source && c.source !== "unknown") {
      el.push(`source="${escapeXml(relativizePath(c.source, cwd))}"`);
    }
    if (c.containment === "within") {
      el.push(`containment="within"`);
    }
    const cells = c.cells ?? [];
    if (cells.length > MAX_CELLS_IN_PROMPT) {
      el.push(`cells-omitted="${cells.length - MAX_CELLS_IN_PROMPT}"`);
    }
    if (cells.length === 0) {
      return `  <element ${el.join(" ")}/>`;
    }
    const kids = cells.slice(0, MAX_CELLS_IN_PROMPT).map((cell) => {
      const src = cell.source ? ` source="${escapeXml(relativizePath(cell.source, cwd))}"` : "";
      return `    <cell name="${escapeXml(cell.name)}"${src}/>`;
    });
    return [`  <element ${el.join(" ")}>`, ...kids, "  </element>"].join("\n");
  });
  // A shot with metadata is a multi-line unit and gets a blank line's worth of
  // separation from the prose around it; the bare bracket line reads fine
  // inline mid-sentence and stays there.
  return `\n${[head, `<screenshot-metadata ${attrs.join(" ")}>`, ...lines, "</screenshot-metadata>"].join("\n")}\n`;
}

/** Seconds-with-one-decimal, the resolution the cadence slider works in. */
function formatOffset(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render a path relative to `cwd` when it lives under it; otherwise keep it
 * absolute (a path outside the agent's tree relativized would be a lie).
 * Works on `file:line:col` source locations too (prefix logic). Pure string
 * logic — this module stays browser-safe.
 */
function relativizePath(path: string, cwd: string | undefined): string {
  if (!cwd) {
    return path;
  }
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** Minimal XML attribute escaping (paths and names are attribute values). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
