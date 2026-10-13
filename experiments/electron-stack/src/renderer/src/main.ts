import "../../shared/contracts.ts";
import "./style.css";

const listeners = new AbortController();
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing element: ${selector}`);
  return result;
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-backend]")) {
  button.addEventListener(
    "click",
    async () => {
      const output = button.parentElement?.querySelector("pre");
      if (!output) return;
      button.disabled = true;
      try {
        const response = await fetch(`./api/${button.dataset.backend}/info`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        output.textContent = JSON.stringify(await response.json(), null, 2);
      } catch (error) {
        output.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    },
    { signal: listeners.signal },
  );
}
const bridge = window.desktopAPI;
if (bridge) {
  element("#desktop").hidden = false;
  element("#hide").hidden = false;
  const output = element("#desktop-result");
  void bridge.info().then((info) => {
    output.textContent = JSON.stringify(info, null, 2);
  });
  element("#choose-file").addEventListener(
    "click",
    async () => {
      output.textContent = (await bridge.chooseFile()) ?? "Cancelled";
    },
    { signal: listeners.signal },
  );
  let pinned = true;
  element("#pin").addEventListener(
    "click",
    async () => {
      pinned = await bridge.setAlwaysOnTop(!pinned);
      output.textContent = `Always on top: ${pinned}`;
    },
    { signal: listeners.signal },
  );
  element("#hide").addEventListener(
    "click",
    () => {
      void bridge.hide();
    },
    { signal: listeners.signal },
  );
}
if (window.require) {
  element("#node-direct").hidden = false;
  element("#node-result").textContent = `Node reports: ${window.require("node:os").platform()}`;
}
void fetch("./api/runtime")
  .then((response) => response.json())
  .then((data) => {
    element("#runtime").textContent = `Instance ${data.instance} · backend owner PID ${data.pid}`;
  })
  .catch(() => {
    element("#runtime").textContent = "Backend unavailable";
  });
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => listeners.abort());
}
