/**
 * main.tsx — the STANDALONE entry: this demo run as its own app (`pnpm dev`
 * here, the full aiui loop alongside `pnpm claude`). Everything real lives
 * behind ./page; the only standalone-specific work is the shared journal
 * chrome the gallery shell would otherwise provide.
 */
import "@habemus-papadum/aiui-journal/styles.css";
import { render } from "@solidjs/web";
import { page } from "./page";

document.title = page.title;
page.activate?.();
render(() => <page.App />, document.getElementById("root") as HTMLElement);
