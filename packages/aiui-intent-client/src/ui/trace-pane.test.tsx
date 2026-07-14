// @vitest-environment jsdom
/**
 * trace-pane.test.tsx — the embedded debug-ui island: the panel mounts the
 * SAME surface `/__aiui/debug` serves, and its polls run only while the
 * disclosure is open (a closed pane costs zero requests — it lives in a side
 * panel that is usually showing something else).
 */
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTracePane } from "./trace-pane";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RichTracePane", () => {
  it("mounts the shared debug-ui surface; polls start on open, stop on close", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ traces: [], session: "s" }), { status: 200 }),
      );
    });

    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <RichTracePane baseUrl="http://127.0.0.1:59999" />, root);

    // The exact surface every other debug home mounts — nothing forked.
    expect(root.querySelector(".aiui-dbgt")).not.toBeNull();
    expect(calls).toEqual([]); // closed: zero requests

    const details = root.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    flush();
    await settle();
    expect(calls.some((url) => url.endsWith("/debug/api/traces"))).toBe(true);

    // Closing deactivates: the timers are gone, no further polls accumulate.
    const after = calls.length;
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    flush();
    await settle();
    expect(calls.length).toBe(after);
  });
});
