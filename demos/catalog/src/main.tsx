/**
 * main.tsx — the catalog standalone: the page mounted the way every demo
 * mounts (PageBoundary + VoiceDock). In the gallery the shell mounts `page`
 * instead and imports the design system's stylesheet once for every page.
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
