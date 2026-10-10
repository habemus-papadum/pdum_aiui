import { button, element } from "./dom";
import type { ImagePopup } from "./image-popup";
import { type Artifact, ancestors, type ImagePart, measure, type Occurrence } from "./model";
import { previewUnits } from "./preview";
import {
  type Action,
  changeKind,
  coverage,
  hidden,
  type InspectorState,
  key,
  type Side,
  selected,
} from "./state";

export interface ViewContext {
  state: InspectorState;
  side: Side;
  dispatch: (action: Action) => void;
  select: (side: Side, owners: string[], from: "tree" | "raw" | "preview" | "source") => void;
  popup: ImagePopup;
}

function bind(node: HTMLElement, ctx: ViewContext, owners: string[]) {
  node.dataset.side = ctx.side;
  node.dataset.owners = owners.join(" ");
  if (owners.some((owner) => selected(ctx.state, ctx.side, owner))) node.classList.add("selected");
}

function foldButton(ctx: ViewContext, owner: string) {
  const folded = ctx.state.folded.has(key(ctx.side, owner));
  const node = button(
    folded ? "Show" : "Fold",
    () => ctx.dispatch({ type: "fold", side: ctx.side, owner }),
    "fold-control",
    `${folded ? "Show" : "Fold"} content for ${owner}`,
  );
  node.dataset.control = `fold:${ctx.side}:${owner}`;
  node.setAttribute("aria-pressed", String(folded));
  return node;
}

function pane(title: string, id: string) {
  const node = element("section", "pane");
  node.append(element("h3", "pane-heading", title));
  const content = element("div", "pane-content");
  content.dataset.scroll = id;
  node.append(content);
  return { node, content };
}

function tree(ctx: ViewContext, artifact: Artifact) {
  const { node, content } = pane("Composition", `${ctx.side}-tree`);
  content.append(
    element("p", "pane-hint", "Chevron hides tree rows. Fold hides content in both views."),
  );
  function visit(occurrence: Occurrence, depth: number) {
    const children = artifact.occurrences.filter((item) => item.parent === occurrence.id);
    const closed = ctx.state.outline.has(key(ctx.side, occurrence.id));
    const row = element(
      "div",
      `tree-row ${hidden(ctx.state, ctx.side, occurrence.id) ? "is-folded" : ""}`,
    );
    row.style.paddingLeft = `${depth * 13}px`;
    bind(row, ctx, [occurrence.id]);
    if (children.length) {
      const disclose = button(
        closed ? "▸" : "▾",
        () => ctx.dispatch({ type: "outline", side: ctx.side, owner: occurrence.id }),
        "disclose",
        `Toggle outline for ${occurrence.label}`,
      );
      disclose.setAttribute("aria-expanded", String(!closed));
      disclose.dataset.control = `outline:${ctx.side}:${occurrence.id}`;
      row.append(disclose);
    } else row.append(element("span", "disclose", "·"));
    const label = button(
      occurrence.label,
      () => ctx.select(ctx.side, [occurrence.id], "tree"),
      "tree-label",
    );
    label.title = `Occurrence ${occurrence.id}; definition ${occurrence.definition}`;
    label.dataset.control = `select:${ctx.side}:tree:${occurrence.id}`;
    row.append(label, foldButton(ctx, occurrence.id));
    if (ctx.state.compare) {
      const change = changeKind(ctx.state.fixture, ctx.side, occurrence.id);
      if (change !== "same") row.append(element("span", `change ${change}`, change));
    }
    content.append(row);
    if (!closed) for (const child of children) visit(child, depth + 1);
  }
  for (const root of artifact.occurrences.filter((o) => !o.parent)) visit(root, 0);
  return node;
}

