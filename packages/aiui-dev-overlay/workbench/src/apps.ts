/**
 * The workbench's pluggable scenery: which app fills the left pane.
 *
 * Two registrations for now, two hosting styles — both deliberately cheap to
 * add to, since swapping scenery is how the workbench stays honest about "does
 * the pipeline work over a *real* app, not just our favourite one":
 *
 *  - **inline** apps mount into the workbench page itself; the workbench also
 *    mounts the intent overlay over its own page, so the whole turn (ink,
 *    shots, dictation) happens in-page. The spectra viewer is one.
 *  - **iframe** apps are separate Vite apps the workbench dev server started
 *    (see vite.config.ts) whose *own* aiuiDevOverlay points at the workbench's
 *    debug channel. They bring their own overlay, source locator, and agent
 *    tool surface — full fidelity — so the workbench mounts no overlay of its
 *    own while one is selected (two armed keymaps would fight).
 */
import { mountScenery } from "./scenery";

export interface WorkbenchAppContext {
  /** The demo app dev server's URL, once the workbench server reports it. */
  demoUrl?: string;
}

export interface WorkbenchApp {
  id: string;
  label: string;
  /** Whether the workbench should mount its own intent overlay for this app. */
  overlay: "workbench" | "own";
  /** Render into the host; return a cleanup. */
  mount(host: HTMLElement, ctx: WorkbenchAppContext): () => void;
}

export const WORKBENCH_APPS: WorkbenchApp[] = [
  {
    id: "spectra",
    label: "spectra (inline)",
    overlay: "workbench",
    mount(host) {
      mountScenery(host);
      return () => {
        host.innerHTML = "";
      };
    },
  },
  {
    id: "demo",
    label: "morphogen demo (iframe)",
    overlay: "own",
    mount(host, ctx) {
      if (!ctx.demoUrl) {
        const note = document.createElement("div");
        note.className = "wb-app-note";
        note.textContent = "demo app server is still starting — reselect in a moment";
        host.append(note);
        return () => {
          host.innerHTML = "";
        };
      }
      const frame = document.createElement("iframe");
      frame.className = "wb-app-frame";
      frame.src = ctx.demoUrl;
      frame.allow = "microphone; display-capture";
      host.append(frame);
      return () => {
        host.innerHTML = "";
      };
    },
  },
];
