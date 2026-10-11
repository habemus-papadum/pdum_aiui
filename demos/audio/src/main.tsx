import "@habemus-papadum/aiui-design/site.css";
import { AudioProvider } from "@habemus-papadum/aiui-audio/widgets";
import { VoiceDock } from "@habemus-papadum/aiui-dock";
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { fallbackAudio } from "./model/store";
import { page } from "./page";

document.title = page.title;
page.activate?.();
// PageBoundary: an uncaught effect throw would otherwise halt the page's
// whole reactive system (Solid 2.0 semantics) — contained, it renders a
// fault card with a reset instead. Same seam a multi-app shell uses.
// VoiceDock: the pill row in the corner — talk to this app through the oracle
// or a live session (the dev server's OpenAI key, else one you paste), open
// its tool log ("was my agent actually calling the tools?"), all on the page.
render(
  () => (
    <AudioProvider hub={fallbackAudio()}>
      <PageBoundary name={page.title}>
        <page.App />
        <VoiceDock />
      </PageBoundary>
    </AudioProvider>
  ),
  document.getElementById("root") as HTMLElement,
);
