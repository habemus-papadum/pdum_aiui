import type {
  Asset,
  CompiledPrompt,
  Decision,
  Occurrence,
  SemanticRecord,
} from "@habemus-papadum/aiui-prompts";
import { canonicalJson } from "@habemus-papadum/aiui-prompts";
import { mappingIndex, measurePrompt } from "@habemus-papadum/aiui-prompts/analysis";
import { Dynamic, type JSX, render } from "@solidjs/web";
import katex from "katex";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  flush,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { InspectorController } from "./controller.ts";
import { contributionCostLabel, occurrenceCosts } from "./costs.ts";
import type { InspectionLoadOptions } from "./history.ts";
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
  type InspectorState,
  rangeFoldStatus,
  visibleFolds,
} from "./state.ts";

export interface InspectorOptions extends InspectionLoadOptions {
  /** Host-controlled access for inline images and raw-output image popups. */
  resolveAsset?: (asset: Asset) => string | undefined;
  copy?: (text: string) => void | Promise<void>;
  onSource?: (origin: NonNullable<Occurrence["origin"]>) => void;
}

export interface PromptInspectorProps extends InspectorOptions {
  /** A persisted semantic, operation, delivery, or wire record. Reactive prop changes reload it. */
  record?: unknown;
  /** Host-owned and fixed for this mount. Share it between views; the component never disposes it. */
  controller?: InspectorController;
}

export interface PromptPreviewProps extends PromptInspectorProps {
  initialView?: "markdown" | "text";
  /** Handle expansion in the host's own panel instead of the built-in dialog. */
  onExpand?: (controller: InspectorController) => void;
}

