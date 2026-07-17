/**
 * The public surface of `@habemus-papadum/aiui-console`: the channel console
 * sidecar. The browser app under `app/` is a build artifact (`assets/app`),
 * not part of this entry — it is served by the sidecar, never imported.
 */

export { CONSOLE_PREFIX, consoleSidecar } from "./sidecar";
