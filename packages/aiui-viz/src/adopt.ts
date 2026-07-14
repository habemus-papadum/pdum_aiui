/**
 * adopt.ts — handing a durable resource to a disposable component, correctly.
 *
 * The durable/disposable split (see `durable.ts`) says the WebGL field, the
 * running simulation, the drawing you are in the middle of making all outlive
 * the component that shows them. So every such component performs the same
 * ritual: *adopt* the resource on mount, *release* it on cleanup — and release
 * is where this gets subtle, twice.
 *
 * **Hazard one: the cleanup that is silently never registered.** The obvious
 * spelling is wrong:
 *
 * ```tsx
 * <div ref={(host) => { host.append(canvas); onCleanup(() => canvas.remove()); }} />
 * // ↑ dropped on the floor. [NO_OWNER_CLEANUP].
 * ```
 *
 * A ref callback runs *outside any reactive owner*, so an `onCleanup` inside one
 * is discarded — with a console warning that is easy to lose among Vite's
 * chatter, and no other symptom. The listeners then survive every hot swap and
 * stack: after five edits, one pointer gesture fires five handlers. (Found the
 * hard way in the pencil Lab, where a single stroke began committing itself
 * several times over.) `onCleanup` must be reached from the component *body*,
 * where the owner exists.
 *
 * **Hazard two: releasing a resource the successor already took.** On a hot
 * swap Solid mounts the replacement *before* disposing the old component. By the
 * time the outgoing cleanup runs, the new one may already have parented the
 * canvas into its own host — so an unconditional `canvas.remove()` reaches over
 * and rips it out of the successor's DOM. The result is a blank page that comes
 * back on the next edit, i.e. the worst kind of bug. Cleanup must ask **"is this
 * still mine?"** before letting go.
 *
 * `adopt()` is called in the component body — that call is what registers the
 * cleanup — and returns the ref callback:
 *
 * ```tsx
 * return <div ref={adopt((host) => {
 *   const detach = island.mount(host);
 *   return () => detach();          // ← runs in the component's owner, guaranteed
 * })} />;
 * ```
 *
 * and {@link durableCanvas} is the specialisation for the overwhelmingly common
 * case — a canvas created once, re-parented forever — with the "still mine?"
 * guard built in.
 */

import { getOwner, onCleanup } from "solid-js";
import { durable } from "./durable";

/** What a `ref={…}` wants: called with the element once it exists. */
export type Adoption = (host: HTMLElement) => void;

/** Teardown returned by a setup function; `void` if there is nothing to undo. */
export type Release = (() => void) | void;

/**
 * Adopt a durable resource into this component's lifetime.
 *
 * Call it **in the component body** (`ref={adopt(…)}` is exactly that — JSX
 * expressions are evaluated while the component runs, so the owner is present)
 * and it returns a ref callback. `setup` receives the host element and may
 * return a release function, which runs when the component is disposed.
 *
 * If there is no owner — because someone called this at module scope, or from
 * inside another ref callback — it says so loudly rather than leaking silently.
 * That is the entire reason this exists.
 */
export function adopt(setup: (host: HTMLElement) => Release): Adoption {
  if (getOwner() === null) {
    console.error(
      "[aiui] adopt() was called with no reactive owner, so its cleanup can never run. " +
        "Call it in the component BODY (`ref={adopt(…)}`), never inside another ref callback " +
        "or at module scope. See docs/guide/frontend-hard-won.md",
    );
  }

  let release: Release;
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    release?.();
    release = undefined;
  });

  return (host: HTMLElement) => {
    if (disposed) {
      return; // the component died before its ref fired; adopt nothing
    }
    release?.(); // defensive: a re-fired ref must not stack setups
    release = setup(host);
  };
}

/** A canvas that outlives the components that show it. */
export interface DurableCanvas {
  /** Created once per page, re-parented by whichever component is current. */
  canvas: HTMLCanvasElement;
  /**
   * Adopt the canvas into a host element. Call in the component body:
   * `ref={field.adopt()}`. The optional `setup` wires anything that belongs to
   * *this* component (pointer listeners, say) and returns their teardown.
   */
  adopt(setup?: (canvas: HTMLCanvasElement) => Release): Adoption;
}

/**
 * A canvas held in the durable registry, plus the adoption ritual that goes
 * with it — created once, re-parented by every hot-swapped component, and
 * **never taken from a successor that already adopted it**.
 *
 * Extracted from three hand-rolled copies (morphogen's `SimCanvas`, aztec's
 * `AztecCanvas`, the pencil Lab's pad), each of which had to re-derive the
 * ordering hazard in a comment.
 *
 * ```ts
 * // store.ts — created once, survives every hot edit
 * export const field = durableCanvas("morphogen:field", (c) => {
 *   c.width = c.height = 512;
 *   c.className = "sim-canvas";
 * });
 *
 * // SimCanvas.tsx — freely hot-swapped; the pattern keeps cooking
 * return <div class="sim-host" ref={field.adopt((canvas) => {
 *   canvas.addEventListener("pointerdown", down);
 *   return () => canvas.removeEventListener("pointerdown", down);
 * })} />;
 * ```
 *
 * Note what this does *not* do: it does not own a rendering loop, a context, or
 * a device. An imperative island that is a **framework-free library** — the
 * pencil's `PencilSurface`, which is unit-tested in node and instantiated by
 * three different apps — creates its own canvas and is adopted with plain
 * {@link adopt}. This is sugar for the other case: where the canvas is simply
 * app state, and the store is the only thing that would ever have made it.
 */
export function durableCanvas(
  key: string,
  init?: (canvas: HTMLCanvasElement) => void,
): DurableCanvas {
  const canvas = durable(key, () => {
    const element = document.createElement("canvas");
    init?.(element);
    return element;
  });

  return {
    canvas,
    adopt: (setup) =>
      adopt((host) => {
        host.append(canvas);
        const release = setup?.(canvas);
        return () => {
          release?.();
          // "Still mine?" — the replacement component mounts BEFORE this cleanup
          // runs, so it may already have re-parented the canvas into its own
          // host. Removing it then would blank the page the successor just drew.
          if (canvas.parentElement === host) {
            canvas.remove();
          }
        };
      }),
  };
}