function imageControl(ctx: ViewContext, part: ImagePart, mode: "raw" | "preview") {
  const wrapper = element("div", `asset ${mode}`);
  bind(wrapper, ctx, [part.owner]);
  const open = button(
    mode === "raw" ? `[image part] ${part.asset.alt}` : "Inspect image",
    () => {
      ctx.popup.open(part, open, true);
    },
    "asset-open",
  );
  open.dataset.control = `image:${ctx.side}:${mode}:${part.id}`;
  open.title = "Hover to preview; click, Enter or Space to pin";
  open.addEventListener("pointerenter", () => ctx.popup.open(part, open, false));
  open.addEventListener("pointerleave", () => ctx.popup.scheduleClose());
  if (mode === "preview") {
    const img = element("img");
    img.src = part.asset.uri;
    img.alt = part.asset.alt;
    img.width = part.asset.width;
    img.height = part.asset.height;
    open.prepend(img);
  }
  wrapper.append(
    open,
    button("Locate source", () => ctx.select(ctx.side, [part.owner], mode), "small"),
    foldButton(ctx, part.owner),
  );
  wrapper.append(
    element(
      "p",
      "muted",
      `${part.asset.width} × ${part.asset.height} · ${part.asset.revision} · atomic asset, not payload text`,
    ),
  );
  return wrapper;
}

function foldedMarker(ctx: ViewContext, owners: string[], label: string) {
  const node = button(
    `⋯ ${label} · reveal`,
    () => ctx.dispatch({ type: "reveal", side: ctx.side, owners }),
    "fold-marker",
  );
  bind(node, ctx, owners);
  node.dataset.control = `reveal:${ctx.side}:${owners.join("+")}`;
  return node;
}

function raw(ctx: ViewContext, artifact: Artifact) {
  const { node, content } = pane("Exact emitted content", `${ctx.side}-raw`);
  content.append(
    element(
      "p",
      "pane-hint",
      "Select a range to locate its source. Fold selected via the toolbar. Asset chips are outside text.",
    ),
  );
  for (const part of artifact.parts) {
    const section = element("section", "raw-part");
    section.append(element("div", "part-label", `${part.kind} part · ${part.id}`));
    if (part.kind === "image") {
      section.append(
        hidden(ctx.state, ctx.side, part.owner)
          ? foldedMarker(ctx, [part.owner], "image folded")
          : imageControl(ctx, part, "raw"),
      );
    } else {
      const pre = element("pre", "raw-text");
      for (const contribution of part.contributions) {
        const text = part.text.slice(contribution.start, contribution.end);
        // Native buttons establish special inline formatting contexts: multiline fragments
        // end up visually interleaved. True inline spans preserve canonical text flow.
        const range = hidden(ctx.state, ctx.side, contribution.owner)
          ? foldedMarker(ctx, [contribution.owner], `${text.length} code units folded`)
          : element("span", "raw-range", text);
        if (!hidden(ctx.state, ctx.side, contribution.owner)) {
          range.tabIndex = 0;
          range.setAttribute("role", "button");
          range.title = `${contribution.owner}: [${contribution.start}, ${contribution.end}) UTF-16`;
          range.addEventListener("click", () => ctx.select(ctx.side, [contribution.owner], "raw"));
          range.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            ctx.select(ctx.side, [contribution.owner], "raw");
          });
        }
        bind(range, ctx, [contribution.owner]);
        range.dataset.control = `select:${ctx.side}:raw:${part.id}:${contribution.start}`;
        range.dataset.anchor = `${part.id}:${contribution.start}`;
        pre.append(range);
      }
      section.append(pre);
    }
    content.append(section);
  }
  return node;
}

function preview(ctx: ViewContext, artifact: Artifact) {
  const { node, content } = pane("Markdown / LaTeX preview", `${ctx.side}-preview`);
  content.append(
    element(
      "p",
      "pane-hint",
      "Whole-block mappings. Equations remain intact; contributor controls explain partial folds.",
    ),
  );
  for (const part of artifact.parts) {
    if (part.kind === "image") {
      content.append(
        hidden(ctx.state, ctx.side, part.owner)
          ? foldedMarker(ctx, [part.owner], "image folded")
          : imageControl(ctx, part, "preview"),
      );
      continue;
    }
    for (const unit of previewUnits(part)) {
      if (unit.kind === "space") continue;
      const cover = coverage(ctx.state, ctx.side, unit.owners);
      const wrapper = element("article", `preview-unit ${cover === "partial" ? "partial" : ""}`);
      wrapper.dataset.anchor = `${part.id}:${unit.start}`;
      bind(wrapper, ctx, unit.owners);
      if (cover === "full") {
        wrapper.append(
          foldedMarker(
            ctx,
            unit.owners,
            `${unit.kind === "displayMath" ? "equation" : unit.kind} folded`,
          ),
        );
      } else {
        const rendered = element("div", "rendered");
        // Static, repository-authored fixtures only. No runtime user HTML is accepted.
        rendered.innerHTML = unit.html;
        rendered.addEventListener("click", () => ctx.select(ctx.side, unit.owners, "preview"));
        wrapper.append(rendered);
        const controls = element("div", "unit-controls");
        controls.append(
          button(
            unit.kind === "displayMath" ? "Locate equation" : "Locate block",
            () => ctx.select(ctx.side, unit.owners, "preview"),
            "small",
          ),
        );
        for (const owner of unit.owners) {
          const choice = button(
            owner,
            () => ctx.select(ctx.side, [owner], "preview"),
            "owner-chip",
          );
          if (hidden(ctx.state, ctx.side, owner)) choice.classList.add("is-folded");
          controls.append(choice, foldButton(ctx, owner));
        }
        wrapper.append(controls);
        if (cover === "partial")
          wrapper.prepend(
            element(
              "p",
              "partial-notice",
              "Partial fold · raw ranges are hidden; this indivisible preview stays complete.",
            ),
          );
      }
      content.append(wrapper);
    }
  }
  return node;
}

