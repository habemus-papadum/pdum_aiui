import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "crxjs-smoke (spike)",
  version: "0.0.1",
  description: "M5: CRXJS content-script HMR with SolidJS 2.0 beta + overlay source import",
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content.tsx"],
    },
  ],
});
