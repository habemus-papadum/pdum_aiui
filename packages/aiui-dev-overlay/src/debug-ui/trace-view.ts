/**
 * The trace view: a whole channel lowering trace, rendered as a reading surface.
 *
 * A trace is the channel's per-stage record of one turn becoming a prompt
 * (inputs → IRs → the lowered prompt). The old view rendered each stage as a raw
 * JSON tree — faithful, but a wall you had to decode. This view is built for the
 * one thing a person actually does here: *look at a prompt and understand it,
 * fast.* Top to bottom:
 *
 *  1. a **status header** — the turn's outcome at a glance (sent / cancelled /
 *     abandoned / live), format, actor, when, how long, how many stages;
 *  2. the **prompt hero** — the lowered prompt itself, rendered for reading:
 *     the context preamble de-emphasized, the body prominent, and each
 *     `<screenshot>` block shown as a real thumbnail;
 *  3. **filter chips** — a direction lane (in / out / internal) and per-category
 *     toggles, defaulting to a story-shaped view (the noisiest internal chatter —
 *     per-frame audio, speculative composes — hidden behind their chips);
 *  4. the **event log as compact cards** — one per logical item, directionally
 *     coloured, coalescing runs (214 audio frames → one card), each with a
 *     type-specific one-liner and a collapsed raw disclosure.
 *
 * The classification, coalescing, patch-parsing and prompt-splitting all live in
 * the pure {@link module:trace-cards} module; this file is the DOM renderer over
 * it. It is deliberately generic — an unknown stage still gets a sensible card —
 * and framework-free, so the workbench dock and the DevTools extension embed the
 * exact same surface.
 *
 * Live-follow re-renders on every poll; two things must survive that: which raw
 * disclosures the user opened (keyed by the card's first stage index) and the
 * filter state (instance-held, the chips are built once).
 */
import { renderJsonTree } from "./json-tree";
import { defaultPreviewUrl, type PreviewUrl, renderPathText } from "./paths";
import type { LiveTrace } from "./sources";
import { injectDebugUiStyles } from "./styles";
import {
  buildCards,
  CATEGORY_META,
  type CardCategory,
  type CardDirection,
  cardVisible,
  clip,
  correctionLines,
  costLine,
  defaultEnabledCategories,
  eventTypesSummary,
  formatDuration,
  formatUsd,
  isImageFile,
  isPlayableAudioFile,
  loweredPromptText,
  noPromptMessage,
  parsePatchLines,
  parseShotBlocks,
  shotBlobName,
  splitLoweredPrompt,
  TOGGLE_CATEGORIES,
  type TraceCard,
  traceDurationMs,
  traceOutcome,
} from "./trace-cards";

export interface TraceViewConfig {
  /** Resolve a stage blob to a URL (cross-origin in the extension). */
  blobUrl?: (traceId: string, file: string) => string;
  /** Resolve an absolute image path to a preview URL. */
  previewUrl?: PreviewUrl;
  document?: Document;
}

/**
 * The lane arrow drawn at a card's left edge. Vantage = the browser: `in`
 * (browser → server) points AWAY (`←`), `out` (server → browser) points AT us
 * (`→`), the lowered prompt leaves for the agent (`←`), internal is `⚙`.
 */
const DIRECTION_ARROW: Record<CardDirection, string> = {
  in: "←",
  out: "→",
  agent: "←",
  // Lowering records also *arrive* at the reader (over the trace poll): they
  // are the server reporting what it computed, so they point → like any other
  // server-sourced information — yellow instead of green marks them as
  // "computation reported", not "a turn message".
  internal: "→",
};

/** Bounded thumbnail height for hero screenshots and inline shot blobs. */
const THUMB_MAX = 140;

export class TraceView {
  readonly root: HTMLDivElement;
  private readonly doc: Document;
  private readonly config: TraceViewConfig;
  private readonly statusEl: HTMLDivElement;
  private readonly heroEl: HTMLDivElement;
  private readonly filtersEl: HTMLDivElement;
  private readonly cardsEl: HTMLDivElement;

