/**
 * page-text.ts — the page as text a model can read: headings, prose, lists,
 * tables, the numbers on screen, and every equation as its TeX. Framework-free
 * (no Solid): the `read-page` standard tool calls it, and so can anything with
 * a DOM — an external host, a test.
 *
 * Shape: Markdown-like, because models read it well and it keeps the
 * structure (a heading is a heading, a table row is a row) without an HTML
 * dump. Math: an element stamped `data-tex` (aiui-viz's `TeX` component)
 * emits its source as `$…$`, or `$$…$$` for display math; an unstamped KaTeX
 * element falls back to its MathML annotation. KaTeX's duplicate HTML half
 * carries `aria-hidden`, which the walk skips for everything.
 *
 * Skipped outright: script/style/noscript/template, svg/canvas/video/audio/
 * iframe (a chart's tick labels are noise; its caption is prose), `hidden`
 * elements and `aria-hidden="true"` ones, whatever `checkVisibility()` says is
 * off, and the page's own agent chrome — elements carrying
 * {@link AGENT_CHROME_ATTR}, which ToolLog and the voice dock set, so a model
 * never reads its own log back as the page.
 */

/** The attribute that marks agent chrome (a tool log, a voice dock): never read as the page. */
export const AGENT_CHROME_ATTR = "data-aiui-chrome";
/** `read-page`'s default window, in characters. */
export const READ_PAGE_DEFAULT_CHARS = 16_384;
/** `read-page`'s hard cap, in characters. */
export const READ_PAGE_MAX_CHARS = 65_536;

export interface PageTextOptions {
  /** Where to start; `document.body` by default. */
  root?: Element | null;
  /** Characters to return (default {@link READ_PAGE_DEFAULT_CHARS}). */
  maxChars?: number;
  /** Characters of the rendered text to skip first — paging. */
  offset?: number;
}

export interface PageHeading {
  level: number;
  text: string;
}

export interface PageTextResult {
  /** The window of rendered text (see `offset`/`maxChars`). */
  text: string;
  /** The whole rendering's length, so a caller knows how much remains. */
  chars: number;
  /** True when `text` stops before the end of the rendering. */
  truncated: boolean;
  /** Every heading in the rendering, in order — the page's outline. */
  headings: PageHeading[];
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "head",
  "meta",
  "link",
  "title",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "summary",
  "tr",
]);

/**
 * The TeX behind an element: the nearest `data-tex` stamp (aiui-viz's `TeX`
 * component, the robust path), else the nearest KaTeX node's MathML
 * annotation. The same recovery a host's own selection watcher makes.
 */
export function texOfElement(el: Element | null): string | undefined {
  if (el === null) return undefined;
  const stamped = el.closest("[data-tex]")?.getAttribute("data-tex");
  if (stamped != null) return stamped;
  const annotation = el
    .closest(".katex")
    ?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return annotation ?? undefined;
}

/** Is this element agent chrome — a tool log, a voice dock — rather than the page? */
export function isAgentChrome(el: Element): boolean {
  return el.closest(`[${AGENT_CHROME_ATTR}]`) !== null;
}

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute(AGENT_CHROME_ATTR)) return true;
  // Chrome 105+ / Safari 17.4+; absent in jsdom, where nothing is "off". A
  // DETACHED element (a selection's cloned fragment) has no visibility to
  // check — checkVisibility says false for it — so only a connected one asks.
  if (!el.isConnected) return false;
  const visible = (el as Element & { checkVisibility?: () => boolean }).checkVisibility?.();
  return visible === false;
}

function fence(tex: string, display: boolean): string {
  const t = tex.trim();
  return display ? `\n\n$$${t}$$\n\n` : `$${t}$`;
}

/** The math an element IS (not one it sits inside): its own stamp, or a KaTeX root. */
function mathOf(el: Element): string | undefined {
  const own = el.getAttribute("data-tex");
  if (own != null) {
    return fence(own, el.tagName === "DIV" || el.classList.contains("math-display"));
  }
  if (el.classList.contains("katex-display")) {
    const tex = texOfElement(el.querySelector(".katex") ?? el);
    return tex === undefined ? undefined : fence(tex, true);
  }
  if (el.classList.contains("katex")) {
    const tex = texOfElement(el);
    return tex === undefined ? undefined : fence(tex, false);
  }
  return undefined;
}

function inputText(el: HTMLInputElement): string {
  switch (el.type) {
    case "checkbox":
    case "radio":
      return el.checked ? "[x]" : "[ ]";
    case "hidden":
    case "password":
      return "";
    case "button":
    case "submit":
    case "reset":
      return el.value;
    default:
      return el.value;
  }
}

interface Walk {
  headings: PageHeading[];
  /** `pre` blocks, held out of the whitespace normalisation. */
  pres: string[];
}

interface Ctx {
  listDepth: number;
}

const PRE_SENTINEL = "\u0000";
/** One level of list indentation, held out of the whitespace pass like `pre`. */
const INDENT_SENTINEL = "\u0001";

