import { readFileSync } from "node:fs";

declare const __AIBR_VERSION__: string;
export const VERSION =
  typeof __AIBR_VERSION__ === "string"
    ? __AIBR_VERSION__
    : (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
        .version as string);
