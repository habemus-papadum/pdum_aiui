/**
 * tool-log.tsx — the on-page tool log: "was my agent actually calling the
 * tools, and what did it see?"
 *
 * Hidden by default. Opens on `location.hash === "#aiui-tools"` or through
 * {@link toggleToolLog}; the app decides where it mounts and what key opens
 * it. Three views over the page's own registry (`window.__AIUI__.tools`):
 *
 *  - **calls** — the registry's call log, live: who called what (`channel`,
 *    `oracle`, `live:claude`, `page`…), with what, how long it took, and the
 *    result or error;
 *  - **inventory** — `ledger()`: every registered tool with its class and usage;
 *  - **as rendered** — what a model sees: the `Tools:` section
 *    (`renderToolBrief`, the same function the oracle and the live delegators
 *    call) and the structured form `page_tools_list` returns.
 *
 * Its own subpath (`@habemus-papadum/aiui-viz/site/tool-log`) so pages that
 * never open it pay nothing. Styling is the consumer's (`.aiui-toollog-*`);
 * the few inline styles only make it usable with no CSS at all.
 */
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { type AiuiToolCall, type AiuiToolsRegistry, ensureAiuiGlobal } from "../aiui-global";
import { type KitDoc, renderToolBrief } from "../tool-brief";

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

function short(value: unknown): string {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return String(value);
  }
}

const PANEL: JSX.CSSProperties = {
  position: "fixed",
  right: "8px",
  bottom: "8px",
  "z-index": 2147483000,
  "max-width": "min(720px, calc(100vw - 16px))",
  "max-height": "60vh",
  overflow: "auto",
  font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
  background: "rgba(20, 20, 24, 0.96)",
  color: "#e6e6ea",
  border: "1px solid #444",
  "border-radius": "6px",
  padding: "8px",
};

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
  const rows = (): Array<{ ns: string; tool: string; kind?: string; usage?: string }> => {
    version();
    return registry()?.ledger() ?? [];
  };

  const tab = (v: View, label: string): JSX.Element => (
    <button
      type="button"
      class="aiui-toollog-tab"
      aria-pressed={view() === v ? "true" : "false"}
      onClick={() => setView(v)}
      style={{ "margin-right": "6px", font: "inherit" }}
    >
      {label}
    </button>
  );

  return (
    <Show when={isOpen()}>
      <aside
        class={`aiui-toollog${props.class !== undefined ? ` ${props.class}` : ""}`}
        style={PANEL}
        aria-label="aiui tool log"
      >
        <div class="aiui-toollog-bar" style={{ "margin-bottom": "6px" }}>
          {tab("calls", `calls (${calls().length})`)}
          {tab("inventory", "inventory")}
          {tab("rendered", "as rendered")}
          <button
            type="button"
            class="aiui-toollog-close"
            onClick={() => setOpen(false)}
            style={{ float: "right", font: "inherit" }}
          >
            close
          </button>
        </div>
        <Show when={view() === "calls"}>
          <table class="aiui-toollog-calls" style={{ "border-collapse": "collapse" }}>
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
                      {c.caller}
                      {c.ref !== undefined ? ` (${c.ref})` : ""}
                    </td>
                    <td>
                      {c.ns}/{c.tool}
                    </td>
                    <td>{short(c.args)}</td>
                    <td>{c.ms}</td>
                    <td>{c.ok ? short(c.result) : `✗ ${c.error ?? ""}`}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <Show when={view() === "inventory"}>
          <table class="aiui-toollog-inventory" style={{ "border-collapse": "collapse" }}>
            <thead>
              <tr>
                <th>ns</th>
                <th>tool</th>
                <th>kind</th>
                <th>usage</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr>
                    <td>{r.ns}</td>
                    <td>{r.tool}</td>
                    <td>{r.kind ?? ""}</td>
                    <td>{r.usage ?? ""}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
        <Show when={view() === "rendered"}>
          <pre class="aiui-toollog-brief" style={{ "white-space": "pre-wrap" }}>
            {renderToolBrief(docs())}
          </pre>
          <pre class="aiui-toollog-listing" style={{ "white-space": "pre-wrap" }}>
            {JSON.stringify(listing(registry()), null, 2)}
          </pre>
        </Show>
      </aside>
    </Show>
  );
}
