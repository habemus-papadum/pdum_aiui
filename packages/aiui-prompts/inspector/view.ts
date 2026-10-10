import katex from "katex";
import { mappingIndex, measurePrompt } from "../src/analysis.ts";
import { canonicalJson } from "../src/json.ts";
import type { Asset, CompiledPrompt, Occurrence, SemanticRecord } from "../src/model.ts";
import { InspectorController } from "./controller.ts";
import { contributionCostLabel, occurrenceCosts } from "./costs.ts";
import {
  mathPreviewValue,
  type OutputRange,
  type PreviewDocument,
  type PreviewNode,
  parsePreview,
  safeImageUrl,
  safeLink,
} from "./preview.ts";
import {
  canonicalText,
  comparePrompts,
  descendants,
  foldedRanges,
  ownersOfRange,
  rangeFoldStatus,
  visibleFolds,
} from "./state.ts";

export interface InspectorOptions {
  /** Host-controlled access for inline images and raw-output image popups. */
  resolveAsset?: (asset: Asset) => string | undefined;
  copy?: (text: string) => void | Promise<void>;
  onSource?: (origin: NonNullable<Occurrence["origin"]>) => void;
}

export interface MountedInspector {
  controller: InspectorController;
  load: (record: unknown) => boolean;
  dispose: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, label: string, action: () => void, key?: string): HTMLButtonElement {
  const node = element(doc, "button", "prompt-button", label);
  node.type = "button";
  node.addEventListener("click", action);
  if (key) node.dataset.actionKey = key;
  return node;
}

function jsonDetails(
  doc: Document,
  title: string,
  value: unknown,
  open = false,
): HTMLDetailsElement {
  const details = element(doc, "details", "prompt-json");
  details.open = open;
  details.append(element(doc, "summary", undefined, title));
  details.append(element(doc, "pre", undefined, JSON.stringify(value, null, 2)));
  return details;
}

function sourceOrigin(record: SemanticRecord, occurrence: Occurrence) {
  return (
    occurrence.origin ??
    record.definitions.find((item) => item.id === occurrence.definition)?.origin
  );
}

type AssetPreview = { url: string } | { error: string };

function resolvePreview(asset: Asset, options: InspectorOptions): AssetPreview {
  try {
    const url = safeImageUrl(options.resolveAsset ? options.resolveAsset(asset) : asset.uri);
    return url ? { url } : { error: "No preview URL is available for this asset." };
  } catch (error) {
    return { error: `Asset resolver failed: ${String(error)}` };
  }
}

function assetPreviewElement(
  doc: Document,
  asset: Asset,
  preview: AssetPreview,
  active: () => boolean,
  loading: "lazy" | "eager",
): HTMLElement {
  if ("error" in preview) return element(doc, "span", "prompt-note", preview.error);
  const image = element(doc, "img");
  image.alt = asset.alt ?? asset.id;
  image.loading = loading;
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  if (asset.width !== undefined) image.width = asset.width;
  if (asset.height !== undefined) image.height = asset.height;
  image.addEventListener("error", () => {
    if (active() && image.isConnected) {
      image.replaceWith(element(doc, "span", "prompt-note", "Image could not be loaded."));
    }
  });
  image.src = preview.url;
  return image;
}

