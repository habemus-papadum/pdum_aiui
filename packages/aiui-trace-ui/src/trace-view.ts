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
 * and framework-free, so every debug home — the intent client's panel and the
 * console's `/__aiui/debug` page — embeds the exact same surface.
 *
 * Live-follow re-renders on every poll; two things must survive that: which raw
 * disclosures the user opened (keyed by the card's first stage index) and the
 * filter state (instance-held, the chips are built once).
 */
import { type PromptSpan, wordDiff } from "@habemus-papadum/aiui-lowering-pipeline";
import { renderJsonTree } from "./json-tree";
import { defaultPreviewUrl, type PreviewUrl, renderPathText } from "./paths";
import type { LiveTrace, TraceStageLike } from "./sources";
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
  heroPrompt,
  isImageFile,
  isPartialLabel,
  isPlayableAudioFile,
  type LiveSegment,
  liveOpenLine,
  liveResolvedSummary,
  liveToolSegments,
  noPromptMessage,
  parsePatchLines,
  previousPartialText,
  savedFrameFiles,
  shotBlobName,
  TOGGLE_CATEGORIES,
  type TraceCard,
  traceDurationMs,
  traceOutcome,
} from "./trace-cards";

export interface TraceViewConfig {
  /** Resolve a stage blob to a URL (cross-origin in the MV3 side panel). */
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
// Transcript-preview sized: the hero is a PROMPT reading surface — a shot is
// an inline chip there, and hover-peek / click-to-open give the pixels
// (shrunk from 140, 2026-07-12).
const THUMB_MAX = 40;

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
    // Two SECTIONS, each collapsible and independently scrolling (reworked
    // 2026-07-12): the lowered prompt and the recorded stages are different
    // reading surfaces — sharing one scroll made the prompt unreadable as
    // soon as a trace had many stages, and unusable in a narrow host (the
    // extension's side panel). Every client gets the split.
    // The events section's body: filters AT THE TOP OF THE CONTENT — they
    // belong to the expanded view, not the collapsed header (2026-07-12).
    const eventsBody = this.el("div", "aiui-dbg-events-body");
    eventsBody.append(this.filtersEl, this.cardsEl);
    this.root.append(
      this.statusEl,
      this.section("prompt", "lowered prompt", this.heroEl),
      // Events start COLLAPSED: the lowered prompt is what a trace is opened
      // for; the recorded events are the drill-down (2026-07-12).
      this.section("stages", "events", eventsBody, undefined, true),
    );
  }

  /**
   * One collapsible section: a header button that toggles it, an optional
   * header-tail (the stage filters), and a scrolling body.
   */
  private section(
    kind: "prompt" | "stages",
    title: string,
    body: HTMLElement,
    tail?: HTMLElement,
    startCollapsed = false,
  ): HTMLElement {
    const sec = this.el("div", `aiui-dbg-sec ${kind}${startCollapsed ? " collapsed" : ""}`);
    const head = this.doc.createElement("div");
    head.className = "aiui-dbg-sec-head";
    const toggle = this.doc.createElement("button");
    toggle.type = "button";
    toggle.className = "aiui-dbg-sec-toggle";
    const chevron = this.doc.createElement("span");
    chevron.className = "aiui-dbg-sec-chevron";
    chevron.textContent = "▾";
    const label = this.doc.createElement("span");
    label.textContent = title;
    toggle.append(chevron, label);
    toggle.addEventListener("click", () => {
      sec.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", sec.classList.contains("collapsed") ? "false" : "true");
    });
    toggle.setAttribute("aria-expanded", startCollapsed ? "false" : "true");
    head.append(toggle);
    if (tail !== undefined) {
      head.append(tail);
    }
    body.classList.add("aiui-dbg-sec-body");
    sec.append(head, body);
    return sec;
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
    // The prompt the agent actually reads, as ONE raw block — plus the spans
    // composeIntent handed us. The hero renders the text verbatim and overlays
    // structure from the spans; it no longer re-parses the string.
    const { text, spans, speculative } = heroPrompt(trace.stages);
    if (text === "") {
      const note = this.el("div", "aiui-dbg-hero-none");
      note.textContent = noPromptMessage(traceOutcome(trace).state);
      this.heroEl.append(note);
      return;
    }
    if (speculative) {
      // A speculative fold is not what was (or will be) sent — later
      // interactions still change it.
      const badge = this.el("div", "aiui-dbg-hero-preview");
      badge.textContent = "preview · the prompt as last folded, not yet sent";
      this.heroEl.append(badge);
    }
    const raw = this.el("pre", "aiui-dbg-hero-raw");
    this.renderAnnotatedPrompt(raw, text, spans, trace.id ?? "");
    this.heroEl.append(raw);
  }

  /**
   * Render `text` verbatim into `container`, cutting only at the spans the hero
   * styles specially: `shot` (the raw block becomes a hover-preview link to the
   * captured image) and `preamble` (de-emphasized). Every other region — and
   * every other span kind, e.g. a selection's `file:line` locator — is plain
   * text that `renderPathText` turns into a preview hyperlink for free. Spans
   * are trusted from the compiler; out-of-range or overlapping ones are skipped
   * defensively so a malformed payload degrades to plain text, never throws.
   */
  private renderAnnotatedPrompt(
    container: HTMLElement,
    text: string,
    spans: PromptSpan[],
    traceId: string,
  ): void {
    const cuts = spans
      .filter((s) => s.kind === "shot" || s.kind === "preamble")
      .filter((s) => s.start >= 0 && s.start < s.end && s.end <= text.length)
      .sort((a, b) => a.start - b.start);
    const plain = (slice: string): void => {
      if (slice === "") {
        return;
      }
      const span = this.doc.createElement("span");
      renderPathText(span, slice, this.previewUrl);
      container.append(span);
    };
    let cursor = 0;
    for (const cut of cuts) {
      if (cut.start < cursor) {
        continue; // overlapping span — keep the earlier one, skip this
      }
      plain(text.slice(cursor, cut.start));
      const slice = text.slice(cut.start, cut.end);
      if (cut.kind === "preamble") {
        const pre = this.el("span", "aiui-dbg-hero-preamble");
        renderPathText(pre, slice, this.previewUrl);
        container.append(pre);
      } else {
        container.append(this.renderShotSpan(traceId, cut, slice));
      }
      cursor = cut.end;
    }
    plain(text.slice(cursor));
  }

  /**
   * A `shot` span → its raw screenshot block, styled as a hover-preview link:
   * hovering peeks the captured image (attachImagePeek), clicking opens it. The
   * pixels resolve from the span's own `path` (shotUrl → trace blob), so no
   * attribute is parsed back out of the text.
   */
  private renderShotSpan(traceId: string, span: PromptSpan, slice: string): HTMLElement {
    const el = this.el("span", "aiui-dbg-hero-shot");
    el.textContent = slice;
    const url = this.shotUrl(traceId, span.kind === "shot" ? span.path : undefined);
    if (url) {
      el.classList.add("aiui-dbg-hero-shot-link");
      el.addEventListener("click", () => this.doc.defaultView?.open(url, "_blank"));
      attachImagePeek(el, url, this.doc);
    }
    return el;
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

    // The lowered prompt lives in the hero; the card is a pointer. (Its sibling
    // in the `lowered` bucket, `live resolved`, renders its own body below.)
    if (label === "lowered prompt") {
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
      // Selections: one line of substance — marker (when the stage has one;
      // old traces don't), text excerpt, locator. Every field is optional so
      // a pre-marker (or retired-shape) stage renders degraded, not broken.
      case "app selection": {
        const marker = typeof data?.marker === "string" ? `${data.marker} · ` : "";
        const loc = typeof data?.sourceLoc === "string" ? ` @ ${data.sourceLoc}` : "";
        const cell = typeof data?.cell === "string" ? ` · cell ${data.cell}` : "";
        info(`${marker}“${clip(String(data?.text ?? ""), 80)}”${loc}${cell}`);
        return;
      }
      case "code selection": {
        const marker = typeof data?.marker === "string" ? `${data.marker} · ` : "";
        const loc = typeof data?.sourceLoc === "string" ? `${data.sourceLoc} · ` : "";
        info(`${marker}${loc}“${clip(String(data?.text ?? ""), 80)}”`);
        return;
      }
      case "app selection dropped":
      case "code selection dropped":
        info(
          typeof data?.marker === "string"
            ? `${data.marker} retracted (✕ on the chip)`
            : "retracted (✕ on the chip)",
        );
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

      // ── the realtime submode ──────────────────────────────────────────────
      case "live open":
        info(liveOpenLine(data));
        return;
      case "live nudge":
        info(
          typeof data?.text === "string" && data.text
            ? `“${clip(String(data.text), 100)}”`
            : "Enter nudge sent to the live model",
        );
        return;
      case "live tool call": {
        // The verbatim submit_intent segments, rendered as the model wrote
        // them: prose interleaved with 🖼 shot chips.
        const segments = liveToolSegments(card.stage.data);
        if (segments.length > 0) {
          box.append(this.renderLiveSegments(segments));
        } else {
          info("(no segments)");
        }
        return;
      }
      case "live resolved": {
        const summary = liveResolvedSummary(card.stage.data);
        info(clip(summary.body, 100) || "(resolved)");
        if (summary.resolved || summary.unresolved) {
          const refs = this.el("div", "aiui-dbg-card-sub");
          refs.textContent = `${summary.resolved} ref${summary.resolved === 1 ? "" : "s"} resolved${
            summary.unresolved ? ` · ${summary.unresolved} unresolved` : ""
          }`;
          box.append(refs);
        }
        return;
      }
      case "live reply":
        info(clip(String(data?.text ?? ""), 100));
        return;
      case "live fallback":
        info(
          String(
            data?.reason ?? data?.why ?? data?.message ?? "fell back to the chronicle compose",
          ),
        );
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

    // A streaming partial: the vendor's cumulative text for an uncommitted
    // segment. Rendered as a word diff against the segment's previous partial —
    // additions green, revisions red — which is the whole reason it is recorded.
    if (isPartialLabel(label)) {
      const text = String(data?.text ?? "");
      info(`${text.length} chars`);
      box.append(this.renderWordDiff(previousPartialText(trace.stages, card.indices[0]), text));
      return;
    }

    // Speculative compose (coalesced): the freshest transcript snippet, and how
    // large a prompt the fold had rendered at that point (the hero shows it).
    if (label.startsWith("composed (speculative)")) {
      const promptChars = typeof data?.prompt === "string" ? data.prompt.length : 0;
      const transcript = clip(String(data?.transcript ?? ""), 100) || "(empty)";
      info(promptChars > 0 ? `${transcript} · prompt ${promptChars} chars` : transcript);
      return;
    }

    // Conditioning slots: engaged/off.
    if (/^condition /.test(label)) {
      info(data?.engaged === true ? "engaged" : data?.enabled === true ? "enabled · idle" : "off");
      return;
    }

    // A deliberate shot shown to the live model (realtime submode).
    if (/^live label shot_/.test(label)) {
      info("shown to the live model");
      return;
    }

    // Coalesced ~1fps video frames: thumbnails of the few saved keyframes,
    // gathered across the whole run (the card only holds the last stage). This
    // must precede the generic blob branch, which would render only the last.
    if (card.category === "video") {
      this.renderVideoThumbs(trace, card, box);
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
      attachImagePeek(img, url, this.doc);
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

  /**
   * The `submit_intent` tool call as the model composed it: prose runs flow as
   * text, image references become inline `🖼 shot_2` chips, positioned exactly
   * where the model placed them (RT0 finding #6 — segments preserve position).
   */
  private renderLiveSegments(segments: LiveSegment[]): HTMLElement {
    const wrap = this.el("div", "aiui-dbg-live-seg");
    for (const seg of segments) {
      if (seg.kind === "text") {
        const span = this.el("span", "aiui-dbg-live-text");
        span.textContent = seg.text;
        wrap.append(span);
      } else {
        const chip = this.el("span", "aiui-dbg-live-chip");
        chip.textContent = `🖼 ${seg.marker}`;
        wrap.append(chip);
      }
    }
    return wrap;
  }

  /**
   * The saved frames of a coalesced video-stream card, as a lazy HORIZONTAL
   * strip. Every sampled frame persists now (the sidecar-era channel saves
   * them all), so the strip opens with the first dozen and a "show all N"
   * control renders the rest on demand (`loading="lazy"` keeps the fetch
   * cost proportional to scrolling). Hover peeks a frame; click opens it.
   */
  private renderVideoThumbs(trace: LiveTrace, card: TraceCard, box: HTMLElement): void {
    const stages = card.indices
      .map((i) => (trace.stages ?? [])[i])
      .filter((s): s is TraceStageLike => Boolean(s));
    const saved = savedFrameFiles(stages);
    if (saved.length === 0) {
      const note = this.el("div", "aiui-dbg-card-info");
      note.textContent = "no saved frames";
      box.append(note);
      return;
    }
    const initial = 12;
    const thumbs = this.el("div", "aiui-dbg-video-thumbs");
    const appendFrame = (file: string): void => {
      const url = this.config.blobUrl?.(trace.id ?? "", file) ?? file;
      const img = this.doc.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.alt = file;
      img.addEventListener("click", () => this.doc.defaultView?.open(url, "_blank"));
      attachImagePeek(img, url, this.doc);
      thumbs.append(img);
    };
    for (const file of saved.slice(0, initial)) {
      appendFrame(file);
    }
    box.append(thumbs);
    if (saved.length > initial) {
      const more = this.doc.createElement("button");
      more.type = "button";
      more.className = "aiui-dbg-video-more";
      more.textContent = `show all ${saved.length} frames`;
      more.addEventListener("click", () => {
        for (const file of saved.slice(initial)) {
          appendFrame(file);
        }
        more.remove();
      });
      box.append(more);
    }
  }

  /**
   * Two texts as an inline word-level diff (the same `wordDiff` the intent
   * client's LiveDiffText correction flash uses, so every aiui surface diffs
   * text identically).
   * Word-level, so it is only ever applied to single-line prose — `wordDiff`
   * splits on whitespace and rejoins with single spaces, which would flatten a
   * multi-line prompt body and its screenshot blocks.
   */
  private renderWordDiff(before: string, after: string): HTMLElement {
    const box = this.el("div", "aiui-dbg-diff");
    for (const run of wordDiff(before, after)) {
      const span = this.doc.createElement("span");
      span.className = `aiui-dbg-diff-${run.kind}`;
      span.textContent = run.text;
      box.append(span, this.doc.createTextNode(" "));
    }
    return box;
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

/**
 * Hover **peek** for a thumbnail: while the pointer rests on `el`, a
 * fixed-position enlargement of `src` floats above the viewport bottom-left
 * of the anchor (the card list scrolls, so an absolutely-positioned child
 * would clip — the scroll-clip lesson the intent client's turn-preview peek
 * also follows). Click stays the
 * "open full size" gesture; the peek is glanceable triage.
 */
export function attachImagePeek(el: HTMLElement, src: string, doc: Document): void {
  let peek: HTMLImageElement | undefined;
  const hide = (): void => {
    peek?.remove();
    peek = undefined;
  };
  el.addEventListener("mouseenter", () => {
    hide();
    peek = doc.createElement("img");
    // Its OWN class: this peek is the <img> itself, distinct from paths.ts's
    // hidden-by-default peek CONTAINER (the two once shared .aiui-dbg-peek,
    // whose display:none swallowed this one).
    peek.className = "aiui-dbg-img-peek";
    peek.src = src;
    const rect = el.getBoundingClientRect();
    const win = doc.defaultView;
    peek.style.left = `${Math.max(8, rect.left)}px`;
    peek.style.bottom = `${(win?.innerHeight ?? 0) - rect.top + 8}px`;
    doc.body.append(peek);
  });
  el.addEventListener("mouseleave", hide);
}
