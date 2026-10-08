import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The standard demo config: aiui() (the source-locator compiler pass — JSX
// data-source-loc stamps + cell()/control() identity injection) BEFORE solid()
// so the locator's `pre` babel pass sees JSX first. The gallery compiles this
// demo's source through its own identical plugin set; this file serves the
// standalone `pnpm dev` loop.
export default defineConfig({
  // devKeys: the dev server injects the OpenAI key for the page's voice dock
  // (dev serve only; a production bundle cannot contain it).
  plugins: [aiui({ devKeys: ["openai"] }), solid()],
});
