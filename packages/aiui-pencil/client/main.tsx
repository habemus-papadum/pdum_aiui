/**
 * main.tsx — the SERVED remote-pencil client (`GET /pencil/` on every
 * channel): the kit's paved-road composition, nothing else. Per-application
 * differences arrive as the joined session's `RemotePresentation` — see
 * `src/client/` (the kit) and protocol.ts. An app that needs full control
 * composes its own page from the same kit instead of forking this one.
 */

import { PencilRemoteApp } from "@habemus-papadum/aiui-pencil/client";
import { render } from "@solidjs/web";

const root = document.getElementById("root");
if (root) {
  render(() => <PencilRemoteApp />, root);
}
