/**
 * Remote.tsx — the host's side of the remote pencil: which plane is shared, the
 * one human-gated step (the tab-capture grant), and who is watching.
 *
 * The pattern is PenPad's: the component pushes control state into the
 * imperative island (`createEffect(source, handler)` → a plain setter) and
 * renders the island's throttled status snapshot. Nothing here touches a
 * socket or a peer connection.
 */

import type { JSX } from "@solidjs/web";
import { createEffect, Show } from "solid-js";
import { hostStatus } from "../model/remote-host";
import { remoteHost, share } from "../model/store";

/** Capture APIs exist only in secure contexts — decided per page load. */
const captureAvailable = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

export function Remote(): JSX.Element {
  // graph → island: the share control picks the plane.
  createEffect(
    () => share.get(),
    (plane) => remoteHost.setPlane(plane),
  );

  return (
    <section class="panel" id="remote">
      <h2>Remote</h2>

      <div class="row">
        <label class="slider" data-control={share.name}>
          <span class="slider-label">share</span>
          <select
            name={share.name}
            value={share.get()}
            onInput={(e) => share.set(e.currentTarget.value as never)}
          >
            <option value="canvas">canvas — the scratchpad</option>
            <option value="tab">tab — mark up this page</option>
          </select>
        </label>
      </div>

      <Show when={hostStatus.get().tabCapture === "needsGesture" && !captureAvailable()}>
        <p class="hint">
          ⚠ <b>This page cannot capture:</b> <code>{location.host}</code> is not a secure context,
          so <code>navigator.mediaDevices</code> does not exist here. Open the <i>host</i> page via{" "}
          <code>http://localhost:5173/</code> instead — the iPad's client URL stays on the LAN IP.
        </p>
      </Show>
      <Show when={hostStatus.get().tabCapture === "needsGesture" && captureAvailable()}>
        <button type="button" class="btn" onClick={() => void remoteHost.shareTab()}>
          Share this tab
        </button>
        <p class="hint">
          Tab capture needs a click — <code>getDisplayMedia</code> demands a human gesture. Until
          then every viewer is told <code>needsGesture</code> instead of staring at black. (The
          session browser auto-accepts this-tab capture, so no picker appears.)
        </p>
      </Show>
      <Show when={hostStatus.get().tabCapture === "denied"}>
        <p class="hint">
          Capture was denied. Pick the tab in the picker (or check the browser's screen-recording
          permission), then try again:
        </p>
        <button type="button" class="btn" onClick={() => void remoteHost.shareTab()}>
          Share this tab
        </button>
      </Show>

      <p class="hint" data-cell="hostStatus">
        {hostStatus.get().state === "hosting"
          ? `hosting · ${hostStatus.get().viewers} viewer${hostStatus.get().viewers === 1 ? "" : "s"} · ${hostStatus.get().plane}${hostStatus.get().tabCapture === "active" ? " (capturing)" : ""}`
          : hostStatus.get().state === "connecting"
            ? "connecting to the relay…"
            : "relay offline — retrying"}
        {" · "}
        <code>/pencil/</code> on another machine joins here.
      </p>
    </section>
  );
}
