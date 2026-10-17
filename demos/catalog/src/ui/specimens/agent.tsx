/**
 * agent.tsx — the section specimen for shelf 4: the tools this page has
 * registered, live from the registry, and where to look for the stamps.
 */
import { ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup } from "solid-js";
import { appScope } from "../../model/store";

export function ToolsSpecimen(): JSX.Element {
  const registry = ensureAiuiGlobal()?.tools;
  const [tick, setTick] = createSignal(0);
  const off = registry?.onChange(() => setTick((t) => t + 1));
  onCleanup(() => off?.());
  const tools = () => {
    tick();
    return registry?.list().find((ns) => ns.ns === appScope.name)?.tools ?? [];
  };
  return (
    <>
      <p class="cat-note cat-note-lead">
        <b>This page's tools, as registered right now</b> — derived from five controls, two cells
        and one action in <code>model/</code>, nothing hand-written:
      </p>
      <div class="cat-table">
        <table class="cat-tools">
          <thead>
            <tr>
              <th>tool</th>
              <th>kind</th>
              <th>group</th>
              <th>description</th>
            </tr>
          </thead>
          <tbody>
            <For each={tools()}>
              {(t) => (
                <tr>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td>{t.kind ?? "—"}</td>
                  <td>{t.group ?? "—"}</td>
                  <td class="cat-tools-desc">{t.description}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <p class="cat-note">
        <b>The stamps</b> are on this page too: hover anything inside a live specimen and the bar at
        the foot of the window lists the attributes the element carries — the ones{" "}
        <code>locate</code>, <code>selection</code> and <code>read-page</code> resolve.
      </p>
    </>
  );
}
