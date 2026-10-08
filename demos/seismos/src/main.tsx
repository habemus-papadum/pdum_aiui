/**
 * main.tsx — the STANDALONE entry: this demo run as its own app (`pnpm dev`
 * from this directory, the full aiui loop alongside `pnpm claude`).
 *
 * Deliberately thin: everything real lives behind ./page (the SitePage the
 * gallery shell also mounts — one page contract, both hosts). The only
 * standalone-specific work is the shared journal chrome the shell would
 * otherwise provide: the stylesheet and the dark-theme stamp.
 */
import { VoiceDock } from "@habemus-papadum/aiui-dock";
import "@habemus-papadum/aiui-journal/styles.css";
import { render } from "@solidjs/web";
import { page } from "./page";

document.title = page.title;
page.activate?.();
// VoiceDock: the oracle and the live session on this page, its tool log,
// and the key field — the pill row in the corner (the gallery shell mounts
// the same one for every page).
render(
  () => (
    <>
      <page.App />
      <VoiceDock />
    </>
  ),
  document.getElementById("root") as HTMLElement,
);