function imagePopup(root: HTMLElement, options: InspectorOptions) {
  const doc = root.ownerDocument;
  const popup = element(doc, "aside", "prompt-image-popup");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Image preview");
  popup.hidden = true;
  root.append(popup);
  let pinned = false;
  let opener: HTMLButtonElement | null = null;
  let current: string | null = null;
  let disposed = false;

  function close(restoreFocus = false) {
    popup.hidden = true;
    popup.replaceChildren();
    pinned = false;
    current = null;
    if (restoreFocus && opener?.isConnected) opener.focus();
    opener = null;
  }

  function show(asset: Asset, trigger: HTMLButtonElement, pin: boolean) {
    if (disposed || (pinned && !pin)) return;
    if (pin && pinned && current === asset.id) {
      close(true);
      return;
    }
    pinned = pin;
    opener = trigger;
    current = asset.id;
    popup.hidden = false;
    popup.replaceChildren();
    popup.append(element(doc, "strong", undefined, asset.alt ?? asset.id));
    popup.append(
      element(doc, "p", "prompt-note", pin ? "Pinned preview" : "Click image to pin preview"),
    );
    popup.append(
      assetPreviewElement(doc, asset, resolvePreview(asset, options), () => !disposed, "eager"),
    );
    popup.append(element(doc, "code", undefined, asset.uri ?? asset.id));
    popup.append(button(doc, "Close image preview", () => close(true)));
  }

  const onEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !popup.hidden) {
      event.preventDefault();
      close(true);
    }
  };
  doc.addEventListener("keydown", onEscape);

  return {
    button(asset: Asset) {
      const trigger = button(doc, `Image: ${asset.alt ?? asset.id}`, () =>
        show(asset, trigger, true),
      );
      trigger.classList.add("prompt-image");
      trigger.dataset.asset = asset.id;
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.addEventListener("pointerenter", () => show(asset, trigger, false));
      trigger.addEventListener("pointerleave", () => {
        if (!pinned) close();
      });
      return trigger;
    },
    close,
    dispose() {
      disposed = true;
      doc.removeEventListener("keydown", onEscape);
      popup.remove();
    },
  };
}

/**
 * Mount an owned, framework-independent view over a persisted semantic record.
 * This view does not execute an author function, send provider data, or mutate records.
 */