export function inspector(ctx: ViewContext): HTMLElement {
  const artifact = ctx.state.fixture[ctx.side];
  const section = element("section", "inspector");
  section.dataset.inspector = ctx.side;
  const heading = element("div", "artifact-heading");
  heading.append(
    element(
      "h2",
      "",
      `${ctx.state.compare ? `${ctx.side === "before" ? "Before" : "After"} · ` : ""}Revision ${artifact.revision}`,
    ),
  );
  const count = measure(artifact, (owner) => hidden(ctx.state, ctx.side, owner));
  heading.append(
    element(
      "p",
      "muted",
      `${count.totalText.toLocaleString()} UTF-16 code units · ${count.totalImages} images · ${count.hiddenText} code units / ${count.hiddenImages} images folded for display · payload unchanged`,
    ),
  );
  section.append(heading);
  const columns = element("div", "inspector-columns");
  columns.append(tree(ctx, artifact), raw(ctx, artifact), preview(ctx, artifact));
  section.append(columns);
  return section;
}

export function sourceView(ctx: ViewContext): HTMLElement {
  const { state } = ctx;
  const selectedSide = state.selection?.side ?? ctx.side;
  const artifact = state.fixture[selectedSide];
  const owners = state.selection?.owners ?? [];
  const selectedOccurrences = artifact.occurrences.filter((o) => owners.includes(o.id));
  const node = element("section", "source-section");
  node.append(element("h3", "", `Fixture source · ${selectedSide} · example.prompt.tsx`));
  node.append(
    element(
      "p",
      "muted",
      "Hand-authored source locations, not compiler-captured. Line-level navigation; whole-equation/block preview precision.",
    ),
  );
  if (selectedOccurrences.length) {
    const details = element("div", "source-details");
    for (const occurrence of selectedOccurrences) {
      const path = ancestors(artifact, occurrence.id).reverse().join(" → ");
      details.append(
        element(
          "p",
          "",
          `${path} · definition ${occurrence.definition} · lines ${occurrence.source.startLine}–${occurrence.source.endLine}${occurrence.origin ? ` · ${occurrence.origin}` : ""}`,
        ),
      );
    }
    node.append(details);
  }
  const lines = element("div", "source-code");
  lines.dataset.scroll = "source";
  artifact.sources["example.prompt.tsx"].split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const lineOwners = artifact.occurrences.filter(
      (o) => o.source.startLine <= lineNumber && o.source.endLine >= lineNumber,
    );
    const exactOwners = lineOwners.filter(
      (o) => o.source.startLine === lineNumber && o.source.endLine === lineNumber,
    );
    const targets = (exactOwners.length ? exactOwners : lineOwners).map((o) => o.id);
    const row = button(
      `${String(lineNumber).padStart(2)}  ${line}`,
      () => ctx.select(selectedSide, targets, "source"),
      "source-line",
    );
    row.dataset.line = String(lineNumber);
    row.dataset.control = `source:${selectedSide}:${lineNumber}`;
    if (
      selectedOccurrences.some(
        (o) => o.source.startLine <= lineNumber && o.source.endLine >= lineNumber,
      )
    )
      row.classList.add("selected");
    lines.append(row);
  });
  node.append(lines);
  return node;
}
