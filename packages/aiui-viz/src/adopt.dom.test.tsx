// @vitest-environment jsdom
/**
 * adopt.dom.test.tsx — the two hazards, pinned.
 *
 * Both of these bugs are silent in the wild: the first shows up as handlers
 * firing N times after N hot edits, the second as a canvas that vanishes when a
 * component is edited. Neither throws. So they are tested by simulating the
 * exact lifecycle order Solid produces on a hot swap — successor mounts, THEN
 * the predecessor is disposed.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adopt, durableCanvas } from "./adopt";
import { disposeDurable } from "./durable";

const hosts: HTMLElement[] = [];
const unmounts: Array<() => void> = [];

afterEach(() => {
  for (const u of unmounts.splice(0)) u();
  for (const h of hosts.splice(0)) h.remove();
  disposeDurable("test:canvas");
  vi.restoreAllMocks();
});

/** Mount a component and hand back its disposer — one "generation" of a hot swap. */
function mount(component: () => unknown): { host: HTMLElement; dispose: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const dispose = render(component as never, host);
  unmounts.push(dispose);
  return { host, dispose };
}

describe("adopt — cleanup that actually runs", () => {
  it("releases when the component is disposed", () => {
    const release = vi.fn();
    const { dispose } = mount(() => <div ref={adopt(() => release)} />);

    expect(release).not.toHaveBeenCalled();
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("passes the host element to setup", () => {
    let seen: HTMLElement | undefined;
    mount(() => (
      <div
        class="wrapper"
        ref={adopt((host) => {
          seen = host;
        })}
      />
    ));
    expect(seen?.className).toBe("wrapper");
  });

  it("shouts when there is no owner, instead of leaking in silence", () => {
    // The whole reason this helper exists: onCleanup outside an owner is DROPPED,
    // and the only signal is a console message nobody reads. So we make our own,
    // and we make it say what to do.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    adopt(() => undefined); // module scope — no component, no owner
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("no reactive owner");
  });

  it("does not stack setups if a ref fires twice", () => {
    const release = vi.fn();
    const setup = vi.fn(() => release);
    let ref: ((host: HTMLElement) => void) | undefined;
    mount(() => {
      ref = adopt(setup);
      return <div />;
    });

    const a = document.createElement("div");
    const b = document.createElement("div");
    ref?.(a);
    ref?.(b);

    // The first adoption was released before the second was set up.
    expect(setup).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("durableCanvas — created once, never stolen from a successor", () => {
  it("is the same element across component generations, with its pixels intact", () => {
    const make = () => durableCanvas("test:canvas", (c) => (c.width = 64));

    const first = mount(() => <div ref={make().adopt()} />);
    const canvas = make().canvas;
    canvas.getContext("2d"); // a context is exactly the thing that must not be re-created
    (canvas as HTMLCanvasElement & { marked?: boolean }).marked = true;
    expect(first.host.contains(canvas)).toBe(true);

    first.dispose();
    const second = mount(() => <div ref={make().adopt()} />);

    expect(make().canvas).toBe(canvas); // the same element, not a look-alike
    expect((make().canvas as HTMLCanvasElement & { marked?: boolean }).marked).toBe(true);
    expect(second.host.contains(canvas)).toBe(true);
  });

  it("survives the hot-swap ORDER: successor adopts, THEN predecessor is disposed", () => {
    // This is the ordering that makes the naive `canvas.remove()` blank the page:
    // by the time the outgoing cleanup runs, the canvas is already the new
    // component's child, and an unconditional remove() reaches over and takes it.
    const make = () => durableCanvas("test:canvas", () => {});

    const outgoing = mount(() => <div class="old" ref={make().adopt()} />);
    const incoming = mount(() => <div class="new" ref={make().adopt()} />);
    const canvas = make().canvas;

    expect(incoming.host.contains(canvas)).toBe(true);

    outgoing.dispose(); // ← the predecessor lets go, LAST

    expect(incoming.host.contains(canvas)).toBe(true); // …and does NOT take it with it
    expect(outgoing.host.contains(canvas)).toBe(false);
    expect(canvas.isConnected).toBe(true);
  });

  it("removes the canvas when the last owner really does go away", () => {
    const make = () => durableCanvas("test:canvas", () => {});
    const only = mount(() => <div ref={make().adopt()} />);
    expect(make().canvas.isConnected).toBe(true);

    only.dispose();

    expect(make().canvas.isConnected).toBe(false);
  });

  it("releases the component's own listeners, but keeps the canvas", () => {
    const make = () => durableCanvas("test:canvas", () => {});
    const off = vi.fn();
    const gen = mount(() => <div ref={make().adopt(() => off)} />);

    gen.dispose();

    expect(off).toHaveBeenCalledTimes(1);
    expect(make().canvas).toBeInstanceOf(HTMLCanvasElement); // still there, for the next one
  });
});