export function mountInspector(
  container: HTMLElement,
  input: unknown,
  options: InspectorOptions = {},
): MountedInspector {
  const doc = container.ownerDocument;
  const root = element(doc, "div", "prompt-inspector");
  const content = element(doc, "div", "prompt-inspector-content");
  const notice = element(doc, "p", "prompt-note");
  notice.setAttribute("role", "status");
  root.append(content, notice);
  container.append(root);
  const popup = imagePopup(root, options);
  const controller = new InspectorController(input);
  let disposed = false;
  let parsedFor: CompiledPrompt | null = null;
  let previews = new Map<string, PreviewDocument>();
  const inlineAssets = new Map<string, AssetPreview>();
  let detailOwners: readonly string[] = [];
  const expandedJson = new Set<string>();

  async function copy(text: string) {
    if (disposed) return;
    try {
      if (options.copy) await options.copy(text);
      else {
        const clipboard = doc.defaultView?.navigator.clipboard;
        if (!clipboard)
          throw new Error("Clipboard access is unavailable; expand JSON and select it.");
        await clipboard.writeText(text);
      }
      if (!disposed) notice.textContent = "Copied canonical content. View folds were not included.";
    } catch (error) {
      if (!disposed) notice.textContent = `Copy failed: ${String(error)}`;
    }
  }

  function selectRange(range: OutputRange) {
    detailOwners = controller.compiled ? ownersOfRange(controller.compiled, range) : [];
    controller.selectRange(range);
  }

  function render() {
    if (disposed) return;
    const focused = (doc.activeElement as HTMLElement | null)?.dataset?.actionKey;
    content.querySelectorAll<HTMLDetailsElement>("details.prompt-json").forEach((node) => {
      const key = node.querySelector("summary")?.textContent ?? "";
      if (node.open) expandedJson.add(key);
      else expandedJson.delete(key);
    });
    content.replaceChildren();
    const { record, compiled, error, state } = controller;
    if (error || !record || !compiled) {
      popup.close();
      const fault = element(
        doc,
        "div",
        "prompt-error",
        `${error ?? "No record loaded."}${record && compiled ? " Showing the last validated record; the attempted import was not loaded." : ""}`,
      );
      fault.setAttribute("role", "alert");
      content.append(fault);
      if (!record || !compiled) return;
    }
    if (compiled !== parsedFor) {
      popup.close();
      inlineAssets.clear();
      try {
        previews = new Map(
          compiled.parts.flatMap((part) =>
            part.type === "text" ? [[part.id, parsePreview(part.id, part.text)] as const] : [],
          ),
        );
        parsedFor = compiled;
      } catch (parseError) {
        const fault = element(
          doc,
          "div",
          "prompt-error",
          `Preview parser failed: ${String(parseError)}`,
        );
        fault.setAttribute("role", "alert");
        content.append(fault);
        return;
      }
    }
    const folds = foldedRanges(compiled, state);
    const measurement = measurePrompt(compiled);
    const costs = occurrenceCosts(compiled, measurement);
    const mapping = mappingIndex(compiled);
    const selectedFamily = state.selected
      ? descendants(compiled, state.selected)
      : new Set<string>();
    const byId = new Map(compiled.occurrences.map((item) => [item.id, item]));
    const childrenByParent = new Map<string | undefined, Occurrence[]>();
    for (const occurrence of compiled.occurrences) {
      const siblings = childrenByParent.get(occurrence.parent) ?? [];
      siblings.push(occurrence);
      childrenByParent.set(occurrence.parent, siblings);
    }
    const foldedByOwner = new Map<string, string>();
    for (const fold of visibleFolds(compiled, state)) {
      for (const id of descendants(compiled, fold)) foldedByOwner.set(id, fold);
    }
    const foldedOwner = (id: string) => foldedByOwner.get(id);
    const label = (id: string) => byId.get(id)?.label ?? byId.get(id)?.kind ?? id;

    const toolbar = element(doc, "div", "prompt-toolbar");
    toolbar.append(
      button(doc, "Recompile stored record", () => controller.recompile(), "recompile"),
    );
    toolbar.append(
      button(doc, "Copy semantic record", () => void copy(JSON.stringify(record)), "copy-record"),
    );
    toolbar.append(
      button(
        doc,
        "Copy canonical parts",
        () => void copy(JSON.stringify(compiled.parts)),
        "copy-parts",
      ),
    );
    const text = canonicalText(compiled);
    if (text !== null)
      toolbar.append(button(doc, "Copy canonical text", () => void copy(text), "copy-text"));
    toolbar.append(button(doc, "Unfold all content", () => controller.unfoldAll(), "unfold-all"));
    content.append(toolbar);
    content.append(
      element(
        doc,
        "p",
        "prompt-record-meta",
        `Schema ${record.schemaVersion} · compiler ${record.compiler.version} · ${new TextEncoder().encode(JSON.stringify(record)).length} record bytes · ${measurement.codeUnits} output code units · ${measurement.images} images · tokens unknown`,
      ),
      element(doc, "code", "prompt-fingerprint", record.fingerprint),
    );
    const panels = element(doc, "div", "prompt-panels");
    const tree = element(doc, "section", "prompt-tree");
    tree.setAttribute("aria-label", "Occurrence tree");
    tree.append(element(doc, "h3", undefined, "Composition"));
    tree.append(
      element(
        doc,
        "p",
        "prompt-note prompt-cost-legend",
        "Subtree costs: cu = UTF-16 code units; img = image placements. Parent and child totals overlap. These are not tokens.",
      ),
    );

    function treeItem(item: Occurrence): HTMLElement {
      const wrapper = element(doc, "div", "prompt-tree-item");
      wrapper.dataset.occurrence = item.id;
      const row = element(doc, "div", "prompt-tree-row");
      row.dataset.selected = String(item.id === state.selected);
      const children = childrenByParent.get(item.id) ?? [];
      if (children.length) {
        const outline = button(
          doc,
          state.outlineCollapsed.has(item.id) ? "+" : "−",
          () => controller.toggleOutline(item.id),
          `outline:${item.id}`,
        );
        outline.setAttribute("aria-label", `Toggle outline: ${label(item.id)}`);
        outline.setAttribute("aria-expanded", String(!state.outlineCollapsed.has(item.id)));
        row.append(outline);
      }
      const select = button(
        doc,
        label(item.id),
        () => {
          detailOwners = [];
          controller.select(item.id);
        },
        `select:${item.id}`,
      );
      select.title = `${item.kind} · ${item.id} · definition ${item.definition}`;
      row.append(select);
      const cost = costs.get(item.id);
      if (cost) {
        const badge = element(
          doc,
          "span",
          "prompt-tree-cost",
          `${cost.subtree.codeUnits} cu · ${cost.subtree.images} img`,
        );
        badge.dataset.costOccurrence = item.id;
        badge.dataset.codeUnits = String(cost.subtree.codeUnits);
        badge.dataset.images = String(cost.subtree.images);
        badge.title = `Subtree (inclusive): ${contributionCostLabel(cost.subtree)}. Own (exclusive): ${contributionCostLabel(cost.own)}. Generated text is counted with its recorded owner.`;
        badge.setAttribute(
          "aria-label",
          `${label(item.id)} subtree: ${contributionCostLabel(cost.subtree)}`,
        );
        row.append(badge);
      }
      const fold = button(
        doc,
        state.contentFolded.has(item.id) ? "Show" : "Fold",
        () => controller.toggleFold(item.id),
        `fold:${item.id}`,
      );
      fold.setAttribute("aria-label", `Fold content: ${label(item.id)}`);
      fold.setAttribute("aria-pressed", String(state.contentFolded.has(item.id)));
      row.append(fold);
      wrapper.append(row);
      if (!state.outlineCollapsed.has(item.id)) {
        const branch = element(doc, "div", "prompt-tree-children");
        for (const child of children) branch.append(treeItem(child));
        wrapper.append(branch);
      }
      return wrapper;
    }
    for (const item of childrenByParent.get(undefined) ?? []) tree.append(treeItem(item));
    panels.append(tree);

    const raw = element(doc, "section", "prompt-raw");
    raw.setAttribute("aria-label", "Canonical raw output");
    raw.append(element(doc, "h3", undefined, "Raw output"));
    const preview = element(doc, "section", "prompt-preview");
    preview.setAttribute("aria-label", "Markdown and math preview");
    preview.append(element(doc, "h3", undefined, "Markdown + math"));
    preview.append(
      element(
        doc,
        "p",
        "prompt-note",
        "Navigation: original block / whole equation. No glyph-level map.",
      ),
    );

    function bindRange(node: HTMLElement, range: OutputRange, precision: string) {
      node.dataset.part = range.part;
      node.dataset.start = String(range.start);
      node.dataset.end = String(range.end);
      node.dataset.precision = precision;
      node.dataset.selected = String(
        mapping
          .explain(range.part, range.start, range.end)
          .some((entry) => selectedFamily.has(entry.contribution.occurrence)),
      );
      node.tabIndex = 0;
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        selectRange(range);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          selectRange(range);
        }
      });
    }

    function renderMarkdown(node: PreviewNode, document: PreviewDocument, top = false): Node {
      if (node.type === "definition") return doc.createTextNode("");
      if (node.type === "text") return doc.createTextNode(node.value ?? "");
      let result: HTMLElement;
      if (node.type === "html") {
        result = element(doc, "code", "prompt-html-literal", node.value ?? "");
      } else if (node.type === "math" || node.type === "inlineMath") {
        result = element(doc, node.type === "math" ? "div" : "span", "prompt-equation");
        const display = mathPreviewValue(node, compiled?.semanticRegions ?? []);
        result.dataset.mathEncoding = display.encoding;
        katex.render(display.value, result, {
          displayMode: node.type === "math",
          throwOnError: false,
          trust: false,
          strict: "ignore",
          maxExpand: 1000,
          maxSize: 20,
          output: "htmlAndMathml",
        });
        result.title = display.value;
        if (node.range) bindRange(result, node.range, "whole-equation");
      } else if (node.type === "code") {
        result = element(doc, "pre");
        result.append(element(doc, "code", undefined, node.value ?? ""));
      } else if (node.type === "inlineCode") {
        result = element(doc, "code", undefined, node.value ?? "");
      } else if (node.type === "image" || node.type === "imageReference") {
        // A Markdown image URL is authored text, not a declared multimodal asset.
        result = element(
          doc,
          "span",
          "prompt-note",
          `[Markdown image: ${node.alt ?? node.identifier ?? "image"}]`,
        );
      } else if (node.type === "link" || node.type === "linkReference") {
        const url = safeLink(node.url ?? document.definitions.get(node.identifier ?? ""));
        result = element(doc, url ? "a" : "span");
        if (url) {
          (result as HTMLAnchorElement).href = url;
          (result as HTMLAnchorElement).target = "_blank";
          (result as HTMLAnchorElement).rel = "noopener noreferrer";
          result.addEventListener("click", (event) => event.stopPropagation());
        }
        for (const child of node.children) result.append(renderMarkdown(child, document));
      } else {
        const tags: Record<string, keyof HTMLElementTagNameMap> = {
          paragraph: "p",
          emphasis: "em",
          strong: "strong",
          delete: "del",
          blockquote: "blockquote",
          listItem: "li",
          table: "table",
          tableRow: "tr",
          tableCell: "td",
          break: "br",
          thematicBreak: "hr",
        };
        const heading =
          `h${Math.min(6, Math.max(1, node.depth ?? 1))}` as keyof HTMLElementTagNameMap;
        result = element(
          doc,
          node.type === "heading"
            ? heading
            : node.type === "list"
              ? node.ordered
                ? "ol"
                : "ul"
              : (tags[node.type] ?? "div"),
        );
        if (node.type === "list" && node.ordered && node.start !== undefined)
          (result as HTMLOListElement).start = node.start;
        if (node.checked !== undefined && node.checked !== null) {
          result.append(doc.createTextNode(node.checked ? "☑ " : "☐ "));
        }
        for (const child of node.children) result.append(renderMarkdown(child, document));
      }
      if (top && node.range) {
        const status = rangeFoldStatus(node.range, folds);
        if (status === "full") {
          const placeholder = element(
            doc,
            "div",
            "prompt-fold-placeholder",
            "[Folded preview block]",
          );
          bindRange(placeholder, node.range, "block");
          return placeholder;
        }
        const wrapper = element(doc, "div", "prompt-preview-block");
        bindRange(wrapper, node.range, node.type === "math" ? "whole-equation" : "block");
        wrapper.append(result);
        if (status === "partial") {
          wrapper.dataset.partialFold = "true";
          wrapper.append(
            element(
              doc,
              "small",
              "prompt-partial-fold",
              "Partly folded in raw output; complete block retained for valid Markdown/math.",
            ),
          );
        }
        return wrapper;
      }
      return result;
    }

    for (const part of compiled.parts) {
      if (part.type === "image") {
        const contribution = compiled.contributions.find((entry) => entry.part === part.id);
        const folded = contribution && foldedOwner(contribution.occurrence);
        if (folded) {
          raw.append(
            button(doc, `[Folded image: ${label(folded)}]`, () => controller.toggleFold(folded)),
          );
          preview.append(
            button(doc, `[Folded image: ${label(folded)}]`, () => controller.toggleFold(folded)),
          );
        } else {
          raw.append(popup.button(part.asset));
          const figure = element(doc, "figure", "prompt-inline-image");
          const frame = button(
            doc,
            "",
            () => {
              detailOwners = [];
              controller.select(contribution?.occurrence ?? null);
            },
            `image:${part.id}`,
          );
          frame.className = "prompt-inline-image-frame";
          frame.setAttribute("aria-label", `Select image: ${part.asset.alt ?? part.asset.id}`);
          frame.dataset.asset = part.asset.id;
          frame.dataset.part = part.id;
          frame.dataset.precision = "atomic-asset";
          frame.dataset.selected = String(
            contribution && selectedFamily.has(contribution.occurrence),
          );
          let resolved = inlineAssets.get(part.id);
          if (!resolved) {
            resolved = resolvePreview(part.asset, options);
            inlineAssets.set(part.id, resolved);
          }
          frame.append(assetPreviewElement(doc, part.asset, resolved, () => !disposed, "lazy"));
          figure.append(
            frame,
            element(
              doc,
              "figcaption",
              "prompt-inline-image-caption",
              part.asset.alt ?? part.asset.id,
            ),
          );
          preview.append(figure);
        }
        continue;
      }
      const pre = element(doc, "pre");
      pre.dataset.rawPart = part.id;
      const entries = compiled.contributions.filter((entry) => entry.part === part.id);
      let lastFold: string | undefined;
      for (const entry of entries) {
        if (entry.start === undefined || entry.end === undefined) continue;
        const fold = foldedOwner(entry.occurrence);
        if (fold) {
          if (fold !== lastFold)
            pre.append(button(doc, `[Folded: ${label(fold)}]`, () => controller.toggleFold(fold)));
          lastFold = fold;
          continue;
        }
        lastFold = undefined;
        const span = element(
          doc,
          "span",
          "prompt-raw-span",
          part.text.slice(entry.start, entry.end),
        );
        span.dataset.owner = entry.occurrence;
        span.dataset.relation = entry.relation;
        bindRange(span, { part: part.id, start: entry.start, end: entry.end }, "output-range");
        pre.append(span);
      }
      raw.append(pre);
      const parsed = previews.get(part.id);
      if (parsed)
        for (const node of parsed.nodes) preview.append(renderMarkdown(node, parsed, true));
    }
    panels.append(raw, preview);
    content.append(panels);

    const provenance = element(doc, "section", "prompt-provenance");
    provenance.setAttribute("aria-label", "Selected provenance");
    provenance.append(element(doc, "h3", undefined, "Provenance and decisions"));
    if (detailOwners.length > 1) {
      provenance.append(
        element(doc, "p", "prompt-note", "This preview range has multiple contributing owners:"),
      );
      for (const owner of detailOwners)
        provenance.append(button(doc, label(owner), () => controller.select(owner)));
    }
    const selected = state.selected ? byId.get(state.selected) : undefined;
    if (selected) {
      provenance.append(
        element(
          doc,
          "p",
          undefined,
          `${label(selected.id)} · occurrence ${selected.id} · definition ${selected.definition}`,
        ),
      );
      const origin = sourceOrigin(record, selected);
      const shownOrigins = new Set<string>();
      function appendOrigin(
        value: NonNullable<Occurrence["origin"]>,
        title: string,
        actionLabel: string,
      ) {
        const fingerprint = canonicalJson(value);
        if (shownOrigins.has(fingerprint)) return false;
        shownOrigins.add(fingerprint);
        provenance.append(jsonDetails(doc, title, value, true));
        if (options.onSource)
          provenance.append(
            button(doc, actionLabel, () => {
              if (disposed) return;
              try {
                options.onSource?.(value);
              } catch (error) {
                notice.textContent = `Source navigation failed: ${String(error)}`;
              }
            }),
          );
        return true;
      }
      if (origin) appendOrigin(origin, "Recorded source / data origin", "Open recorded source");
      if (selected.definitionOrigin)
        appendOrigin(
          selected.definitionOrigin,
          "Recorded definition origin",
          "Open definition source",
        );
      let lineageIndex = 1;
      for (const lineageOrigin of selected.origins ?? []) {
        if (
          appendOrigin(
            lineageOrigin,
            `Recorded lineage origin ${lineageIndex}`,
            `Open lineage source ${lineageIndex}`,
          )
        )
          lineageIndex++;
      }
      let contributionIndex = 1;
      for (const contribution of compiled.contributions) {
        if (!selectedFamily.has(contribution.occurrence) || !contribution.origin) continue;
        if (
          appendOrigin(
            contribution.origin,
            `Recorded contribution origin ${contributionIndex}`,
            `Open contribution source ${contributionIndex}`,
          )
        )
          contributionIndex++;
      }
      if (!shownOrigins.size) {
        provenance.append(
          element(doc, "p", "prompt-note", "No source origin was recorded for this owner."),
        );
      }
      provenance.append(
        element(
          doc,
          "p",
          "prompt-note",
          `Own contribution (exclusive): ${contributionCostLabel(costs.get(selected.id)?.own ?? { codeUnits: 0, images: 0 })}. Subtree (inclusive): ${contributionCostLabel(costs.get(selected.id)?.subtree ?? { codeUnits: 0, images: 0 })}. Counts describe emitted content, including generated syntax; folding does not change them.`,
        ),
        jsonDetails(
          doc,
          "Selected contributions",
          compiled.contributions.filter((entry) => selectedFamily.has(entry.occurrence)),
        ),
      );
    } else {
      provenance.append(
        element(
          doc,
          "p",
          "prompt-note",
          "Select an occurrence, raw span, or preview block to inspect its owners.",
        ),
      );
    }
    provenance.append(jsonDetails(doc, "Captured context", record.context));
    provenance.append(jsonDetails(doc, "Recorded decisions", compiled.decisions, true));
    content.append(provenance);
    content.append(jsonDetails(doc, "Stored semantic record", record));
    content.append(jsonDetails(doc, "Derived compilation", compiled));
    content.querySelectorAll<HTMLDetailsElement>("details.prompt-json").forEach((node) => {
      if (expandedJson.has(node.querySelector("summary")?.textContent ?? "")) node.open = true;
    });
    if (focused) {
      const target = [...content.querySelectorAll<HTMLElement>("[data-action-key]")].find(
        (node) => node.dataset.actionKey === focused,
      );
      target?.focus({ preventScroll: true });
    }
  }

  const unsubscribe = controller.subscribe(render);
  render();
  return {
    controller,
    load(record) {
      popup.close();
      detailOwners = [];
      notice.textContent = "";
      return controller.load(record);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      controller.dispose();
      popup.dispose();
      inlineAssets.clear();
      root.remove();
    },
  };
}

