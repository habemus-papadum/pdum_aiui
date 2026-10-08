/**
 * tool-log.tsx — the on-page tool log: "was my agent actually calling the
 * tools, and what did it see?"
 *
 * Hidden by default. Opens on `location.hash === "#aiui-tools"` or through
 * {@link toggleToolLog}; the app decides where it mounts and what key opens
 * it. Three views over the page's own registry (`window.__AIUI__.tools`):
 *
 *  - **calls** — the registry's call log, live: who called what (`channel`,
 *    `oracle`, `live:claude`, `page`…, each with its glyph), with what, how
 *    long it took, and the result or error — args and results as a folding
 *    JSON explorer, not a line of text;
 *  - **inventory** — every registered kit, its brief, and each tool's class,
 *    description, and usage, laid out to be read;
 *  - **as rendered** — what a model sees: the `Tools:` section
 *    (`renderToolBrief`, the same function the oracle and the live delegators
 *    call) as Markdown with a raw toggle, and the structured form
 *    `page_tools_list` returns.
 *
 * Its own subpath (`@habemus-papadum/aiui-viz/site/tool-log`) so pages that
 * never open it pay nothing. It is shipped chrome: its inline panel and one
 * injected stylesheet read the `--aiui-*` hooks a design system sets, with
 * the dark panel it always had as the fallback; a consumer restyles through
 * the hooks or the `.aiui-toollog-*` classes.
 */
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { type AiuiToolCall, type AiuiToolsRegistry, ensureAiuiGlobal } from "../aiui-global";
import { type KitDoc, renderToolBrief } from "../tool-brief";
import { JsonView } from "./json-view";
import { TextView } from "./markdown";

/** The hash that opens the log on load (`…/page#aiui-tools`). */
export const TOOL_LOG_HASH = "#aiui-tools";

type View = "calls" | "inventory" | "rendered";

// One log per page: module-level, like `pathname()` — every mounted ToolLog
// (there should be one) and `toggleToolLog` share it.
const [isOpen, setOpen] = createSignal(false);

/** Open (true), close (false), or flip (omitted) the log. */
export function toggleToolLog(open?: boolean): void {
  setOpen(open ?? !isOpen());
}

/** The document a model reads, built from the live registry. */
function kitDocs(registry: AiuiToolsRegistry | undefined): KitDoc[] {
  return (registry?.list() ?? []).map((ns) => ({
    ns: ns.ns,
    ...(ns.brief !== undefined ? { brief: ns.brief } : {}),
    tools: ns.tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
      ...(t.kind !== undefined ? { kind: t.kind } : {}),
    })),
  }));
}

/** The `page_tools_list` shape (descriptors only — never functions). */
function listing(registry: AiuiToolsRegistry | undefined): unknown {
  return (registry?.list() ?? []).map((ns) => ({
    ns: ns.ns,
    active: ns.active,
    ...(ns.brief !== undefined ? { brief: ns.brief } : {}),
    tools: ns.tools.map(({ run: _run, ...descriptor }) => descriptor),
  }));
}

/** The glyph for a caller the log knows; a transport's own `icon` wins. */
const GLYPHS: Array<[RegExp, string]> = [
  [/^channel$/, "🤖"],
  [/^oracle$/, "🔮"],
  [/^live(:|$)/, "🎙"],
  [/^panel$/, "✳"],
  [/^page$/, "📄"],
];

export function callerGlyph(call: Pick<AiuiToolCall, "caller" | "icon">): string {
  if (call.icon !== undefined) return call.icon;
  return GLYPHS.find(([re]) => re.test(call.caller))?.[1] ?? "·";
}

// Shipped chrome: every color and face reads a prefixed `--aiui-*` hook with a
// neutral fallback (the dark panel the log always had), so it is of a piece
// with a page that sets the hooks and unchanged on any other page.
const PANEL: JSX.CSSProperties = {
  position: "fixed",
  right: "8px",
  bottom: "8px",
  "z-index": 2147483000,
  width: "min(760px, calc(100vw - 16px))",
  "max-height": "64vh",
  overflow: "auto",
  font: "11px/1.45 var(--aiui-sans, ui-sans-serif, system-ui, sans-serif)",
  background: "var(--aiui-surface-raised, rgba(20, 20, 24, 0.96))",
  color: "var(--aiui-ink, #e6e6ea)",
  border: "1px solid var(--aiui-hairline, #444)",
  "border-radius": "var(--aiui-radius, 6px)",
  padding: "8px 10px 10px",
  "box-sizing": "border-box",
};

/** The rules inline styles cannot carry, injected once per document by the
 * first mounted log. */
