// @vitest-environment jsdom
import "./test-support/worker-stub";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { type Directive, MosaicView } from "./mosaic";

/** A coordinator stub recording connects/disconnects (the bridge's whole contract). */
function stubCoordinator() {
  const connected: unknown[] = [];
  const disconnected: unknown[] = [];
  return {
    connected,
    disconnected,
    connect: (c: unknown) => connected.push(c),
    disconnect: (c: unknown) => disconnected.push(c),
  };
}

describe("MosaicView", () => {
  it("applies directives, mounts the plot element, and rebuilds on a spec change", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const coordinator = stubCoordinator();
    const applied: number[] = [];
    const [rev, setRev] = createSignal(1);
    const spec = (): Directive[] => {
      const r = rev();
      return [(plot) => applied.push(r) && plot.setAttribute("width", 320)];
    };

    const dispose = render(
      () => <MosaicView coordinator={coordinator} spec={spec} class="extra" />,
      host,
    );
    await new Promise((resolve) => setTimeout(resolve));

    const mount = host.querySelector(".mosaic-host");
    expect(mount?.className).toBe("mosaic-host extra");
    expect(mount?.children.length).toBe(1); // the Plot's element
    expect(applied).toEqual([1]);

    setRev(2); // a reactive spec read rebuilds against the surviving coordinator
    await new Promise((resolve) => setTimeout(resolve));
    expect(applied).toEqual([1, 2]);

    dispose();
    host.remove();
    // No marks in this spec, so nothing to connect/disconnect — but the bridge
    // must never have disconnected more than it connected.
    expect(coordinator.disconnected.length).toBe(coordinator.connected.length);
  });
});