/** Independent valid previews; no invented cross-revision occurrence correspondence. */
export function mountComparison(
  container: HTMLElement,
  before: unknown,
  after: unknown,
  options: InspectorOptions = {},
): { before: MountedInspector; after: MountedInspector; dispose: () => void } {
  const doc = container.ownerDocument;
  const root = element(doc, "div", "prompt-comparison");
  const summary = element(doc, "p", "prompt-comparison-summary");
  const left = element(doc, "section");
  left.setAttribute("aria-label", "Before revision");
  const right = element(doc, "section");
  right.setAttribute("aria-label", "After revision");
  left.append(element(doc, "h2", undefined, "Before"));
  right.append(element(doc, "h2", undefined, "After"));
  root.append(summary, left, right);
  container.append(root);
  const mountedBefore = mountInspector(left, before, options);
  const mountedAfter = mountInspector(right, after, options);
  const update = () => {
    const a = mountedBefore.controller.compiled;
    const b = mountedAfter.controller.compiled;
    if (!a || !b) {
      summary.textContent = "Comparison unavailable until both records validate.";
      return;
    }
    const result = comparePrompts(a, b);
    summary.textContent = `${result.sameRecord ? "Same" : "Different"} semantic records; ${result.sameOutput ? "identical" : "different"} output. Text: ${result.beforeCodeUnits} → ${result.afterCodeUnits} UTF-16 code units. ${result.decisionsChanged ? "Recorded decisions changed." : "Recorded decisions unchanged."} Independent folds; no inferred move matching.`;
  };
  const unsubscribers = [
    mountedBefore.controller.subscribe(update),
    mountedAfter.controller.subscribe(update),
  ];
  update();
  return {
    before: mountedBefore,
    after: mountedAfter,
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      mountedBefore.dispose();
      mountedAfter.dispose();
      root.remove();
    },
  };
}
