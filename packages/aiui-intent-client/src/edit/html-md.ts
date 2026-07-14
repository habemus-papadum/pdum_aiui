/**
 * html-md.ts — best-effort rich-clipboard → Markdown (owner: "if there's an
 * easy way … it'd be nice"; optional by design). A deliberately SMALL
 * converter over DOMParser — the common shapes a clipboard actually carries
 * (bold, italics, code, links, headings, lists, blockquotes, paragraphs) and
 * nothing exotic. Anything unrecognized contributes its text content, so the
 * worst case is exactly the plain-text paste we'd have done anyway.
 */

const BLOCK_GAP = "\n\n";

function children(node: Node, indent: string): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    out += serialize(child, indent);
  }
  return out;
}

function serialize(node: Node, indent: string): string {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse the whitespace runs HTML renders collapsed.
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "strong":
    case "b":
      return `**${children(el, indent).trim()}**`;
    case "em":
    case "i":
      return `*${children(el, indent).trim()}*`;
    case "del":
    case "s":
      return `~~${children(el, indent).trim()}~~`;
    case "code": {
      const text = el.textContent ?? "";
      return text.includes("\n") ? text : `\`${text}\``;
    }
    case "pre": {
      const text = (el.textContent ?? "").replace(/\n$/, "");
      return `${BLOCK_GAP}\`\`\`\n${text}\n\`\`\`${BLOCK_GAP}`;
    }
    case "a": {
      const href = el.getAttribute("href");
      const text = children(el, indent).trim();
      return href && href !== text ? `[${text}](${href})` : text;
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${BLOCK_GAP}${"#".repeat(Number(tag[1]))} ${children(el, indent).trim()}${BLOCK_GAP}`;
    case "li":
      return ""; // handled by ul/ol below (needs the ordinal)
    case "ul":
    case "ol": {
      const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "li");
      const lines = items.map((li, index) => {
        const bullet = tag === "ol" ? `${index + 1}.` : "-";
        return `${indent}${bullet} ${children(li, `${indent}  `).trim()}`;
      });
      return `${BLOCK_GAP}${lines.join("\n")}${BLOCK_GAP}`;
    }
    case "blockquote": {
      const inner = children(el, indent).trim().split("\n").join("\n> ");
      return `${BLOCK_GAP}> ${inner}${BLOCK_GAP}`;
    }
    case "br":
      return "\n";
    case "p":
    case "div":
      return `${BLOCK_GAP}${children(el, indent).trim()}${BLOCK_GAP}`;
    case "script":
    case "style":
    case "head":
      return "";
    default:
      return children(el, indent);
  }
}

/**
 * Convert clipboard HTML to Markdown, best-effort. Returns `undefined` when
 * the result would not beat the plain-text fallback (no markup recognized) —
 * the caller then pastes text/plain as-is.
 */
export function htmlToMarkdown(html: string): string | undefined {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const markdown = serialize(doc.body, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, BLOCK_GAP)
    .trim();
  if (markdown === "") {
    return undefined;
  }
  // If conversion produced no Markdown SYNTAX, the plain-text lane is equal
  // and simpler — signal the caller to prefer it.
  const plain = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  return markdown === plain ? undefined : markdown;
}