const TOOL_LOG_STYLES = `
.aiui-toollog-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.aiui-toollog-bar .aiui-toollog-close { margin-left: auto; }
.aiui-toollog-tab, .aiui-toollog-close { background: transparent; color: inherit; cursor: pointer;
  border: 1px solid var(--aiui-hairline, #444); border-radius: var(--aiui-radius, 4px);
  padding: 1px 8px; font: inherit; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.aiui-toollog-tab[aria-pressed="true"] { background: var(--aiui-ink, #e6e6ea);
  color: var(--aiui-surface, #141418); border-color: var(--aiui-ink, #e6e6ea); }
.aiui-toollog-empty { color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent));
  padding: 6px 0; }
/* a host's own table rules (a design system sizes tables for prose) stop here */
.aiui-toollog table { margin: 0; font: inherit; }
.aiui-toollog-calls { width: 100%; border-collapse: collapse; table-layout: fixed; }
.aiui-toollog-calls th { text-align: left; font-weight: 400; font-size: 9.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--aiui-muted, color-mix(in srgb, currentColor 65%, transparent));
  padding: 2px 8px 3px 0; border-bottom: 1px solid var(--aiui-hairline, #444); }
.aiui-toollog-calls td { padding: 4px 8px 4px 0; vertical-align: top; font-size: 11px;
  border-bottom: 1px solid var(--aiui-ghost, color-mix(in srgb, currentColor 15%, transparent)); }
.aiui-toollog-calls th:nth-child(1), .aiui-toollog-calls td:nth-child(1) { width: 2.2em;
  font-variant-numeric: tabular-nums; color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-toollog-calls th:nth-child(2), .aiui-toollog-calls td:nth-child(2) { width: 9em; }
.aiui-toollog-calls th:nth-child(3), .aiui-toollog-calls td:nth-child(3) { width: 13em; }
.aiui-toollog-calls th:nth-child(5), .aiui-toollog-calls td:nth-child(5) { width: 3.5em; text-align: right;
  font-variant-numeric: tabular-nums; }
.aiui-toollog-tool { font: 11px var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere; }
.aiui-toollog-glyph { display: inline-block; width: 1.4em; }
.aiui-toollog-ref { display: block; font-size: 9.5px; word-break: break-all;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-toollog-error { color: var(--aiui-alarm, #f87171);
  font: 11px var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace); white-space: pre-wrap; }
.aiui-toollog-kit { margin: 0 0 10px; }
.aiui-toollog-kit-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 4px;
  padding-bottom: 3px; border-bottom: 1px solid var(--aiui-hairline, #444); }
.aiui-toollog-kit-ns { font: 11px var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.aiui-toollog-kit-state { font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-toollog-kit-brief { margin: 2px 0 6px; font: 12px/1.4 var(--aiui-serif, inherit);
  color: var(--aiui-ink-muted, inherit); }
.aiui-toollog-item { display: grid; grid-template-columns: 11em minmax(0, 1fr); gap: 2px 10px;
  padding: 4px 0; border-bottom: 1px solid var(--aiui-ghost, color-mix(in srgb, currentColor 12%, transparent)); }
.aiui-toollog-item-name { font: 11px var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-word; }
.aiui-toollog-item-kind { display: inline-block; margin-left: 6px; font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase; padding: 0 4px; border-radius: 999px;
  border: 1px solid var(--aiui-hairline, #444);
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-toollog-item-desc { font: 12px/1.4 var(--aiui-serif, inherit); }
.aiui-toollog-item-usage { grid-column: 2; font-size: 10.5px; line-height: 1.4; white-space: pre-wrap;
  color: var(--aiui-ink-muted, inherit); }
.aiui-toollog-section { margin: 10px 0 4px; font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 65%, transparent)); }
@media (max-width: 640px) {
  /* a phone: the calls table keeps its columns and the panel scrolls sideways,
     rather than crushing args and results into one-character columns */
  .aiui-toollog-calls { min-width: 640px; }
  .aiui-toollog-item { grid-template-columns: minmax(0, 1fr); }
  .aiui-toollog-item-usage { grid-column: 1; }
}
`;
let stylesInjected = false;

export interface ToolLogProps {
  class?: string;
}

