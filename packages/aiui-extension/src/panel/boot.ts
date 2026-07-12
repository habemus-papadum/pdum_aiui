/**
 * The panel's boot watchdog — "fail loudly, never blankly".
 *
 * Every dev-loop failure this extension has had degraded to the same symptom:
 * **a blank side panel with no error anywhere**. A stale dev artifact renders
 * last week's tree. A missing dev server renders nothing. A throw during the
 * Solid render (Solid 2.0's `createEffect` arity, say) leaves `#root` empty and
 * the exception in a console nobody had open. All three are invisible, and each
 * one cost hours.
 *
 * So the panel checks itself, in the panel, where the user is looking:
 *
 *  - **stale / server-down** (dev builds only, via the kit's dev stamp): a slim
 *    banner ABOVE the app — the app may well have rendered, it is just rendering
 *    the wrong code, which is precisely the lie we need to break.
 *  - **nothing rendered**: after a grace period `#root` is still empty → a full
 *    banner naming the captured exception.
 *
 * Both carry a **Reload extension** button (`chrome.runtime.reload()` — the only
 * thing that makes Chrome re-read an unpacked extension's directory).
 *
 * Loaded from index.html BEFORE main.tsx, so its error listeners are installed
 * before any app code runs. It touches nothing the app owns: its own container,
 * its own listeners, no imports from the panel's modules.
 */
import { checkDevBuild, type DevBuildState } from "@habemus-papadum/aiui-webext";

export interface BootWatchdogOptions {
  /** How long the app gets to put *something* in #root before we call it blank. */
  graceMs?: number;
  /** Which build are we running? (Injectable for tests.) */
  check?: () => Promise<DevBuildState>;
  /** What the banner's button does. */
  reload?: () => void;
}

/**
 * Install the watchdog. Returns nothing: everything it does is visible in the
 * document, which is the whole point.
 */
export function installBootWatchdog(options: BootWatchdogOptions = {}): void {
  const graceMs = options.graceMs ?? 3000;
  const check = options.check ?? checkDevBuild;
  const reload = options.reload ?? (() => chrome.runtime.reload());
  const errors: string[] = [];

  window.addEventListener("error", (event) => {
    errors.push(event.error instanceof Error ? formatError(event.error) : String(event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    errors.push(
      event.reason instanceof Error
        ? formatError(event.reason)
        : `unhandled rejection: ${String(event.reason)}`,
    );
  });

  // 1. Which build are we? (A production build answers "production" — nothing
  //    to say, and nothing that can go stale.)
  void check().then((state) => {
    if (state.kind === "stale") {
      banner(
        reload,
        "STALE dev build — you are looking at old code",
        `This extension was loaded from dev-server run ${state.stamp.runId}, but ` +
          `${state.stamp.origin} is now serving run ${state.serving.runId}. Chrome is still ` +
          "holding the previous run's files.",
        "or: aiui extension reload",
      );
    } else if (state.kind === "server-down") {
      banner(
        reload,
        `dev server unreachable at ${state.stamp.origin}`,
        "This is a dev build: every surface (panel, content script, service worker) is loaded " +
          "from that server. Nothing will work until it is back.",
        "start it: aiui extension dev",
      );
    }
  });

  // 2. Did the app render? A blank panel is never an acceptable answer.
  setTimeout(() => {
    const root = document.getElementById("root");
    if (root && root.childElementCount > 0) {
      return;
    }
    banner(
      reload,
      "the panel did not render",
      errors.length
        ? errors.join("\n\n")
        : "No exception reached this page — the panel's entry module probably never ran " +
            "(a partial dev artifact, or a dev server that died mid-load). Check the panel's " +
            "console (right-click → Inspect) and the dev server's terminal.",
      "then: aiui extension reload",
    );
  }, graceMs);
}

function formatError(error: Error): string {
  return error.stack?.split("\n").slice(0, 4).join("\n") ?? `${error.name}: ${error.message}`;
}

/** The banner host — created lazily, always the first child of <body>. */
export const BANNER_ID = "aiui-boot-banner";

function banner(reload: () => void, title: string, detail: string, hint: string): void {
  const el = document.getElementById(BANNER_ID) ?? document.createElement("div");
  if (!el.id) {
    el.id = BANNER_ID;
    el.style.cssText =
      "position:relative;z-index:2147483647;margin:0 0 0.5rem;padding:0.5rem 0.625rem;" +
      "border-radius:0.375rem;font:0.75rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "background:#3a1d1d;color:#ffd7d7;border:1px solid #7a3a3a;white-space:pre-wrap;" +
      "overflow-wrap:anywhere";
    document.body.prepend(el);
  }
  el.textContent = "";

  const head = document.createElement("div");
  head.style.cssText = "font-weight:600;margin-bottom:0.25rem";
  head.textContent = `aiui: ${title}`;
  el.append(head);

  const body = document.createElement("div");
  body.style.cssText = "opacity:0.85;margin-bottom:0.375rem";
  body.textContent = detail;
  el.append(body);

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload extension";
  button.style.cssText =
    "cursor:pointer;border-radius:0.25rem;border:1px solid #7a3a3a;background:#552a2a;" +
    "color:#ffe7e7;font:inherit;padding:0.125rem 0.5rem";
  button.addEventListener("click", () => reload());
  foot.append(button);
  const note = document.createElement("span");
  note.style.cssText = "opacity:0.75";
  note.textContent = hint;
  foot.append(note);
  el.append(foot);
}

// Only inside a real extension page: the module is also imported by its test.
if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  installBootWatchdog();
}
