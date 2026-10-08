/**
 * main.tsx — the styleguide standalone: the design system's own sheet, mounted
 * the way every demo mounts (PageBoundary + VoiceDock), so the chrome the
 * dock brings is exhibited on the sheet too. In the gallery the shell mounts
 * `page` instead and imports the stylesheet once for every page.
 */
import "@habemus-papadum/aiui-design/site.css";
import { VoiceDock } from "@habemus-papadum/aiui-dock";
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { page } from "./page";

document.title = page.title;
page.activate?.();
render(
  () => (
    <PageBoundary name={page.title}>
      <page.App />
      <VoiceDock />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
