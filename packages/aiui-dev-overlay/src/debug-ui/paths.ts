/**
 * Absolute-path affordances shared by the debug panes.
 *
 * The lowering convention hands the session attachments as **absolute paths**
 * (archive/channel-attachment-path-encoding.md), so wherever a path shows up in
 * a rendered stage — the Option-C meta of the IR pane, a lowered-prompt string —
 * the debug UI makes it tangible: highlighted, and for images under a
 * previewable root, hover to peek, click to open. Which URL serves the preview
 * differs by host (the lab's dev server vs. the channel's `/debug/api/preview`
 * cross-origin), so the resolver is injected.
 */

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

// Absolute unix paths (>= one directory deep) embedded in prompt/stage text.
const ABS_PATH = /(^|[\s"'({[=:,])(\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]+)/g;

/** Resolves an absolute image path to a servable preview URL. */
export type PreviewUrl = (path: string) => string;

/** The lab default: the workbench dev server's preview proxy. */
export const defaultPreviewUrl: PreviewUrl = (path) =>
  `/api/preview?path=${encodeURIComponent(path)}`;

let peekEl: HTMLDivElement | undefined;

function showPeek(doc: Document, url: string, x: number, y: number): void {
  if (!doc.body) {
    return;
  }
  if (!peekEl || peekEl.ownerDocument !== doc) {
    peekEl = doc.createElement("div");
    peekEl.className = "aiui-dbg-peek";
    doc.body.append(peekEl);
  }
  const img = doc.createElement("img");
  img.onerror = (): void => {
    const err = doc.createElement("div");
    err.className = "aiui-dbg-peek-err";
    err.textContent = "no preview (outside the previewable roots, or gone)";
    peekEl?.replaceChildren(err);
  };
  img.src = url;
  peekEl.replaceChildren(img);
  const w = doc.defaultView?.innerWidth ?? 1024;
  const h = doc.defaultView?.innerHeight ?? 768;
  peekEl.style.left = `${Math.min(x + 14, w - 400)}px`;
  peekEl.style.top = `${Math.min(y + 14, h - 300)}px`;
  peekEl.style.display = "block";
}

function hidePeek(): void {
  if (peekEl) {
    peekEl.style.display = "none";
  }
}

/** A single absolute-path span; images peek on hover and open on click. */
export function pathNode(doc: Document, path: string, previewUrl: PreviewUrl): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = IMAGE.test(path) ? "aiui-dbg-path img" : "aiui-dbg-path";
  span.textContent = path;
  if (IMAGE.test(path)) {
    const url = previewUrl(path);
    span.addEventListener("mouseenter", (e) => showPeek(doc, url, e.clientX, e.clientY));
    span.addEventListener("mouseleave", hidePeek);
    span.addEventListener("click", () => doc.defaultView?.open(url, "_blank"));
  }
  return span;
}

/** Append `text` into `container`, wrapping any absolute paths as interactive spans. */
export function renderPathText(container: HTMLElement, text: string, previewUrl: PreviewUrl): void {
  const doc = container.ownerDocument;
  let last = 0;
  ABS_PATH.lastIndex = 0;
  for (let m = ABS_PATH.exec(text); m; m = ABS_PATH.exec(text)) {
    const start = m.index + m[1].length;
    container.append(doc.createTextNode(text.slice(last, start)));
    container.append(pathNode(doc, m[2], previewUrl));
    last = start + m[2].length;
  }
  container.append(doc.createTextNode(text.slice(last)));
}
