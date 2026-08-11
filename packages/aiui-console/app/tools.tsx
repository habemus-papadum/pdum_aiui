/**
 * The page-tools ledger — the CHANNEL's view of every registered namespace
 * (the page-tools design notes, step 3 — git history). This is what the
 * agent's `page_tools_list` actually sees: registrations with their activity
 * bits and shadow marks, one row per (registration, tool). The page-side twin is
 * `window.__AIUI__.tools.ledger()` in the app's own console; when the two
 * disagree, THIS one is the truth the agent acts on.
 *
 * Polled, not pushed: the ledger is a debugging surface, 2s staleness is
 * fine, and polling keeps it dependency-free (same posture as the dashboard).
 */

import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { fetchPageTools, type PageToolRegistrationInfo } from "./api";
import { CONSOLE_HOME_PATH } from "./routes";
import "./styles.css";

const POLL_MS = 2000;

/** One registration flattened to rows the table renders. */
interface LedgerRow {
  ns: string;
  tool: string;
  description: string;
  active: boolean;
  activeTab: boolean;
  shadowed: boolean;
  page: string;
  clientId: string;
}

function rows(registrations: PageToolRegistrationInfo[]): LedgerRow[] {
  return registrations.flatMap((reg) =>
    (reg.tools ?? []).map((tool) => ({
      ns: reg.ns ?? "?",
      tool: tool.name ?? "?",
      description: tool.description ?? "",
      active: reg.active !== false,
      activeTab: reg.activeTab === true,
      shadowed: reg.shadowed === true,
      page: reg.tab?.title ?? reg.url ?? reg.tab?.url ?? "",
      clientId: reg.clientId ?? "",
    })),
  );
}

export function ToolsPage(): JSX.Element {
  const [regs, setRegs] = createSignal<PageToolRegistrationInfo[] | undefined>(undefined, {
    ownedWrite: true,
  });
  const refresh = (): void => {
    void fetchPageTools().then((got) => setRegs(got?.registrations ?? []));
  };
  refresh();
  const timer = setInterval(refresh, POLL_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <main class="dashboard">
      <header class="masthead">
        <h1>page tools</h1>
        <p class="tagline">
          the channel's ledger — what <code>page_tools_list</code> serves the agent.{" "}
          <a href={CONSOLE_HOME_PATH}>← console</a>
        </p>
      </header>
      <Show when={regs() !== undefined}>
        <Show
          when={(regs()?.length ?? 0) > 0}
          fallback={<p class="muted">No page has registered tools on this channel.</p>}
        >
          <section class="section">
            <table class="ledger">
              <thead>
                <tr>
                  <th>namespace</th>
                  <th>tool</th>
                  <th>description</th>
                  <th>state</th>
                  <th>page</th>
                  <th>client</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows(regs() ?? [])}>
                  {(row) => (
                    <tr class={row.shadowed ? "ledger-shadowed" : undefined}>
                      <td>
                        <code>{row.ns}</code>
                      </td>
                      <td>
                        <code>{row.tool}</code>
                      </td>
                      <td class="ledger-desc">{row.description}</td>
                      <td>
                        {row.shadowed ? "shadowed" : row.active ? "active" : "parked"}
                        {row.activeTab ? " · in view" : ""}
                      </td>
                      <td class="ledger-desc">{row.page || "—"}</td>
                      <td>
                        <code>{row.clientId.slice(0, 8)}</code>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </section>
        </Show>
      </Show>
    </main>
  );
}