/** The log. Mount once per page; see the module doc for how it opens. */
export function ToolLog(props: ToolLogProps): JSX.Element {
  const registry = (): AiuiToolsRegistry | undefined => ensureAiuiGlobal()?.tools;
  const [view, setView] = createSignal<View>("calls");
  const [calls, setCalls] = createSignal<AiuiToolCall[]>([]);
  const [version, setVersion] = createSignal(0);

  if (typeof location !== "undefined" && location.hash === TOOL_LOG_HASH) setOpen(true);
  const onHash = (): void => {
    if (location.hash === TOOL_LOG_HASH) setOpen(true);
  };
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));

  // Subscribe only while open: a closed log costs nothing. The handler's
  // return is the cleanup (Solid 2: cleanup = effect RETURN).
  createEffect(
    () => isOpen(),
    (open) => {
      if (!open) return;
      const r = registry();
      if (r === undefined) return;
      setCalls(r.calls?.() ?? []);
      const offCall = r.onCall?.((call) => setCalls((prev) => [...prev.slice(-199), call]));
      const offChange = r.onChange(() => setVersion((v) => v + 1));
      return () => {
        offCall?.();
        offChange();
      };
    },
  );

  const docs = (): KitDoc[] => {
    version();
    return kitDocs(registry());
  };
  const parked = (ns: string): boolean => {
    version();
    return (
      registry()
        ?.list()
        .find((k) => k.ns === ns)?.active === false
    );
  };

  const tab = (v: View, label: string): JSX.Element => (
    <button
      type="button"
      class="aiui-toollog-tab"
      aria-pressed={view() === v ? "true" : "false"}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  );

  const injectStyles = !stylesInjected;
  stylesInjected = true;

  return (
    <Show when={isOpen()}>
      {injectStyles ? <style>{TOOL_LOG_STYLES}</style> : null}
      <aside
        class={`aiui-toollog${props.class !== undefined ? ` ${props.class}` : ""}`}
        style={PANEL}
        aria-label="aiui tool log"
        data-aiui-chrome=""
      >
        <div class="aiui-toollog-bar">
          {tab("calls", `calls (${calls().length})`)}
          {tab("inventory", "inventory")}
          {tab("rendered", "as rendered")}
          <button type="button" class="aiui-toollog-close" onClick={() => setOpen(false)}>
            close
          </button>
        </div>

        <Show when={view() === "calls"}>
          <Show
            when={calls().length > 0}
            fallback={<div class="aiui-toollog-empty">no calls yet on this page</div>}
          >
            <table class="aiui-toollog-calls">
              <thead>
                <tr>
                  <th>#</th>
                  <th>caller</th>
                  <th>tool</th>
                  <th>args</th>
                  <th>ms</th>
                  <th>result</th>
                </tr>
              </thead>
              <tbody>
                <For each={[...calls()].reverse()}>
                  {(c) => (
                    <tr data-ok={String(c.ok)} class="aiui-toollog-call">
                      <td>{c.seq}</td>
                      <td>
                        <span class="aiui-toollog-glyph" aria-hidden="true">
                          {callerGlyph(c)}
                        </span>
                        {c.caller}
                        <Show when={c.ref}>
                          {(ref) => <span class="aiui-toollog-ref">{ref()}</span>}
                        </Show>
                      </td>
                      <td class="aiui-toollog-tool">
                        {c.ns}/{c.tool}
                      </td>
                      <td>
                        <Show
                          when={c.args !== undefined}
                          fallback={<span class="aiui-toollog-empty">—</span>}
                        >
                          <JsonView value={c.args} />
                        </Show>
                      </td>
                      <td>{c.ms}</td>
                      <td>
                        <Show
                          when={c.ok}
                          fallback={<span class="aiui-toollog-error">✗ {c.error ?? ""}</span>}
                        >
                          <Show
                            when={c.result !== undefined}
                            fallback={<span class="aiui-toollog-empty">—</span>}
                          >
                            <JsonView value={c.result} />
                          </Show>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>

        <Show when={view() === "inventory"}>
          <Show
            when={docs().length > 0}
            fallback={<div class="aiui-toollog-empty">no kits registered on this page</div>}
          >
            <For each={docs()}>
              {(kit) => (
                <section class="aiui-toollog-kit">
                  <div class="aiui-toollog-kit-head">
                    <span class="aiui-toollog-kit-ns">{kit.ns}</span>
                    <span class="aiui-toollog-kit-state">
                      {parked(kit.ns) ? "parked" : "active"} · {kit.tools.length} tools
                    </span>
                  </div>
                  <Show when={kit.brief}>
                    {(brief) => <p class="aiui-toollog-kit-brief">{brief()}</p>}
                  </Show>
                  <For each={kit.tools}>
                    {(t) => (
                      <div class="aiui-toollog-item">
                        <div class="aiui-toollog-item-name">
                          {t.name}
                          <Show when={t.kind}>
                            {(kind) => <span class="aiui-toollog-item-kind">{kind()}</span>}
                          </Show>
                        </div>
                        <div class="aiui-toollog-item-desc">{t.description}</div>
                        <Show when={t.usage}>
                          {(usage) => <div class="aiui-toollog-item-usage">{usage()}</div>}
                        </Show>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </Show>
        </Show>

        <Show when={view() === "rendered"}>
          <div class="aiui-toollog-section">the Tools: section, as a model reads it</div>
          <TextView text={renderToolBrief(docs())} class="aiui-toollog-brief" />
          <div class="aiui-toollog-section">the structured form (page_tools_list)</div>
          <JsonView value={listing(registry())} depth={2} class="aiui-toollog-listing" />
        </Show>
      </aside>
    </Show>
  );
}
