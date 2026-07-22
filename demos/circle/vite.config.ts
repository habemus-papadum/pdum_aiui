import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The standard demo config: aiui() (the source-locator compiler pass — JSX
// data-source-loc stamps + cell()/control() identity injection) BEFORE solid()
// so the locator's `pre` babel pass sees JSX first. The gallery compiles this
// demo's source through its own identical plugin set; this file serves the
// standalone `pnpm dev` loop.
export default defineConfig({
  plugins: [aiui(), solid()],
});
