/**
 * M5 smoke content script: a SolidJS 2.0-beta component in a shadow root, plus
 * an import of *overlay source* from the monorepo (packages/aiui-dev-overlay/
 * src/errors.ts — dependency-free) to prove the source-first convention
 * survives the CRXJS pipeline.
 *
 * Live HMR test: with `npm run dev` + the dist/ folder loaded unpacked,
 * (1) edit the BADGE text below — the box should update IN PLACE (counter
 * preserved) without a page reload; (2) edit errors.ts in the overlay package —
 * same expectation, proving cross-package source HMR.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { addError, type OverlayError } from "../../../../packages/aiui-dev-overlay/src/errors";

const BADGE = "crxjs-smoke v1";

function Probe() {
  const [count, setCount] = createSignal(0);
  // Exercise the overlay-source import for real (not just type-level).
  const errors: OverlayError[] = addError([], {
    source: "smoke",
    message: "overlay source import works",
  });
  return (
    <div
      style={{
        position: "fixed",
        left: "16px",
        bottom: "16px",
        "z-index": "2147483647",
        background: "#1f2430",
        color: "#8ef",
        font: "13px ui-monospace, monospace",
        padding: "10px 14px",
        "border-radius": "10px",
        border: "1px solid #3a4460",
      }}
    >
      <div>{BADGE}</div>
      <div>overlay import: {errors[0]?.message ?? "FAILED"}</div>
      <button
        style={{ "margin-top": "6px", font: "inherit" }}
        onClick={() => setCount((c) => c + 1)}
      >
        count (HMR state probe): {count()}
      </button>
    </div>
  );
}

const host = document.createElement("div");
host.id = "crxjs-smoke-host";
const shadow = host.attachShadow({ mode: "open" });
document.documentElement.append(host);
render(() => <Probe />, shadow);
console.info("[crxjs-smoke] content script mounted", { badge: BADGE });