  // ── live-follow-surviving view state ──────────────────────────────────────
  private trace: LiveTrace | undefined;
  private direction: CardDirection | "all" = "all";
  private readonly enabled: Set<CardCategory> = defaultEnabledCategories();
  /** Card first-index → its raw disclosure is open (survives re-render). */
  private readonly openRaw = new Set<number>();

  constructor(config: TraceViewConfig = {}) {
    this.config = config;
    this.doc = config.document ?? document;
    injectDebugUiStyles(this.doc);

    this.root = this.el("div", "aiui-dbg-trace");
    this.statusEl = this.el("div", "aiui-dbg-status");
    this.heroEl = this.el("div", "aiui-dbg-hero");
    this.filtersEl = this.el("div", "aiui-dbg-filters");
    this.cardsEl = this.el("div", "aiui-dbg-cards");
    this.buildFilters();
    this.root.append(this.statusEl, this.heroEl, this.filtersEl, this.cardsEl);
  }

  /** Render (or clear, when undefined) the trace. */
  update(trace: LiveTrace | undefined): void {
    this.trace = trace;
    if (!trace) {
      this.statusEl.replaceChildren();
      this.heroEl.replaceChildren();
      this.cardsEl.replaceChildren();
      this.filtersEl.hidden = true;
      const empty = this.el("div", "aiui-dbg-empty");
      empty.textContent = "Select a trace to follow it live.";
      this.heroEl.append(empty);
      return;
    }
    this.filtersEl.hidden = false;
    this.renderStatus(trace);
    this.renderHero(trace);
    this.renderCards();
  }

  // ── status header ─────────────────────────────────────────────────────────

  private renderStatus(trace: LiveTrace): void {
    this.statusEl.replaceChildren();
    const outcome = traceOutcome(trace);
    const badge = this.el("span", `aiui-dbg-outcome state-${outcome.state}`);
    badge.textContent = `${outcome.glyph} ${outcome.label}`;

    const bits: string[] = [trace.format ?? "trace"];
    if (trace.startedAt) {
      bits.push(new Date(trace.startedAt).toLocaleTimeString());
    }
    const ms = traceDurationMs(trace);
    if (ms !== undefined) {
      bits.push(formatDuration(ms));
    }
    const n = trace.stages?.length ?? 0;
    bits.push(`${n} stage${n === 1 ? "" : "s"}`);
    if (trace.costUsd !== undefined && trace.costUsd > 0) {
      // The turn's own model spend (transcription/correction/TTS/voice/summary
      // roll-up — see the channel's cost.ts). A floor when estimates are in it.
      bits.push(formatUsd(trace.costUsd));
    }
    const meta = this.el("span", "aiui-dbg-status-meta");
    meta.textContent = bits.join(" · ");

    this.statusEl.append(badge, meta);
    if (trace.actor && trace.actor !== "human") {
      const actor = this.el("span", "aiui-dbg-status-actor");
      actor.textContent = trace.actor;
      this.statusEl.append(actor);
    }
  }

  // ── the prompt hero ───────────────────────────────────────────────────────

  private renderHero(trace: LiveTrace): void {
    this.heroEl.replaceChildren();
    const stage = (trace.stages ?? []).find((s) => s.label === "lowered prompt");
    const text = loweredPromptText(stage);
    if (text === "") {
      const note = this.el("div", "aiui-dbg-hero-none");
      note.textContent = noPromptMessage(traceOutcome(trace).state);
      this.heroEl.append(note);
      return;
    }
    const { preamble, body } = splitLoweredPrompt(text);
    if (preamble) {
      const pre = this.el("div", "aiui-dbg-hero-preamble");
      renderPathText(pre, preamble, this.previewUrl);
      this.heroEl.append(pre);
    }
    const bodyEl = this.el("div", "aiui-dbg-hero-body");
    for (const seg of parseShotBlocks(body)) {
      if (seg.kind === "text") {
        const span = this.doc.createElement("span");
        renderPathText(span, seg.text, this.previewUrl);
        bodyEl.append(span);
      } else {
        bodyEl.append(this.renderHeroShot(trace.id ?? "", seg.path, seg.block));
      }
    }
    this.heroEl.append(bodyEl);
  }