export interface MountedInspector {
  controller: InspectorController;
  load: (record: unknown, options?: InspectionLoadOptions) => boolean;
  dispose: () => void;
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

function JsonDetails(props: { title: string; value: unknown; open?: boolean }) {
  return (
    <details class="prompt-json" open={props.open}>
      <summary>{props.title}</summary>
      <pre>{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}

function Action(props: { label: string; action: () => void; actionKey?: string }) {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return (
    <button
      type="button"
      class="prompt-button"
      data-action-key={props.actionKey}
      onClick={() => {
        if (!disposed) flush(props.action);
      }}
    >
      {props.label}
    </button>
  );
}

/** A snapshot separates synchronous headless state from Solid's transactional rendering. */
function connectController(controller: InspectorController) {
  const snapshot = () => ({
    record: controller.record,
    compiled: controller.compiled,
    error: controller.error,
    document: controller.document,
    recordKey: controller.recordKey,
    state: {
      selected: controller.state.selected,
      contentFolded: new Set(controller.state.contentFolded),
      outlineCollapsed: new Set(controller.state.outlineCollapsed),
    },
  });
  const [current, setCurrent] = createSignal(snapshot(), { ownedWrite: true });
  onCleanup(controller.subscribe(() => setCurrent(snapshot())));
  return current;
}

type ViewSnapshot = ReturnType<ReturnType<typeof connectController>>;

function useController(props: PromptInspectorProps) {
  const initial = untrack(() => ({
    controller: props.controller,
    record: props.record,
    operation: props.operation,
    adapters: props.adapters,
  }));
  const controller = initial.controller ?? new InspectorController(initial.record, initial);
  const owned = !initial.controller;
  let input = initial;
  if (owned) {
    createEffect(
      () => ({ record: props.record, operation: props.operation, adapters: props.adapters }),
      (next) => {
        if (
          next.record !== input.record ||
          next.operation !== input.operation ||
          next.adapters !== input.adapters
        ) {
          input = { ...next, controller: undefined };
          controller.load(next.record, next);
        }
      },
    );
    onCleanup(() => controller.dispose());
  }
  return controller;
}

function RecordStatus(props: {
  snapshot: Accessor<ViewSnapshot>;
  controller: InspectorController;
}) {
  return (
    <>
      <Show when={props.snapshot().error}>
        <div class="prompt-error" role="alert">
          {props.snapshot().error}
          {props.snapshot().document
            ? " Showing the last validated record; the attempted import was not loaded."
            : ""}
        </div>
      </Show>
      <Show when={props.snapshot().document && props.snapshot().document?.kind !== "semantic"}>
        <section class="prompt-history" aria-label="Historical record">
          <p class="prompt-note">Loaded {props.snapshot().document?.kind} record.</p>
          <Show when={(props.snapshot().document?.bindings.length ?? 0) > 1}>
            <label>
              Prompt binding{" "}
              <select
                aria-label="Prompt binding"
                value={props.snapshot().recordKey ?? ""}
                onChange={(event) =>
                  flush(() => props.controller.selectRecord(event.currentTarget.value))
                }
              >
                <For each={props.snapshot().document?.bindings}>
                  {(binding) => <option value={binding.key}>{binding.label}</option>}
                </For>
              </select>
            </label>
          </Show>
          <Show when={props.snapshot().document?.verification}>
            {(verification) => (
              <p class="prompt-note">
                {props.snapshot().document?.kind === "wire" ? "Wire" : "Prepared delivery"}{" "}
                verification: {verification().status}.{" "}
                {"reason" in verification() ? (verification() as { reason: string }).reason : ""}
              </p>
            )}
          </Show>
          <Show when={chunkReference(props.snapshot().document?.operation)}>
            {(chunk) => (
              <p class="prompt-note">
                This delivery carries chunk {chunk().index + 1} of {chunk().count} of the bound
                record: the whole record is shown here; the wire verifies that chunk alone.
              </p>
            )}
          </Show>
          <Show when={props.snapshot().document?.operation}>
            {(operation) => <JsonDetails title="Stored operation record" value={operation()} />}
          </Show>
          <Show when={props.snapshot().document?.prepared}>
            {(prepared) => <JsonDetails title="Stored prepared delivery" value={prepared()} />}
          </Show>
          <Show when={props.snapshot().document?.wire}>
            {(wire) => <JsonDetails title="Captured wire record" value={wire()} />}
          </Show>
          <Show when={props.snapshot().document?.delivery}>
            {(delivery) => <JsonDetails title="Derived delivery" value={delivery()} />}
          </Show>
        </section>
      </Show>
    </>
  );
}

function createCompilationModel(
  compiled: CompiledPrompt,
  record: SemanticRecord,
  state: Accessor<InspectorState>,
  controller: InspectorController,
  options: InspectorOptions,
) {
  const measurement = measurePrompt(compiled);
  const costs = occurrenceCosts(compiled, measurement);
  const mapping = mappingIndex(compiled);
  const byId = new Map(compiled.occurrences.map((item) => [item.id, item]));
  const children = new Map<string | undefined, Occurrence[]>();
  for (const occurrence of compiled.occurrences) {
    const siblings = children.get(occurrence.parent) ?? [];
    siblings.push(occurrence);
    children.set(occurrence.parent, siblings);
  }
  const previews = new Map<string, PreviewDocument>();
  let parseError: string | undefined;
  try {
    for (const part of compiled.parts) {
      if (part.type === "text") previews.set(part.id, parsePreview(part.id, part.text));
    }
  } catch (error) {
    parseError = `Preview parser failed: ${String(error)}`;
  }
  const inlineAssets = new Map<string, AssetPreview>();
  const [detailOwners, setDetailOwners] = createSignal<readonly string[]>([]);
  const [notice, setNotice] = createSignal("");
  const selectedFamily = createMemo(() =>
    state().selected ? descendants(compiled, state().selected as string) : new Set<string>(),
  );
  const folds = createMemo(() => foldedRanges(compiled, state()));
  const foldedByOwner = createMemo(() => {
    const result = new Map<string, string>();
    for (const fold of visibleFolds(compiled, state())) {
      for (const id of descendants(compiled, fold)) result.set(id, fold);
    }
    return result;
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return {
    compiled,
    record,
    controller,
    options,
    state,
    measurement,
    costs,
    mapping,
    byId,
    children,
    previews,
    parseError,
    detailOwners,
    notice,
    selectedFamily,
    folds,
    foldedByOwner,
    label: (id: string) => byId.get(id)?.label ?? byId.get(id)?.kind ?? id,
    resolveInline(part: string, asset: Asset) {
      let result = inlineAssets.get(part);
      if (!result) {
        result = resolvePreview(asset, options);
        inlineAssets.set(part, result);
      }
      return result;
    },
    select(id: string | null) {
      if (disposed) return;
      setDetailOwners([]);
      controller.select(id);
    },
    selectRange(range: OutputRange) {
      if (disposed) return;
      setDetailOwners(controller.selectRange(range));
    },
    async copy(text: string) {
      if (disposed) return;
      try {
        if (options.copy) await options.copy(text);
        else {
          const clipboard = globalThis.navigator?.clipboard;
          if (!clipboard)
            throw new Error("Clipboard access is unavailable; expand JSON and select it.");
          await clipboard.writeText(text);
        }
        if (!disposed) setNotice("Copied canonical content. View folds were not included.");
      } catch (error) {
        if (!disposed) setNotice(`Copy failed: ${String(error)}`);
      }
    },
    openSource(origin: NonNullable<Occurrence["origin"]>) {
      if (disposed) return;
      try {
        options.onSource?.(origin);
      } catch (error) {
        setNotice(`Source navigation failed: ${String(error)}`);
      }
    },
  };
}

type Model = ReturnType<typeof createCompilationModel>;

function rangeProps(model: Model, range: OutputRange, precision: string) {
  return {
    "data-part": range.part,
    "data-start": range.start,
    "data-end": range.end,
    "data-precision": precision,
    get "data-selected"() {
      return String(
        model.mapping
          .explain(range.part, range.start, range.end)
          .some((entry) => model.selectedFamily().has(entry.contribution.occurrence)),
      );
    },
    tabIndex: 0,
    onClick(event: MouseEvent) {
      event.stopPropagation();
      flush(() => model.selectRange(range));
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        flush(() => model.selectRange(range));
      }
    },
  };
}

function AssetImage(props: {
  asset: Asset;
  preview: AssetPreview;
  loading: "lazy" | "eager";
  onLoad?: () => void;
}) {
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return (
    <Show
      when={"url" in props.preview && !failed()}
      fallback={
        <span class="prompt-note">
          {"error" in props.preview ? props.preview.error : "Image could not be loaded."}
        </span>
      }
    >
      <img
        src={"url" in props.preview ? props.preview.url : undefined}
        alt={props.asset.alt ?? props.asset.id}
        width={props.asset.width}
        height={props.asset.height}
        loading={props.loading}
        decoding="async"
        referrerpolicy="no-referrer"
        onLoad={(event) => {
          if (!disposed && event.currentTarget.isConnected) props.onLoad?.();
        }}
        onError={(event) => {
          if (!disposed && event.currentTarget.isConnected) flush(() => setFailed(true));
        }}
      />
    </Show>
  );
}

export interface PopupAnchor {
  left: number;
  top: number;
  bottom: number;
}
/** Viewport geometry is isolated so jsdom tests can cover flip/clamp without a layout engine. */
export function positionImagePopup(
  anchor: PopupAnchor,
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.left, viewport.width - popup.width - gap));
  const availableBelow = Math.max(0, viewport.height - Math.max(gap, anchor.bottom + gap) - gap);
  const availableAbove = Math.max(0, Math.min(viewport.height - gap, anchor.top - gap) - gap);
  const below =
    popup.height <= availableBelow ||
    (popup.height > availableAbove && availableBelow >= availableAbove);
  const maxHeight = below ? availableBelow : availableAbove;
  const height = Math.min(popup.height, maxHeight);
  const top = below ? Math.max(gap, anchor.bottom + gap) : Math.max(gap, anchor.top - gap - height);
  return { left, top, maxHeight };
}

function createImagePopup(options: InspectorOptions) {
  type Popup = { asset: Asset; preview: AssetPreview; trigger: HTMLButtonElement; pinned: boolean };
  const [current, setCurrent] = createSignal<Popup | null>(null, { ownedWrite: true });
  const [position, setPosition] = createSignal({ left: 0, top: 0, maxHeight: 0 });
  let popupElement: HTMLElement | undefined;
  let disposed = false;
  let suppressFocus = false;
  function reposition() {
    const shown = untrack(current);
    const popup = popupElement;
    const win = popup?.ownerDocument.defaultView;
    if (disposed || !shown || !popup || !win) return;
    if (!shown.trigger.isConnected) {
      setCurrent(null);
      return;
    }
    const bounds = popup.getBoundingClientRect();
    setPosition(
      positionImagePopup(
        shown.trigger.getBoundingClientRect(),
        {
          width: bounds.width,
          height: Math.max(bounds.height, popup.scrollHeight + bounds.height - popup.clientHeight),
        },
        { width: win.innerWidth, height: win.innerHeight },
      ),
    );
  }
  function close(restoreFocus = false) {
    const shown = untrack(current);
    setCurrent(null);
    if (restoreFocus && shown?.trigger.isConnected) {
      suppressFocus = true;
      shown.trigger.focus();
      queueMicrotask(() => {
        suppressFocus = false;
      });
    }
  }
  function show(asset: Asset, trigger: HTMLButtonElement, pinned: boolean) {
    if (disposed || suppressFocus || (untrack(current)?.pinned && !pinned)) return;
    if (pinned && untrack(current)?.pinned && untrack(current)?.trigger === trigger) {
      close(true);
      return;
    }
    flush(() => setCurrent({ asset, preview: resolvePreview(asset, options), trigger, pinned }));
    flush(reposition);
  }
  function leave(trigger: HTMLButtonElement) {
    if (untrack(current)?.trigger === trigger && !untrack(current)?.pinned) flush(() => close());
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && untrack(current)) {
      event.preventDefault();
      flush(() => close(true));
    }
  };
  const onViewport = () => {
    if (untrack(current)) flush(reposition);
  };
  function Popup() {
    let cleanup = () => {};
    function hidePopover() {
      const element = popupElement;
      if (
        element?.isConnected &&
        typeof element.hidePopover === "function" &&
        element.matches(":popover-open")
      ) {
        element.hidePopover();
      }
    }
    onCleanup(() => {
      hidePopover();
      cleanup();
    });
    createEffect(current, (shown) => {
      const element = popupElement;
      if (!element?.isConnected || typeof element.showPopover !== "function") return;
      if (shown && !element.matches(":popover-open")) element.showPopover();
      else if (!shown) hidePopover();
    });
    createEffect(
      () => true,
      () => {
        const element = popupElement;
        if (!element) return;
        const doc = element.ownerDocument;
        doc.addEventListener("keydown", onKey);
        doc.addEventListener("scroll", onViewport, true);
        doc.defaultView?.addEventListener("resize", onViewport);
        const resize =
          typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onViewport);
        resize?.observe(element);
        cleanup = () => {
          disposed = true;
          doc.removeEventListener("keydown", onKey);
          doc.removeEventListener("scroll", onViewport, true);
          doc.defaultView?.removeEventListener("resize", onViewport);
          resize?.disconnect();
        };
      },
    );
    return (
      <aside
        class="prompt-image-popup"
        role="dialog"
        aria-label="Image preview"
        hidden={!current()}
        ref={(element) => {
          popupElement = element;
          if (typeof element.showPopover === "function") element.setAttribute("popover", "manual");
        }}
        style={{
          left: `${position().left}px`,
          top: `${position().top}px`,
          "max-height": `min(var(--prompt-popup-max-height, 70vh), ${position().maxHeight}px)`,
        }}
      >
        <Show when={current()} keyed>
          {(shown) => (
            <>
              <strong>{shown.asset.alt ?? shown.asset.id}</strong>
              <p class="prompt-note">
                {shown.pinned ? "Pinned preview" : "Click image to pin preview"}
              </p>
              <AssetImage
                asset={shown.asset}
                preview={shown.preview}
                loading="eager"
                onLoad={onViewport}
              />
              <code>{shown.asset.uri ?? shown.asset.id}</code>
              <Action label="Close image preview" action={() => close(true)} />
            </>
          )}
        </Show>
      </aside>
    );
  }
  function Trigger(props: { asset: Asset }) {
    let trigger: HTMLButtonElement | undefined;
    onCleanup(() => {
      if (untrack(current)?.trigger === trigger) setCurrent(null);
    });
    return (
      <button
        type="button"
        class="prompt-button prompt-image"
        ref={(element) => {
          trigger = element;
        }}
        data-asset={props.asset.id}
        aria-haspopup="dialog"
        aria-expanded={current()?.asset === props.asset ? "true" : "false"}
        onPointerEnter={(event) => show(props.asset, event.currentTarget, false)}
        onPointerLeave={(event) => leave(event.currentTarget)}
        onFocus={(event) => show(props.asset, event.currentTarget, false)}
        onBlur={(event) => leave(event.currentTarget)}
        onClick={(event) => show(props.asset, event.currentTarget, true)}
      >
        Image: {props.asset.alt ?? props.asset.id}
      </button>
    );
  }
  return { Popup, Trigger, hide: () => close() };
}

