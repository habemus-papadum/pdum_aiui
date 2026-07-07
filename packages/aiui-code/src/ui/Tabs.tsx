/**
 * Tabs.tsx — the open-files strip / history of what you've visited. Click to
 * switch back to a file (no history push — it's a lateral move).
 */
import { For, Show } from "solid-js";
import { reader } from "../model/store";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function Tabs() {
  return (
    <Show when={reader.openFiles().length > 0}>
      <div class="tabs">
        <For each={reader.openFiles()}>
          {(file) => (
            <button
              type="button"
              class={reader.currentFile() === file ? "tab tab-active" : "tab"}
              title={file}
              onClick={() => reader.openFile(file, { pushHistory: false })}
            >
              {basename(file)}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