  /** A screenshot block in the hero body → a bounded, clickable thumbnail + caption. */
  private renderHeroShot(traceId: string, path: string | undefined, block: string): HTMLElement {
    const fig = this.el("figure", "aiui-dbg-shot");
    const url = this.shotUrl(traceId, path);
    if (url) {
      const img = this.doc.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.style.maxHeight = `${THUMB_MAX}px`;
      img.alt = path ?? "screenshot";
      img.addEventListener("click", () => this.doc.defaultView?.open(url, "_blank"));
      fig.append(img);
    } else {
      const missing = this.el("div", "aiui-dbg-shot-missing");
      missing.textContent = "🖼 (image not captured)";
      fig.append(missing);
    }
    const caption = this.el("figcaption", "aiui-dbg-shot-cap");
    caption.textContent = shotCaption(path, block);
    fig.append(caption);
    return fig;
  }

  /** The best URL for a shot: its stable trace blob if we can name it, else the path preview. */
  private shotUrl(traceId: string, path: string | undefined): string | undefined {
    if (!path) {
      return undefined;
    }
    const blob = shotBlobName(path);
    if (blob && this.config.blobUrl) {
      return this.config.blobUrl(traceId, blob);
    }
    // A path outside the trace dir: fall back to the path-based preview (works
    // only for an absolute path under a previewable root — see debug.ts).
    return this.previewUrl(path);
  }

  // ── filter chips ──────────────────────────────────────────────────────────

  private buildFilters(): void {
    const dirRow = this.el("div", "aiui-dbg-filter-row");
    const dirs: Array<[CardDirection | "all", string]> = [
      ["all", "all"],
      ["in", "← to server"],
      ["out", "→ from server"],
      ["agent", "← to agent"],
      ["internal", "→ lowering"],
    ];
    for (const [value, label] of dirs) {
      const chip = this.doc.createElement("button");
      chip.type = "button";
      chip.className = `aiui-dbg-chip dir${value === this.direction ? " active" : ""}`;
      chip.dataset.dir = value;
      chip.textContent = label;
      chip.addEventListener("click", () => {
        this.direction = value;
        for (const other of dirRow.querySelectorAll<HTMLButtonElement>("[data-dir]")) {
          other.classList.toggle("active", other === chip);
        }
        this.renderCards();
      });
      dirRow.append(chip);
    }

    const catRow = this.el("div", "aiui-dbg-filter-row");
    for (const category of TOGGLE_CATEGORIES) {
      const meta = CATEGORY_META[category];
      const chip = this.doc.createElement("button");
      chip.type = "button";
      chip.className = `aiui-dbg-chip cat${this.enabled.has(category) ? " active" : ""}`;
      chip.dataset.cat = category;
      chip.textContent = `${meta.icon} ${meta.label}`;
      chip.addEventListener("click", () => {
        if (this.enabled.has(category)) {
          this.enabled.delete(category);
        } else {
          this.enabled.add(category);
        }
        chip.classList.toggle("active", this.enabled.has(category));
        this.renderCards();
      });
      catRow.append(chip);
    }
    this.filtersEl.append(dirRow, catRow);
    this.filtersEl.hidden = true;
  }

  // ── the card list ─────────────────────────────────────────────────────────

  private renderCards(): void {
    this.cardsEl.replaceChildren();
    if (!this.trace) {
      return;
    }
    const cards = buildCards(this.trace.stages);
    let shown = 0;
    for (const card of cards) {
      if (!cardVisible(card, this.direction, this.enabled)) {
        continue;
      }
      this.cardsEl.append(this.renderCard(this.trace, card));
      shown += 1;
    }
    if (shown === 0) {
      const empty = this.el("div", "aiui-dbg-empty");
      empty.textContent = "No cards match the filters — widen the lane or enable a category.";
      this.cardsEl.append(empty);
    }
  }

