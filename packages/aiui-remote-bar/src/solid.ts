/**
 * solid.ts — the **host binding**: project a Solid mode engine over the bar wire.
 *
 * Given something engine-shaped (see {@link BarSource}) and a `send` callback, it
 * republishes the bar on every commit and turns inbound remote commands back into
 * engine dispatches. That is the whole of D5's host side: *any* app with a mode
 * engine gets a remote control surface by calling this and pointing a socket at
 * the returned {@link BarHost}.
 *
 * It binds to the **narrowest structural interface that works**, not a concrete
 * class: `bar()` / `claimStatuses()` / `state()` / `dispatch()` are exactly what
 * the intent client already exposes (`aiui-intent-client`'s `IntentClient`), so an
 * `IntentClient` — or a bare `solidModeEngine` wrapped to add `bar()` — satisfies
 * it with no adapter and no import of either.
 */

import { createEffect, createRoot } from "solid-js";
import { BarHost } from "./core";
import type { HostToRelay, WireCap } from "./protocol";

/**
 * The reactive surface the binding reads — deliberately structural. Each accessor
 * is a Solid signal read (tracked); `dispatch` is the imperative entry point a
 * remote tap lands on, identical to a key press.
 *
 * `bar()` returns `CapView[]`, which is a `WireCap[]` (the drift guard in
 * `protocol.test.ts` pins that). `claimStatuses()` returns per-name objects with a
 * `phase`; only the phase crosses the wire. `state().phase` is the engine phase
 * for the pill.
 */
/**
 * A bar item as the modal kit now projects it: `barModel()` returns depth rows
 * of caps AND widgets. Structural, so this package needs no aiui-viz import.
 */
interface RowLike {
  depth: number;
  items: readonly unknown[];
}

export interface BarSource {
  /**
   * Either a flat cap list, or `barModel()`'s depth rows verbatim (the shape
   * the intent client's `.bar()` returns) — the binding flattens rows and
   * keeps only caps: widgets (sliders, selects) are host-page furniture, not
   * a remote bar's business, the same call this wire already made for
   * `reveals`.
   */
  bar(): readonly WireCap[] | readonly RowLike[];
  claimStatuses(): Readonly<Record<string, { phase: string }>>;
  state(): { phase?: unknown };
  dispatch(command: string, payload?: unknown): unknown;
}

/** Flatten either `bar()` shape to the wire's flat cap list. */
function capsOf(bar: readonly WireCap[] | readonly RowLike[]): WireCap[] {
  const out: WireCap[] = [];
  for (const entry of bar) {
    if (typeof entry === "object" && entry !== null && "items" in entry) {
      for (const item of (entry as RowLike).items) {
        const it = item as { kind?: string; command?: unknown };
        if (it.kind !== "widget" && typeof it.command === "string") {
          out.push(item as WireCap);
        }
      }
    } else {
      out.push(entry as WireCap);
    }
  }
  return out;
}

export interface BindRemoteBarOptions {
  /** Put a host→relay message on the wire (the socket's `send`). */
  send: (message: HostToRelay) => void;
  /**
   * App-level filter over projected rows (D5's remote subset). Threaded straight
   * to {@link BarHost}; a rejected cap is neither seen nor tappable remotely.
   */
  filter?: (cap: WireCap) => boolean;
  /**
   * Where an inbound remote command goes. Defaults to `source.dispatch` — the
   * single-writer path, so a remote tap and a local key are indistinguishable
   * downstream. Override only to intercept (logging, a confirm gate).
   */
  onCommand?: (command: string, payload?: unknown) => void;
}

export interface BoundRemoteBar {
  /** Feed this the relay's frames (`ws.onmessage → host.receive(decode(...))`). */
  host: BarHost;
  /** Stop republishing and release the effect's reactive root. */
  dispose: () => void;
}

/** Read the current projection off the source (the tracked half of the effect). */
function projectionOf(source: BarSource): {
  rows: readonly WireCap[];
  claims: Record<string, string>;
  phase?: string;
} {
  const claims: Record<string, string> = {};
  for (const [name, status] of Object.entries(source.claimStatuses())) {
    claims[name] = status.phase;
  }
  const phase = source.state().phase;
  return {
    rows: capsOf(source.bar()),
    claims,
    ...(phase !== undefined && phase !== null ? { phase: String(phase) } : {}),
  };
}

/**
 * Bind a mode engine to the bar wire. Publishes once on creation (so the relay's
 * join-time replay has a bar to hand out even to an idle host) and again on every
 * commit that changes the bar, its claims, or the phase.
 *
 * Owns its own reactive root, so it can be called from plain app bootstrap — not
 * only inside a component. Call {@link BoundRemoteBar.dispose} on teardown.
 */
export function bindRemoteBar(source: BarSource, options: BindRemoteBarOptions): BoundRemoteBar {
  const host = new BarHost({
    send: options.send,
    ...(options.filter ? { filter: options.filter } : {}),
    onCommand:
      options.onCommand ??
      ((command, payload) => {
        source.dispatch(command, payload);
      }),
  });

  const dispose = createRoot((disposeRoot) => {
    createEffect(
      () => projectionOf(source),
      (projection) => {
        host.publishBar(projection.rows, projection.claims, projection.phase);
      },
    );
    return disposeRoot;
  });

  return { host, dispose };
}
