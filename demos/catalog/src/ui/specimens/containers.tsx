/**
 * containers.tsx — specimens for shelf 3: the page you are reading, as its
 * SitePage sees itself, and this demo's own landing card mounted in place.
 */
import type { JSX } from "@solidjs/web";
import { card } from "../../card";
import { activations, appScope, deactivations, PAGE_TITLE } from "../../model/store";

export function PageSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      You are reading one. Its <code>SitePage</code> is{" "}
      <code>{`{ title: "${PAGE_TITLE}", App, toolsNs: "${appScope.name}", activate, deactivate }`}</code>
      ; a host has called <code>activate</code> <b class="numeric">{activations.get()}</b>{" "}
      {activations.get() === 1 ? "time" : "times"} and <code>deactivate</code>{" "}
      <b class="numeric">{deactivations.get()}</b>. The gallery found it through the{" "}
      <code>aiui.sitePage</code> marker in <code>demos/catalog/package.json</code> and mounts it at{" "}
      <code>/catalog</code>; <code>pnpm -C demos/catalog dev</code> mounts the same object alone.
    </p>
  );
}

export function CardSpecimen(): JSX.Element {
  return (
    <>
      <div class="demo-card cat-card">
        <div class="demo-card-preview">
          <card.Preview />
        </div>
        <div class="demo-card-body">
          <div class="demo-card-title">catalog</div>
          <p class="demo-card-blurb">{card.blurb}</p>
        </div>
      </div>
      <p class="cat-note">
        This demo's own <code>DemoCard</code>, mounted here: the blurb and the preview the gallery's
        landing shows. The preview is drawn from <code>model/wave.ts</code> alone — never the store
        or the graph — so a landing can mount every card at once.
      </p>
    </>
  );
}