  private renderCard(trace: LiveTrace, card: TraceCard): HTMLElement {
    const box = this.el("div", `aiui-dbg-card dir-${card.direction}${card.error ? " err" : ""}`);

    const head = this.el("div", "aiui-dbg-card-head");
    const arrow = this.el("span", "aiui-dbg-card-arrow");
    // Errors always point AT the reader — they come back to us — regardless
    // of which lane the failing stage nominally lived in.
    arrow.textContent = card.error ? "→" : DIRECTION_ARROW[card.direction];
    const icon = this.el("span", "aiui-dbg-card-icon");
    icon.textContent = card.icon;
    const title = this.el("span", "aiui-dbg-card-title");
    title.textContent = card.title;
    head.append(arrow, icon, title);
    if (card.count > 1) {
      const count = this.el("span", "aiui-dbg-card-count");
      count.textContent = `×${card.count}`;
      head.append(count);
    }
    box.append(head);

    // Type-specific body (info line + any rich content).
    this.renderCardBody(trace, card, box);

    // The raw disclosure, collapsed unless the user opened it (survives re-render).
    if (card.stage.data !== undefined || card.stage.file) {
      box.append(this.renderRaw(trace, card));
    }
    return box;
  }

  /** The one-line key-info under the title, plus any rich rendering per card type. */
  private renderCardBody(trace: LiveTrace, card: TraceCard, box: HTMLElement): void {
    const data = card.stage.data as Record<string, unknown> | undefined;
    const label = card.stage.label ?? "";

    const info = (text: string): void => {
      if (text) {
        const line = this.el("div", "aiui-dbg-card-info");
        renderPathText(line, text, this.previewUrl);
        box.append(line);
      }
    };

    // The lowered prompt lives in the hero; the card is a pointer.
    if (card.category === "lowered") {
      info("shown above ↑");
      return;
    }

    switch (label) {
      case "client context": {
        const tab = (data?.tab as { url?: string; title?: string } | undefined) ?? {};
        info([tab.url, tab.title, data?.actor].filter(Boolean).join(" · "));
        return;
      }
      case "intent config":
        info(
          [
            `tier ${data?.tier ?? "?"}`,
            `stt ${data?.transcriber ?? "?"}`,
            `fix ${data?.corrector ?? "?"}`,
          ].join(" · "),
        );
        return;
      case "prompt preamble": {
        const n = Array.isArray(data) ? data.length : 0;
        info(`${n} context section${n === 1 ? "" : "s"}`);
        return;
      }
      case "correction request": {
        const selected = data?.selected ? `“${String(data.selected)}”` : "whole transcript";
        info(`${String(data?.instruction ?? "")} — on ${selected}`);
        return;
      }
      case "correction patch": {
        const patchCost = data?.cost as Parameters<typeof costLine>[0] | undefined;
        info(
          [
            `${String(data?.model ?? "?")} · ${Math.round(Number(data?.latencyMs ?? 0))}ms`,
            patchCost ? costLine(patchCost) : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
        if (typeof data?.patch === "string") {
          box.append(this.renderPatch(data.patch));
        }
        return;
      }
      case "correction failed":
        info(String(data?.message ?? "correction failed"));
        return;
      case "transcription failed":
        info(String(data?.message ?? "transcription failed"));
        return;
      case "merged events": {
        const events = Array.isArray(card.stage.data) ? card.stage.data : [];
        info(`${events.length} event${events.length === 1 ? "" : "s"}`);
        if (events.length) {
          const types = this.el("div", "aiui-dbg-card-sub");
          types.textContent = eventTypesSummary(events);
          box.append(types);
          for (const line of correctionLines(events)) {
            const c = this.el("div", "aiui-dbg-card-sub fix");
            c.textContent = `🩹 ${line}`;
            box.append(c);
          }
        }
        return;
      }
      case "composed intent":
        info(clip(String(data?.transcript ?? ""), 100));
        return;
      case "conditioned":
        info(
          data?.cancelled === true
            ? "cancelled — nothing sent"
            : clip(String(data?.body ?? ""), 100),
        );
        return;
      case "fin compose":
        info(data?.reused === true ? "reused speculative compose" : "recomputed at fin");
        return;
      case "voice reply":
        info(clip(String(data?.text ?? ""), 100));
        return;
      case "realtime commit":
        info(`${Number(data?.frames ?? 0)} frames · ${Number(data?.bytes ?? 0)} B`);
        return;
      default:
        break;
    }

    // A model call's spend (💰): price + model + token shape, one line.
    if (label.startsWith("cost: ")) {
      info(costLine((data ?? {}) as Parameters<typeof costLine>[0]));
      return;
    }

    // Speech: `speech <id>` — the audio itself is pushed to the client, not
    // saved as a trace blob, so there is nothing to play here; show the label.
    if (/^speech /.test(label)) {
      const bytes = Number(data?.bytes ?? 0);
      info(
        [
          data?.text ? `“${String(data.text)}”` : undefined,
          String(data?.mime ?? ""),
          bytes ? `${bytes} B` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      return;
    }

    // Speculative compose (coalesced): the freshest transcript snippet.
    if (label.startsWith("composed (speculative)")) {
      info(clip(String(data?.transcript ?? ""), 100) || "(empty)");
      return;
    }

    // Conditioning slots: engaged/off.
    if (/^condition /.test(label)) {
      info(data?.engaged === true ? "engaged" : data?.enabled === true ? "enabled · idle" : "off");
      return;
    }

    // A saved attachment blob: render the pixels / an audio player inline.
    if (card.stage.file) {
      this.renderBlobBody(trace, card, box, info);
      return;
    }
  }

  /** Inline the saved attachment blob: image thumbnail, audio player, or a link. */
  private renderBlobBody(
    trace: LiveTrace,
    card: TraceCard,
    box: HTMLElement,
    info: (text: string) => void,
  ): void {
    const file = card.stage.file ?? "";
    const url = this.config.blobUrl?.(trace.id ?? "", file) ?? file;
    if (isImageFile(file)) {
      const img = this.doc.createElement("img");
      img.className = "aiui-dbg-card-img";
      img.src = url;
      img.loading = "lazy";
      img.style.maxHeight = `${THUMB_MAX}px`;
      img.alt = file;
      img.addEventListener("click", () => this.doc.defaultView?.open(url, "_blank"));
      box.append(img);
    } else if (isPlayableAudioFile(file)) {
      const audio = this.doc.createElement("audio");
      audio.controls = true;
      audio.src = url;
      audio.className = "aiui-dbg-card-audio";
      box.append(audio);
    } else {
      // e.g. raw PCM — not natively playable; show the reference.
      info(file);
    }
  }

  /** A V4A correction patch as a real red/green diff. */
  private renderPatch(patch: string): HTMLElement {
    const pre = this.el("pre", "aiui-dbg-patch");
    for (const line of parsePatchLines(patch)) {
      const row = this.doc.createElement("div");
      row.className = `aiui-dbg-patch-line ${line.kind}`;
      const prefix = line.kind === "del" ? "- " : line.kind === "add" ? "+ " : "  ";
      row.textContent =
        line.kind === "meta" || line.kind === "hunk" ? line.text : prefix + line.text;
      pre.append(row);
    }
    return pre;
  }

  /** The collapsed raw disclosure (json tree / blob), keyed for open-state survival. */
  private renderRaw(trace: LiveTrace, card: TraceCard): HTMLElement {
    const key = card.indices[0];
    const details = this.doc.createElement("details");
    details.className = "aiui-dbg-card-raw";
    details.open = this.openRaw.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openRaw.add(key);
      } else {
        this.openRaw.delete(key);
      }
    });
    const summary = this.doc.createElement("summary");
    summary.textContent = card.count > 1 ? `raw · ${card.count} stages` : "raw";
    details.append(summary);

    const stage = card.stage;
    if (stage.file) {
      const url = this.config.blobUrl?.(trace.id ?? "", stage.file) ?? stage.file;
      const a = this.doc.createElement("a");
      a.href = url;
      a.textContent = stage.file;
      a.target = "_blank";
      details.append(a);
    } else if (stage.data !== undefined) {
      details.append(
        renderJsonTree(stage.data, { open: 1, document: this.doc, previewUrl: this.previewUrl }),
      );
    }
    return details;
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  private get previewUrl(): PreviewUrl {
    return this.config.previewUrl ?? defaultPreviewUrl;
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
  ): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    node.className = className;
    return node;
  }
}

/** A short caption for a hero screenshot: its element names, else the shot id. */
function shotCaption(path: string | undefined, block: string): string {
  const elements = [...block.matchAll(/<element\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
  const id = path ? (shotBlobName(path) ?? path.split(/[\\/]/).pop() ?? path) : "screenshot";
  return elements.length > 0 ? `${id} · ${elements.join(", ")}` : id;
}
