// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDebugPage } from "./debug-page";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("aiui-dbg-styles")?.remove();
  vi.restoreAllMocks();
});

/** A fake channel fleet: every port answers channels/traces; calls recorded. */
function fleetFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/debug/api/channels")) {
      return new Response(
        JSON.stringify({
          channels: [
            { tag: "alpha", port: 50001, pid: 1, cwd: "/repo/app" },
            { tag: "beta", port: 50002, pid: 2, cwd: "/repo/other" },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ traces: [], session: "s" }), { status: 200 });
  }) as typeof fetch;
}

describe("mountDebugPage", () => {
  it("says so when there is no channel port to poll", () => {
    mountDebugPage({});
    expect(document.body.textContent).toContain("no channel port");
  });

  it("offers the registry's channels and remounts the pane on a switch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", fleetFetch(calls));

    mountDebugPage({ port: 50001 });
    await tick();

    // The header picker lists both channels, the current one selected.
    const picker = document.querySelector("select.aiui-dbgp-picker") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["50001", "50002"]);
    expect(picker.value).toBe("50001");
    expect(picker.disabled).toBe(false);
    expect(
      calls.some((u) => u.startsWith(`http://${location.hostname}:50001/debug/api/traces`)),
    ).toBe(true);

    // Switch: the pane remounts against the picked channel's port and the
    // registry is re-enumerated through it.
    picker.value = "50002";
    picker.dispatchEvent(new Event("change"));
    await tick();
    expect(
      calls.some((u) => u.startsWith(`http://${location.hostname}:50002/debug/api/traces`)),
    ).toBe(true);
    expect(
      calls.some((u) => u.startsWith(`http://${location.hostname}:50002/debug/api/channels`)),
    ).toBe(true);
    // One pane at a time.
    expect(document.querySelectorAll(".aiui-dbgt")).toHaveLength(1);
  });

  it("keeps a lone unregistered channel selectable (and the picker disabled)", async () => {
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/debug/api/channels")) {
        return new Response("nope", { status: 404 }); // an older channel
      }
      return new Response(JSON.stringify({ traces: [] }), { status: 200 });
    }) as typeof fetch);
    mountDebugPage({ port: 50009 });
    await tick();
    const picker = document.querySelector("select.aiui-dbgp-picker") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(["(this channel) · :50009"]);
    expect(picker.disabled).toBe(true);
  });
});
