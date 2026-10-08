/**
 * markdown.tsx — prose a model reads or wrote, shown as the model meant it:
 * a woven prompt, a `Tools:` section, a delegation's instructions. The text is
 * Markdown-shaped, and reading it as a wall of raw characters is what made
 * the ledger's `config` payload a place nobody looked.
 *
 * `TextView` renders Markdown by default with a toggle to the raw text (the
 * raw text is the fact; the rendering is the courtesy). Raw HTML in the text
 * is ESCAPED, never injected — the source is our own prompts and a page's
 * tool docs, but a debugging surface must not become a sink.
 *
 * `marked` is an optional peer of aiui-viz, like `katex`: only this subpath's
 * consumers pay for it. Shipped chrome: one stylesheet on the `--aiui-*`
 * hooks, injected once per document.
 */
import type { JSX } from "@solidjs/web";
import { Marked } from "marked";
import { createSignal, Show } from "solid-js";

export const MARKDOWN_STYLES = `
.aiui-text { font: 12px/1.45 var(--aiui-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--aiui-ink, inherit); }
.aiui-text-bar { display: flex; justify-content: flex-end; margin-bottom: 4px; }
.aiui-text-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-text-toggle input { margin: 0; accent-color: var(--aiui-accent, LinkText); }
.aiui-text-raw { margin: 0; white-space: pre-wrap; word-break: break-word;
  font: 11px/1.45 var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.aiui-md { font: 13px/1.45 var(--aiui-serif, inherit); }
.aiui-md > :first-child { margin-top: 0; }
.aiui-md > :last-child { margin-bottom: 0; }
.aiui-md p, .aiui-md ul, .aiui-md ol, .aiui-md pre, .aiui-md blockquote, .aiui-md table { margin: 0.4em 0; }
.aiui-md h1, .aiui-md h2, .aiui-md h3, .aiui-md h4 { margin: 0.9em 0 0.3em; font-weight: 700;
  font-size: 1em; font-family: var(--aiui-sans, inherit); letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 65%, transparent)); }
.aiui-md h1 { font-size: 1.05em; }
.aiui-md ul, .aiui-md ol { padding-left: 1.4em; }
.aiui-md li { margin: 0.15em 0; }
.aiui-md code { font: 0.85em var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: color-mix(in srgb, currentColor 7%, transparent); padding: 0 0.3em; }
.aiui-md pre { padding: 0.5em 0.6em; overflow-x: auto;
  border: 1px solid var(--aiui-ghost, color-mix(in srgb, currentColor 15%, transparent)); }
.aiui-md pre code { background: none; padding: 0; }
.aiui-md blockquote { margin-left: 0; padding-left: 0.8em;
  border-left: 2px solid var(--aiui-hairline, color-mix(in srgb, currentColor 30%, transparent));
  color: var(--aiui-ink-muted, inherit); }
.aiui-md table { border-collapse: collapse; }
.aiui-md th, .aiui-md td { padding: 0.15em 0.6em 0.15em 0; text-align: left;
  border-bottom: 1px solid var(--aiui-ghost, color-mix(in srgb, currentColor 15%, transparent)); }
.aiui-md a { color: var(--aiui-accent, LinkText); }
`;

let stylesInjected = false;

function ensureStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.textContent = MARKDOWN_STYLES;
  document.head.append(el);
  stylesInjected = true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One parser for the document: GFM, no raw HTML through. */
const parser = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Markdown to HTML, raw HTML escaped. Exported for a consumer that renders
 * its own container. */
export function renderMarkdown(text: string): string {
  return parser.parse(text, { async: false });
}

export interface TextViewProps {
  text: string;
  /** Start rendered (the default) or raw. The toggle flips it either way. */
  markdown?: boolean;
  class?: string;
}

/** Markdown by default, raw text when unchecked (see the module doc). */
export function TextView(props: TextViewProps): JSX.Element {
  ensureStyles();
  const [rendered, setRendered] = createSignal(props.markdown ?? true);
  return (
    <div class={props.class !== undefined ? `aiui-text ${props.class}` : "aiui-text"}>
      <div class="aiui-text-bar">
        <label class="aiui-text-toggle">
          <input
            type="checkbox"
            checked={rendered()}
            onChange={(e) => setRendered(e.currentTarget.checked)}
          />
          markdown
        </label>
      </div>
      <Show when={rendered()} fallback={<pre class="aiui-text-raw">{props.text}</pre>}>
        <div class="aiui-md" innerHTML={renderMarkdown(props.text)} />
      </Show>
    </div>
  );
}
