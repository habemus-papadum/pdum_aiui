// @vitest-environment jsdom
/**
 * page-boundary.test.tsx — the containment claim, proved against the real
 * scheduler.
 *
 * Solid 2.0.0-beta.32 turned uncaught effect-phase throws into a permanent
 * halt of the whole document's reactive system. PageBoundary exists so a
 * multi-app document (the gallery) contains that blast to one page. These
 * tests pin the two halves of the claim: the faulted page shows the fault
 * card, and — the part that actually matters — a SIBLING page's reactivity
 * keeps working afterwards. If Solid's boundary routing for effect throws
 * ever changes, this is the file that goes red.
 */
import { render } from "@solidjs/web";
import { createEffect, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { PageBoundary } from "./page-boundary";

const tick = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

/** A page whose effect handler throws when the shared trigger goes truthy. */
function Faulty(props: { trigger: () => boolean }) {
  createEffect(
    () => props.trigger(),
    (t) => {
      if (t) throw new Error("faulty page effect");
    },
  );
  return <div data-page="faulty">faulty page alive</div>;
}

function Healthy(props: { count: () => number }) {
  return <div data-page="healthy">count: {props.count()}</div>;
}

describe("PageBoundary containment", () => {
  it("contains an effect throw to the faulted page; siblings keep flowing; a cleared source self-recovers", async () => {
    const [trigger, setTrigger] = createSignal(false);
    const [count, setCount] = createSignal(0);
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <>
          <PageBoundary name="faulty-demo">
            <Faulty trigger={trigger} />
          </PageBoundary>
          <PageBoundary name="healthy-demo">
            <Healthy count={count} />
          </PageBoundary>
        </>
      ),
      host,
    );
    await tick();
    expect(host.textContent).toContain("faulty page alive");
    expect(host.textContent).toContain("count: 0");

    // The fault: the effect handler throws. The boundary must catch it —
    // uncontained, this would halt the whole document's reactive system.
    setTrigger(true);
    await tick();
    await tick();
    expect(host.querySelector(".aiui-page-fault")?.textContent).toContain("faulty-demo");
    expect(host.textContent).toContain("faulty page effect");

    // The sibling is untouched AND still reactive — the containment claim.
    setCount(1);
    await tick();
    expect(host.textContent).toContain("count: 1");

    // Clearing the faulting source retries the boundary: the page re-mounts
    // by itself, no reset needed (transient faults self-heal).
    setTrigger(false);
    await tick();
    await tick();
    expect(host.textContent).toContain("faulty page alive");
    expect(host.querySelector(".aiui-page-fault")).toBeNull();

    // And the sibling still flows after the whole episode.
    setCount(2);
    await tick();
    expect(host.textContent).toContain("count: 2");
  });

  it("the reset button re-mounts a fault no source change will heal", async () => {
    // A one-shot latch: throws on the first mount only, so nothing reactive
    // ever retries the boundary — the button is the only way back.
    let armed = true;
    function LatchFault() {
      if (armed) {
        armed = false;
        throw new Error("one-shot mount fault");
      }
      return <div>latch page alive</div>;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <PageBoundary name="latch-demo">
          <LatchFault />
        </PageBoundary>
      ),
      host,
    );
    await tick();
    expect(host.querySelector(".aiui-page-fault")?.textContent).toContain("one-shot mount fault");

    (host.querySelector(".aiui-page-fault button") as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(host.textContent).toContain("latch page alive");
    expect(host.querySelector(".aiui-page-fault")).toBeNull();
  });
});
