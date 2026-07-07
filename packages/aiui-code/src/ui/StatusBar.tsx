/**
 * StatusBar.tsx — the coarse reader state in one strip: LSP status, cursor
 * position, diagnostic counts, jump-back/forward. Everything here reads a
 * durable signal — none of Monaco's per-keystroke internals.
 */
import { For, Show } from "solid-js";
import { reader } from "../model/store";
import { monaco } from "../monaco/monaco";

export function StatusBar() {
  const diagCounts = () => {
    const file = reader.currentFile();
    reader.diagnosticsVersion(); // subscribe
    if (!file) return { errors: 0, warnings: 0 };
    let errors = 0;
    let warnings = 0;
    for (const m of reader.diagnosticsFor(file)) {
      if (m.severity === monaco.MarkerSeverity.Error) errors++;
      else if (m.severity === monaco.MarkerSeverity.Warning) warnings++;
    }
    return { errors, warnings };
  };
  const cursor = () => {
    const c = reader.cursor();
    return c ? `Ln ${c.line + 1}, Col ${c.character + 1}` : "";
  };
  return (
    <div class="status-bar">
      <div class="status-left">
        <button
          type="button"
          class="status-btn"
          disabled={!reader.canBack()}
          title="Jump back"
          onClick={() => reader.back()}
        >
          ←
        </button>
        <button
          type="button"
          class="status-btn"
          disabled={!reader.canForward()}
          title="Jump forward"
          onClick={() => reader.forward()}
        >
          →
        </button>
        {/* One chip per configured language server, from the project manifest;
            the current file's language is highlighted. */}
        <Show
          when={reader.servers().length > 0}
          fallback={<span class="status-item status-dim">no language server</span>}
        >
          <For each={reader.servers()}>
            {(s) => (
              <span
                class={
                  s.languageId === reader.currentLanguageId()
                    ? "lsp-chip lsp-chip-active"
                    : "lsp-chip"
                }
                title={`${s.name ?? s.language} — ${s.status}${s.verified ? " · verified" : ""}`}
              >
                <span class={`lsp-dot lsp-${s.status}`} />
                {s.language}
              </span>
            )}
          </For>
        </Show>
      </div>
      <div class="status-right">
        <Show when={diagCounts().errors > 0}>
          <span class="status-item diag-error">⨯ {diagCounts().errors}</span>
        </Show>
        <Show when={diagCounts().warnings > 0}>
          <span class="status-item diag-warn">⚠ {diagCounts().warnings}</span>
        </Show>
        <span class="status-item">{cursor()}</span>
      </div>
    </div>
  );
}