type ImagePopup = ReturnType<typeof createImagePopup>;

function TreeItem(props: { model: Model; item: Occurrence }) {
  const { model, item } = props;
  const children = model.children.get(item.id) ?? [];
  const cost = model.costs.get(item.id);
  const label = model.label(item.id);
  return (
    <div class="prompt-tree-item" data-occurrence={item.id}>
      <div class="prompt-tree-row" data-selected={String(item.id === model.state().selected)}>
        <Show when={children.length}>
          <button
            type="button"
            class="prompt-button"
            data-action-key={`outline:${item.id}`}
            aria-label={`Toggle outline: ${label}`}
            aria-expanded={model.state().outlineCollapsed.has(item.id) ? "false" : "true"}
            onClick={() => flush(() => model.controller.toggleOutline(item.id))}
          >
            {model.state().outlineCollapsed.has(item.id) ? "+" : "−"}
          </button>
        </Show>
        <button
          type="button"
          class="prompt-button"
          data-action-key={`select:${item.id}`}
          title={`${item.kind} · ${item.id} · definition ${item.definition}`}
          onClick={() => flush(() => model.select(item.id))}
        >
          {label}
        </button>
        <Show when={cost}>
          {(value) => (
            <span
              class="prompt-tree-cost"
              data-cost-occurrence={item.id}
              data-code-units={value().subtree.codeUnits}
              data-images={value().subtree.images}
              title={`Subtree (inclusive): ${contributionCostLabel(value().subtree)}. Own (exclusive): ${contributionCostLabel(value().own)}. Generated text is counted with its recorded owner.`}
            >
              {value().subtree.codeUnits} cu · {value().subtree.images} img
            </span>
          )}
        </Show>
        <button
          type="button"
          class="prompt-button"
          data-action-key={`fold:${item.id}`}
          aria-label={`Fold content: ${label}`}
          aria-pressed={model.state().contentFolded.has(item.id) ? "true" : "false"}
          onClick={() => flush(() => model.controller.toggleFold(item.id))}
        >
          {model.state().contentFolded.has(item.id) ? "Show" : "Fold"}
        </button>
      </div>
      <Show when={!model.state().outlineCollapsed.has(item.id)}>
        <div class="prompt-tree-children">
          <For each={children}>{(child) => <TreeItem model={model} item={child} />}</For>
        </div>
      </Show>
    </div>
  );
}

