import { describe, expect, it, vi } from "vitest";

// Mock the backend so this test needs no real project, no `ws`, no LSP — it
// verifies only the sidecar *wrapper* (the real channel↔backend integration is
// covered by a node smoke run and the channel's own sidecar-seam tests).
const handleHttp = vi.fn(async (req: { url?: string }) => !!req.url?.startsWith("/__aiui_code"));
const handleUpgrade = vi.fn(() => true);
const dispose = vi.fn();
vi.mock("./backend", () => ({
  mountAiuiCodeBackend: vi.fn(() => ({ handleHttp, handleUpgrade, dispose })),
}));

import { codeReaderSidecar } from "./sidecar";

function fakeApp() {
  const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
  return {
    use: (fn: (req: unknown, res: unknown, next: () => void) => void) => middlewares.push(fn),
    middlewares,
  };
}

describe("codeReaderSidecar", () => {
  it("is a 'code' sidecar exposing upgrade + dispose", () => {
    const sc = codeReaderSidecar({ root: "/proj" });
    expect(sc.name).toBe("code");
    // biome-ignore lint/suspicious/noExplicitAny: fake express app for the wrapper test
    const mounted = sc.mount(fakeApp() as any, { log: () => {} });
    expect(typeof mounted.handleUpgrade).toBe("function");
    expect(typeof mounted.dispose).toBe("function");
    mounted.handleUpgrade?.({} as never, {} as never, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalled();
    mounted.dispose?.();
    expect(dispose).toHaveBeenCalled();
  });

  it("delegates /__aiui_code/* to the backend and falls through everything else", async () => {
    const app = fakeApp();
    // biome-ignore lint/suspicious/noExplicitAny: fake express app for the wrapper test
    codeReaderSidecar({ root: "/proj" }).mount(app as any, { log: () => {} });
    const mw = app.middlewares[0];

    // A reader route: handled, next NOT called.
    const next1 = vi.fn();
    mw({ url: "/__aiui_code/info" }, {}, next1);
    await Promise.resolve();
    await Promise.resolve();
    expect(next1).not.toHaveBeenCalled();

    // A foreign route: not handled → next() so the host keeps routing.
    const next2 = vi.fn();
    mw({ url: "/something-else" }, {}, next2);
    await Promise.resolve();
    await Promise.resolve();
    expect(next2).toHaveBeenCalledOnce();
  });

  it("routes a handleHttp rejection to next(err) — never an unhandled rejection", async () => {
    const app = fakeApp();
    // biome-ignore lint/suspicious/noExplicitAny: fake express app for the wrapper test
    codeReaderSidecar({ root: "/proj" }).mount(app as any, { log: () => {} });
    const mw = app.middlewares[0];

    const boom = new Error("backend blew up");
    handleHttp.mockRejectedValueOnce(boom as never);
    const next = vi.fn();
    mw({ url: "/__aiui_code/info" }, {}, next);
    await Promise.resolve();
    await Promise.resolve();
    // Express's error path gets it; the channel process never sees a rejection.
    expect(next).toHaveBeenCalledWith(boom);
  });
});