function children(el: Element, w: Walk, ctx: Ctx): string {
  let out = "";
  for (const child of el.childNodes) out += render(child, w, ctx);
  return out;
}

function listItems(list: Element, w: Walk, ctx: Ctx, ordered: boolean): string {
  const indent = INDENT_SENTINEL.repeat(ctx.listDepth);
  const lines: string[] = [];
  let n = 0;
  for (const li of list.children) {
    if (li.tagName !== "LI") continue;
    if (skipped(li)) continue;
    n += 1;
    let text = "";
    let nested = "";
    for (const child of li.childNodes) {
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName : "";
      if (tag === "UL" || tag === "OL") {
        if (skipped(child as Element)) continue;
        nested += `\n${listItems(child as Element, w, { listDepth: ctx.listDepth + 1 }, tag === "OL")}`;
      } else {
        text += render(child, w, ctx);
      }
    }
    const marker = ordered ? `${n}.` : "-";
    lines.push(`${indent}${marker} ${text.replace(/\s+/g, " ").trim()}${nested}`);
  }
  return lines.join("\n");
}

function tableText(table: Element, w: Walk, ctx: Ctx): string {
  const rows = [...table.querySelectorAll("tr")].filter(
    (tr) => tr.closest("table") === table && !skipped(tr),
  );
  const out: string[] = [];
  let separated = false;
  for (const tr of rows) {
    const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH");
    if (cells.length === 0) continue;
    const line = `| ${cells
      .map((c) => children(c, w, ctx).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"))
      .join(" | ")} |`;
    out.push(line);
    if (!separated && cells.some((c) => c.tagName === "TH")) {
      out.push(`| ${cells.map(() => "---").join(" | ")} |`);
      separated = true;
    }
  }
  return out.join("\n");
}

function render(node: Node, w: Walk, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  if (skipped(el)) return "";
  const math = mathOf(el);
  if (math !== undefined) return math;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "img": {
      const alt = el.getAttribute("alt")?.trim();
      return alt ? `[image: ${alt}]` : "";
    }
    case "input":
      return inputText(el as HTMLInputElement);
    case "textarea":
      return (el as HTMLTextAreaElement).value;
    case "select": {
      const picked = (el as HTMLSelectElement).selectedOptions?.[0];
      return picked?.text ?? "";
    }
    case "pre": {
      // Held out of the whitespace pass by a sentinel: indentation is content.
      const body = (el.textContent ?? "").replace(/\n$/, "");
      w.pres.push(`\`\`\`\n${body}\n\`\`\``);
      return `\n\n${PRE_SENTINEL}${w.pres.length - 1}${PRE_SENTINEL}\n\n`;
    }
    case "code":
      return `\`${children(el, w, ctx).trim()}\``;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]);
      const text = children(el, w, ctx).replace(/\s+/g, " ").trim();
      if (text !== "") w.headings.push({ level, text });
      return `\n\n${"#".repeat(level)} ${text}\n\n`;
    }
    case "ul":
    case "ol":
      return `\n\n${listItems(el, w, ctx, tag === "ol")}\n\n`;
    case "li":
      return `\n\n- ${children(el, w, ctx).replace(/\s+/g, " ").trim()}\n\n`;
    case "table":
      return `\n\n${tableText(el, w, ctx)}\n\n`;
    case "blockquote": {
      const inner = normalise(children(el, w, ctx));
      return `\n\n${inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    }
    default: {
      const inner = children(el, w, ctx);
      return BLOCK_TAGS.has(tag) ? `\n\n${inner}\n\n` : inner;
    }
  }
}

/** Collapse the walk's whitespace: one space between words, one blank line between blocks. */
function normalise(text: string): string {
  return text
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Render a DOM subtree as readable text — the whole rendering is produced,
 * then windowed by `offset`/`maxChars`, so `chars` and `truncated` tell a
 * caller how much more there is.
 */
export function pageText(options: PageTextOptions = {}): PageTextResult {
  const root =
    options.root === undefined
      ? typeof document !== "undefined"
        ? document.body
        : null
      : options.root;
  const w: Walk = { headings: [], pres: [] };
  const rendered = root === null ? "" : render(root, w, { listDepth: 0 });
  // Normalise first, then put the pre blocks and list indents back untouched.
  const whole = normalise(rendered)
    .replace(
      new RegExp(`${PRE_SENTINEL}(\\d+)${PRE_SENTINEL}`, "g"),
      (_m, i: string) => w.pres[Number(i)] ?? "",
    )
    .replace(new RegExp(INDENT_SENTINEL, "g"), "  ");
  const maxChars = Math.max(1, options.maxChars ?? READ_PAGE_DEFAULT_CHARS);
  const offset = Math.min(Math.max(0, options.offset ?? 0), whole.length);
  const text = whole.slice(offset, offset + maxChars);
  return {
    text,
    chars: whole.length,
    truncated: offset + text.length < whole.length,
    headings: w.headings,
  };
}
