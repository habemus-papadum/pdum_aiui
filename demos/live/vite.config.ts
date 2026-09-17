import { fileURLToPath } from "node:url";
import { live } from "@habemus-papadum/aiui-live/vite";
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { APP_BLURB } from "./src/live/prompt";

// Four pages, one dev server, and the live BACKEND mounted into it:
//
//  - live() — the session broker (`POST /live/sessions`: the browser's SDP
//    offer is exchanged for an answer with the OPENAI_API_KEY of THIS
//    process; the page never holds the key) and the delegation relay
//    (`WS /live/delegate`) whose server-side delegators are Claude Code
//    (working directory = this demo, so it can read the app's own source),
//    a Responses model with the server's key, and a scripted stand-in.
//  - aiui({ locator: true, devKeys: ["openai"] }) — the source-locator pass
//    (control names are compiler-injected: without it every control() in
//    store.ts throws "needs a name") and the dev-serve key injection, which
//    lets the IN-BROWSER backends (paste-key broker, browser Responses) work
//    with no pasting at all during development.
//  - solid() after aiui(), the usual ordering.
export default defineConfig({
  plugins: [
    live({
      claude: { cwd: fileURLToPath(new URL(".", import.meta.url)) },
      responses: { app: APP_BLURB, effort: "low" },
    }),
    aiui({ locator: true, devKeys: ["openai"] }),
    solid(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        wire: "wire.html",
        backends: "backends.html",
        tour: "tour.html",
      },
    },
  },
});
