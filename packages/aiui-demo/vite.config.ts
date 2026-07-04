import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";

// This one plugin is the entire aiui integration — the part to copy into your
// own app. It mounts the intent tool into every served page, declares the
// message format the tool speaks, and bridges the channel port from
// `aiui vite` (VITE_AIUI_PORT in this dev server's env) plus this app's source
// root into the browser. Why the port can't just be read from import.meta.env
// inside the overlay: see the overlay package's src/vite.ts for the subtlety.
export default defineConfig({
  plugins: [aiuiDevOverlay({ format: "text-concat" })],
});