function Composition(props: { model: Model }) {
  return (
    <section class="prompt-tree" aria-label="Occurrence tree">
      <h3>Composition</h3>
      <p class="prompt-note prompt-cost-legend">
        Subtree costs: cu = UTF-16 code units; img = image placements. Parent and child totals
        overlap. These are not tokens.
      </p>
      <For each={props.model.children.get(undefined) ?? []}>
        {(item) => <TreeItem model={props.model} item={item} />}
      </For>
    </section>
  );
}

function MarkdownNode(props: { model: Model; node: PreviewNode; document: PreviewDocument }) {
  const { node, model } = props;
  const nested = () => (
    <For each={node.children}>
      {(child) => <MarkdownNode model={model} node={child} document={props.document} />}
    </For>
  );
  if (node.type === "definition") return null;
  if (node.type === "text") return node.value ?? "";
  if (node.type === "html") return <code class="prompt-html-literal">{node.value ?? ""}</code>;
  if (node.type === "math" || node.type === "inlineMath") {
    const display = mathPreviewValue(node, model.compiled.semanticRegions);
    // KaTeX is a leaf renderer only. Solid owns its stable containing node and lifecycle.
    const html = katex.renderToString(display.value, {
      displayMode: node.type === "math",
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
    return (
      <Dynamic
        component={node.type === "math" ? "div" : "span"}
        class="prompt-equation"
        data-math-encoding={display.encoding}
        title={display.value}
        {...(node.range ? rangeProps(model, node.range, "whole-equation") : {})}
        innerHTML={html}
      />
    );
  }
  if (node.type === "code")
    return (
      <pre>
        <code>{node.value ?? ""}</code>
      </pre>
    );
  if (node.type === "inlineCode") return <code>{node.value ?? ""}</code>;
  if (node.type === "image" || node.type === "imageReference") {
    return (
      <span class="prompt-note">[Markdown image: {node.alt ?? node.identifier ?? "image"}]</span>
    );
  }
  if (node.type === "link" || node.type === "linkReference") {
    const url = safeLink(node.url ?? props.document.definitions.get(node.identifier ?? ""));
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        {nested()}
      </a>
    ) : (
      <span>{nested()}</span>
    );
  }
  const tags: Record<string, keyof JSX.IntrinsicElements> = {
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
  const tag =
    node.type === "heading"
      ? `h${Math.min(6, Math.max(1, node.depth ?? 1))}`
      : node.type === "list"
        ? node.ordered
          ? "ol"
          : "ul"
        : (tags[node.type] ?? "div");
  return (
    <Dynamic
      component={tag as keyof JSX.IntrinsicElements}
      {...(node.type === "list" && node.ordered && node.start !== undefined
        ? { start: node.start }
        : {})}
    >
      {node.checked !== undefined && node.checked !== null ? (node.checked ? "☑ " : "☐ ") : ""}
      {nested()}
    </Dynamic>
  );
}

function MarkdownBlock(props: { model: Model; node: PreviewNode; document: PreviewDocument }) {
  const { node, model } = props;
  if (!node.range) return <MarkdownNode {...props} />;
  const range = node.range;
  const status = createMemo(() => rangeFoldStatus(range, model.folds()));
  return (
    <div
      class={status() === "full" ? "prompt-fold-placeholder" : "prompt-preview-block"}
      {...rangeProps(model, range, node.type === "math" ? "whole-equation" : "block")}
      data-partial-fold={status() === "partial" ? "true" : undefined}
    >
      <Show when={status() !== "full"} fallback="[Folded preview block]">
        <MarkdownNode {...props} />
      </Show>
      <Show when={status() === "partial"}>
        <small class="prompt-partial-fold">
          Partly folded in raw output; complete block retained for valid Markdown/math.
        </small>
      </Show>
    </div>
  );
}

function ImagePart(props: {
  model: Model;
  part: Extract<CompiledPrompt["parts"][number], { type: "image" }>;
  raw?: boolean;
  popup: ImagePopup;
}) {
  const { model, part } = props;
  const contribution = model.compiled.contributions.find((entry) => entry.part === part.id);
  const folded = () =>
    contribution ? model.foldedByOwner().get(contribution.occurrence) : undefined;
  return (
    <Show
      when={!folded()}
      fallback={
        <Action
          label={`[Folded image: ${model.label(folded() ?? "")}]`}
          action={() => {
            const fold = folded();
            if (fold) model.controller.toggleFold(fold);
          }}
        />
      }
    >
      {props.raw ? (
        <props.popup.Trigger asset={part.asset} />
      ) : (
        <figure class="prompt-inline-image">
          <button
            type="button"
            class="prompt-inline-image-frame"
            aria-label={`Select image: ${part.asset.alt ?? part.asset.id}`}
            data-action-key={`image:${part.id}`}
            data-asset={part.asset.id}
            data-part={part.id}
            data-precision="atomic-asset"
            data-selected={String(
              !!contribution && model.selectedFamily().has(contribution.occurrence),
            )}
            onClick={() => flush(() => model.select(contribution?.occurrence ?? null))}
          >
            <AssetImage
              asset={part.asset}
              preview={model.resolveInline(part.id, part.asset)}
              loading="lazy"
            />
          </button>
          <figcaption class="prompt-inline-image-caption">
            {part.asset.alt ?? part.asset.id}
          </figcaption>
        </figure>
      )}
    </Show>
  );
}

function RawPart(props: {
  model: Model;
  part: Extract<CompiledPrompt["parts"][number], { type: "text" }>;
}) {
  const { model, part } = props;
  const entries = model.compiled.contributions.filter(
    (entry) => entry.part === part.id && entry.start !== undefined && entry.end !== undefined,
  );
  return (
    <pre data-raw-part={part.id}>
      <For each={entries}>
        {(entry, index) => {
          const start = entry.start as number;
          const end = entry.end as number;
          const folded = () => model.foldedByOwner().get(entry.occurrence);
          const firstFold = () =>
            folded() &&
            (index() === 0 ||
              model.foldedByOwner().get(entries[index() - 1].occurrence) !== folded());
          return (
            <Show
              when={!folded()}
              fallback={
                <Show when={firstFold()}>
                  <Action
                    label={`[Folded: ${model.label(folded() ?? "")}]`}
                    action={() => {
                      const fold = folded();
                      if (fold) model.controller.toggleFold(fold);
                    }}
                  />
                </Show>
              }
            >
              <span
                class="prompt-raw-span"
                data-owner={entry.occurrence}
                data-relation={entry.relation}
                {...rangeProps(model, { part: part.id, start, end }, "output-range")}
              >
                {part.text.slice(start, end)}
              </span>
            </Show>
          );
        }}
      </For>
    </pre>
  );
}

function OutputPanes(props: {
  model: Model;
  popup: ImagePopup;
  mode?: "both" | "markdown" | "text";
  condensed?: boolean;
}) {
  const { model } = props;
  createEffect(
    () => props.mode,
    (mode) => {
      if (mode === "markdown") props.popup.hide();
    },
  );
  return (
    <>
      <section
        class="prompt-raw"
        aria-label="Canonical raw output"
        hidden={props.mode === "markdown"}
      >
        <Show when={!props.condensed}>
          <h3>Raw output</h3>
        </Show>
        <For each={model.compiled.parts}>
          {(part) =>
            part.type === "image" ? (
              <ImagePart model={model} part={part} raw popup={props.popup} />
            ) : (
              <RawPart model={model} part={part} />
            )
          }
        </For>
      </section>
      <section
        class="prompt-preview"
        aria-label="Markdown and math preview"
        hidden={props.mode === "text"}
      >
        <Show when={!props.condensed}>
          <h3>Markdown + math</h3>
          <p class="prompt-note">
            Navigation: original block / whole equation. No glyph-level map.
          </p>
        </Show>
        <Show when={model.parseError}>
          <div class="prompt-error" role="alert">
            {model.parseError}
          </div>
        </Show>
        <For each={model.compiled.parts}>
          {(part) => {
            if (part.type === "image")
              return <ImagePart model={model} part={part} popup={props.popup} />;
            const document = model.previews.get(part.id);
            return document ? (
              <For each={document.nodes}>
                {(node) => <MarkdownBlock model={model} node={node} document={document} />}
              </For>
            ) : null;
          }}
        </For>
      </section>
    </>
  );
}

function Provenance(props: { model: Model }) {
  const { model } = props;
  const selected = createMemo(() => model.byId.get(model.state().selected ?? ""));
  const origins = createMemo(() => {
    const item = selected();
    if (!item) return [];
    const result: { origin: NonNullable<Occurrence["origin"]>; title: string; action: string }[] =
      [];
    const seen = new Set<string>();
    function add(
      origin: NonNullable<Occurrence["origin"]> | undefined,
      title: string,
      action: string,
    ) {
      if (!origin) return false;
      const fingerprint = canonicalJson(origin);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      result.push({ origin, title, action });
      return true;
    }
    add(
      item.origin ??
        model.record.definitions.find((definition) => definition.id === item.definition)?.origin,
      "Recorded source / data origin",
      "Open recorded source",
    );
    add(item.definitionOrigin, "Recorded definition origin", "Open definition source");
    let lineage = 1;
    for (const origin of item.origins ?? []) {
      if (add(origin, `Recorded lineage origin ${lineage}`, `Open lineage source ${lineage}`))
        lineage++;
    }
    let contribution = 1;
    for (const entry of model.compiled.contributions) {
      if (
        model.selectedFamily().has(entry.occurrence) &&
        add(
          entry.origin,
          `Recorded contribution origin ${contribution}`,
          `Open contribution source ${contribution}`,
        )
      )
        contribution++;
    }
    return result;
  });
  return (
    <section class="prompt-provenance" aria-label="Selected provenance">
      <h3>Provenance and decisions</h3>
      <Show when={model.detailOwners().length > 1}>
        <p class="prompt-note">This preview range has multiple contributing owners:</p>
        <For each={model.detailOwners()}>
          {(owner) => (
            <Action label={model.label(owner)} action={() => model.controller.select(owner)} />
          )}
        </For>
      </Show>
      <Show
        when={selected()}
        fallback={
          <p class="prompt-note">
            Select an occurrence, raw span, or preview block to inspect its owners.
          </p>
        }
      >
        {(item) => (
          <>
            <p>
              {model.label(item().id)} · occurrence {item().id} · definition {item().definition}
            </p>
            <For each={origins()}>
              {(entry) => (
                <>
                  <JsonDetails title={entry.title} value={entry.origin} open />
                  <Show when={model.options.onSource}>
                    <Action label={entry.action} action={() => model.openSource(entry.origin)} />
                  </Show>
                </>
              )}
            </For>
            <Show when={!origins().length}>
              <p class="prompt-note">No source origin was recorded for this owner.</p>
            </Show>
            <p class="prompt-note">
              Own contribution (exclusive):{" "}
              {contributionCostLabel(
                model.costs.get(item().id)?.own ?? { codeUnits: 0, images: 0 },
              )}
              . Subtree (inclusive):{" "}
              {contributionCostLabel(
                model.costs.get(item().id)?.subtree ?? { codeUnits: 0, images: 0 },
              )}
              . Counts describe emitted content, including generated syntax; folding does not change
              them.
            </p>
            <JsonDetails
              title="Selected contributions"
              value={model.compiled.contributions.filter((entry) =>
                model.selectedFamily().has(entry.occurrence),
              )}
            />
          </>
        )}
      </Show>
      <JsonDetails title="Captured context" value={model.record.context} />
      <For each={model.compiled.decisions.filter((decision) => decision.kind === "chunk")}>
        {(decision) => <ChunkRuler decision={decision} label={model.label(decision.occurrence)} />}
      </For>
      <JsonDetails title="Recorded decisions" value={model.compiled.decisions} open />
    </section>
  );
}

/** The chunk an operation carries, when it is one chunk of a partitioned record. */
function chunkReference(
  operation: { operation: { kind: string; chunk?: { index: number; count: number } } } | undefined,
): { index: number; count: number } | undefined {
  const body = operation?.operation;
  return body !== undefined && body.kind === "session" ? body.chunk : undefined;
}

/** A chunk decision as a ruler: one row per chunk with its size over the limit and its cut. */
function ChunkRuler(props: { decision: Decision; label: string }) {
  const detail = () =>
    (props.decision.detail ?? {}) as {
      unit?: string;
      limit?: number;
      count?: number;
      sizes?: number[];
      cuts?: { at: number; boundary: string }[];
      estimator?: { name: string; version: string };
    };
  return (
    <section class="prompt-chunks" aria-label="Chunk partition">
      <p class="prompt-note">
        {props.label}: {detail().count} chunk{detail().count === 1 ? "" : "s"} of at most{" "}
        {detail().limit} {detail().unit}
        {detail().estimator
          ? ` under ${detail().estimator?.name}@${detail().estimator?.version}`
          : ""}
        .
      </p>
      <ol class="prompt-chunk-ruler">
        <For each={detail().sizes ?? []}>
          {(size, index) => (
            <li>
              <b>{index() + 1}</b> {size}/{detail().limit} {detail().unit}
              {index() > 0
                ? ` · after a ${detail().cuts?.[index() - 1]?.boundary ?? "?"} boundary at ${detail().cuts?.[index() - 1]?.at ?? "?"}`
                : ""}
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

function CompilationView(props: { model: Model; condensed?: boolean; mode?: "markdown" | "text" }) {
  const { model } = props;
  const popup = createImagePopup(model.options);
  const text = canonicalText(model.compiled);
  return (
    <>
      <Show when={!props.condensed}>
        <div class="prompt-toolbar">
          <Action
            label="Recompile stored record"
            actionKey="recompile"
            action={() => model.controller.recompile()}
          />
          <Action
            label="Copy semantic record"
            actionKey="copy-record"
            action={() => void model.copy(JSON.stringify(model.record))}
          />
          <Action
            label="Copy canonical parts"
            actionKey="copy-parts"
            action={() => void model.copy(JSON.stringify(model.compiled.parts))}
          />
          <Show when={text !== null}>
            <Action
              label="Copy canonical text"
              actionKey="copy-text"
              action={() => void model.copy(text as string)}
            />
          </Show>
          <Action
            label="Unfold all content"
            actionKey="unfold-all"
            action={() => model.controller.unfoldAll()}
          />
        </div>
        <p class="prompt-record-meta">
          Schema {model.record.schemaVersion} · compiler {model.record.compiler.version} ·{" "}
          {new TextEncoder().encode(JSON.stringify(model.record)).length} record bytes ·{" "}
          {model.measurement.codeUnits} output code units · {model.measurement.images} images ·
          tokens unknown
        </p>
        <code class="prompt-fingerprint">{model.record.fingerprint}</code>
      </Show>
      <div class={props.condensed ? "prompt-compact-output" : "prompt-panels"}>
        <Show when={!props.condensed}>
          <Composition model={model} />
        </Show>
        <OutputPanes
          model={model}
          popup={popup}
          mode={props.condensed ? props.mode : "both"}
          condensed={props.condensed}
        />
      </div>
      <Show when={!props.condensed}>
        <Provenance model={model} />
        <JsonDetails title="Stored semantic record" value={model.record} />
        <JsonDetails title="Derived compilation" value={model.compiled} />
      </Show>
      <p class="prompt-note" role="status">
        {model.notice()}
      </p>
      <popup.Popup />
    </>
  );
}

function LoadedView(props: {
  controller: InspectorController;
  snapshot: Accessor<ViewSnapshot>;
  options: InspectorOptions;
  condensed?: boolean;
  mode?: "markdown" | "text";
}) {
  return (
    <Show when={props.snapshot().compiled} keyed>
      {(compiled) => {
        const record = untrack(props.snapshot).record as SemanticRecord;
        const model = createCompilationModel(
          compiled,
          record,
          () => props.snapshot().state,
          props.controller,
          props.options,
        );
        return <CompilationView model={model} condensed={props.condensed} mode={props.mode} />;
      }}
    </Show>
  );
}

/** Native Solid view. Updating selection/folds preserves unaffected DOM and focus. */
export function PromptInspector(props: PromptInspectorProps) {
  const controller = useController(props);
  const snapshot = connectController(controller);
  return (
    <div class="prompt-inspector">
      <div class="prompt-inspector-content">
        <RecordStatus snapshot={snapshot} controller={controller} />
        <LoadedView controller={controller} snapshot={snapshot} options={props} />
      </div>
    </div>
  );
}

function InspectorDialog(props: {
  controller: InspectorController;
  options: InspectorOptions;
  close: () => void;
  opener?: HTMLElement;
}) {
  let dialog: HTMLDialogElement | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    dialog?.close?.();
    if (props.opener?.isConnected) props.opener.focus();
  });
  return (
    <dialog
      class="prompt-inspector prompt-inspector-dialog"
      aria-label="Full prompt inspector"
      ref={(element) => {
        dialog = element;
        queueMicrotask(() => {
          if (disposed || !element.isConnected) return;
          if (typeof element.showModal === "function") element.showModal();
          else element.open = true;
          element.querySelector<HTMLButtonElement>("button")?.focus();
        });
      }}
      onCancel={(event) => {
        event.preventDefault();
        flush(props.close);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !dialog?.querySelector(".prompt-image-popup:not([hidden])")) {
          event.preventDefault();
          event.stopPropagation();
          flush(props.close);
        }
      }}
    >
      <Action label="Close full inspector" action={props.close} />
      <PromptInspector {...props.options} controller={props.controller} />
    </dialog>
  );
}

/** Small embedding surface; Markdown/text modes share the full inspector's exact mapping/renderers. */
export function PromptPreview(props: PromptPreviewProps) {
  const controller = useController(props);
  const snapshot = connectController(controller);
  const [mode, setMode] = createSignal(props.initialView ?? "markdown");
  const [expanded, setExpanded] = createSignal(false);
  let opener: HTMLButtonElement | undefined;
  return (
    <div class="prompt-inspector prompt-compact">
      <fieldset class="prompt-toolbar" aria-label="Prompt preview controls">
        <button
          type="button"
          class="prompt-button"
          aria-pressed={mode() === "markdown" ? "true" : "false"}
          onClick={() => flush(() => setMode("markdown"))}
        >
          Markdown
        </button>
        <button
          type="button"
          class="prompt-button"
          aria-pressed={mode() === "text" ? "true" : "false"}
          onClick={() => flush(() => setMode("text"))}
        >
          Text
        </button>
        <button
          type="button"
          class="prompt-button"
          ref={(element) => {
            opener = element;
          }}
          onClick={() => {
            if (props.onExpand) props.onExpand(controller);
            else flush(() => setExpanded(true));
          }}
        >
          Open full inspector
        </button>
      </fieldset>
      <RecordStatus snapshot={snapshot} controller={controller} />
      <LoadedView
        controller={controller}
        snapshot={snapshot}
        options={props}
        condensed
        mode={mode()}
      />
      <Show when={expanded()}>
        <InspectorDialog
          controller={controller}
          options={props}
          close={() => setExpanded(false)}
          opener={opener}
        />
      </Show>
    </div>
  );
}

function mountView(
  container: HTMLElement,
  input: unknown,
  options: InspectorOptions,
  component: (props: PromptInspectorProps) => JSX.Element,
): MountedInspector {
  const controller = new InspectorController(input, options);
  const slot = container.ownerDocument.createElement("div");
  container.append(slot);
  const disposeSolid = render(() => component({ ...options, controller }), slot);
  flush();
  // Plain DOM hosts retain synchronous load/controller semantics; native hosts use Solid's scheduler.
  const unsubscribe = controller.subscribe(() => flush());
  let disposed = false;
  return {
    controller,
    load: (record, loadOptions) => controller.load(record, loadOptions ?? options),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      disposeSolid();
      controller.dispose();
      slot.remove();
    },
  };
}

/** Thin Solid root adapter for non-Solid hosts; no author functions execute in the viewer. */
export function mountInspector(
  container: HTMLElement,
  input: unknown,
  options: InspectorOptions = {},
): MountedInspector {
  return mountView(container, input, options, PromptInspector);
}

export function mountPreview(
  container: HTMLElement,
  input: unknown,
  options: InspectorOptions & Pick<PromptPreviewProps, "initialView" | "onExpand"> = {},
): MountedInspector {
  return mountView(container, input, options, (props) => (
    <PromptPreview {...props} initialView={options.initialView} onExpand={options.onExpand} />
  ));
}

/** Independent previews; no invented cross-revision occurrence correspondence. */
export function mountComparison(
  container: HTMLElement,
  before: unknown,
  after: unknown,
  options: InspectorOptions = {},
) {
  const leftController = new InspectorController(before, options);
  const rightController = new InspectorController(after, options);
  const [leftActive, setLeftActive] = createSignal(true);
  const [rightActive, setRightActive] = createSignal(true);
  const slot = container.ownerDocument.createElement("div");
  container.append(slot);
  function Comparison() {
    const left = connectController(leftController);
    const right = connectController(rightController);
    const summary = createMemo(() => {
      const a = left().compiled;
      const b = right().compiled;
      if (!a || !b || !leftActive() || !rightActive())
        return "Comparison unavailable until both records validate.";
      const result = comparePrompts(a, b);
      return `${result.sameRecord ? "Same" : "Different"} semantic records; ${result.sameOutput ? "identical" : "different"} output. Text: ${result.beforeCodeUnits} → ${result.afterCodeUnits} UTF-16 code units. ${result.decisionsChanged ? "Recorded decisions changed." : "Recorded decisions unchanged."} Independent folds; no inferred move matching.`;
    });
    return (
      <div class="prompt-comparison">
        <p class="prompt-comparison-summary">{summary()}</p>
        <Show when={leftActive()}>
          <section aria-label="Before revision">
            <h2>Before</h2>
            <PromptInspector {...options} controller={leftController} />
          </section>
        </Show>
        <Show when={rightActive()}>
          <section aria-label="After revision">
            <h2>After</h2>
            <PromptInspector {...options} controller={rightController} />
          </section>
        </Show>
      </div>
    );
  }
  const disposeSolid = render(Comparison, slot);
  flush();
  const unsubscribers = [
    leftController.subscribe(() => flush()),
    rightController.subscribe(() => flush()),
  ];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    disposeSolid();
    leftController.dispose();
    rightController.dispose();
    slot.remove();
  };
  return {
    before: {
      controller: leftController,
      load: (record: unknown, loadOptions?: InspectionLoadOptions) =>
        leftController.load(record, loadOptions ?? options),
      dispose() {
        if (disposed || leftController.disposed) return;
        unsubscribers[0]();
        flush(() => setLeftActive(false));
        leftController.dispose();
      },
    },
    after: {
      controller: rightController,
      load: (record: unknown, loadOptions?: InspectionLoadOptions) =>
        rightController.load(record, loadOptions ?? options),
      dispose() {
        if (disposed || rightController.disposed) return;
        unsubscribers[1]();
        flush(() => setRightActive(false));
        rightController.dispose();
      },
    },
    dispose,
  };
}
