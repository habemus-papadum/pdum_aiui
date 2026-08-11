/**
 * PageBoundary — the mount-seam error boundary a shell wraps around each
 * SitePage's component tree (and a landing page wraps around each DemoCard
 * preview).
 *
 * Solid 2.0 (beta.32): an uncaught effect-phase throw permanently halts the
 * WHOLE document's reactive system. In a multi-app document — the gallery: N
 * scoped apps sharing one page — that is a composability violation: one
 * demo's bug must not kill its siblings. A boundary at the mount seam makes
 * the blast radius one page. The faulted page renders a fault card with the
 * error and a reset that re-mounts the subtree over its surviving durables
 * (the same shape as returning to a route); every sibling keeps flowing.
 *
 * What this does NOT cover: effects living in durable graph roots
 * (`hotCellGraph`), which outlive any mount by design — harden those
 * crossings with `bridgeEffect`. The two are the complementary halves of the
 * same rule (frontend-hard-won.md, "SolidJS 2.0 (beta) semantics").
 *
 * Styling: `.aiui-page-fault` for themes that want it; the inline fallback
 * styles keep the card legible with no stylesheet at all.
 */
import type { JSX } from "@solidjs/web";
import { createErrorBoundary } from "solid-js";

export function PageBoundary(props: { name?: string; children: JSX.Element }): JSX.Element {
  const view = createErrorBoundary(
    () => props.children,
    (error, reset) => (
      <div
        class="aiui-page-fault"
        style={{
          margin: "2rem auto",
          "max-width": "44rem",
          padding: "1rem 1.25rem",
          border: "1px solid #a33",
          "border-radius": "8px",
          "font-family": "system-ui, sans-serif",
        }}
      >
        <p style={{ margin: "0 0 0.5rem", "font-weight": "600" }}>
          {props.name ?? "this page"} hit an error and was contained here
        </p>
        <pre
          style={{
            margin: "0 0 0.75rem",
            "white-space": "pre-wrap",
            "overflow-wrap": "anywhere",
            "font-size": "0.85em",
            opacity: "0.85",
          }}
        >
          {String(error())}
        </pre>
        <button type="button" onClick={reset} style={{ cursor: "pointer" }}>
          reset {props.name ?? "page"}
        </button>
      </div>
    ),
  );
  return <>{view()}</>;
}
