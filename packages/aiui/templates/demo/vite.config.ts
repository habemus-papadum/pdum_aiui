import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";

// This one plugin is the entire aiui integration — the part to copy into your
// own app. It mounts the intent tool into every served page, declares the
// message format the tool speaks, and bridges the channel port from
// `aiui vite` (VITE_AIUI_PORT in this dev server's env) plus this app's source
// root into the browser.
//
// `locator` turns on compile-time source stamping: every host JSX element gets
// data-source-loc = "src/…:line:col", and `cell()` call sites get their
// `{ name, loc }` identity injected — so anything you build here is legible to
// an agent (the `locate` tool) out of the box. It needs @babel/core (an
// optional peer, provided as a devDependency of this sandbox).
export default defineConfig({
  plugins: [aiuiDevOverlay({ format: "text-concat", locator: { cellFactories: ["cell"] } })],
});
