/**
 * path.test.ts — the shared pathname signal: one source of truth for
 * location, written by navigateTo and popstate, readable by any number of
 * routers (the shell's head, a deck's tail).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { navigateTo, pathname } from "./path";

afterEach(() => {
  history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
});

/** Signal writes are batched — a same-tick read lies (the user guide's gotcha). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("navigateTo", () => {
  it("pushes the path and updates the signal", async () => {
    navigateTo("/talk");
    expect(location.pathname).toBe("/talk");
    await tick();
    expect(pathname()).toBe("/talk");
  });

  it("replace swaps the current entry instead of pushing", async () => {
    navigateTo("/talk");
    const depth = history.length;
    navigateTo("/talk/mesh", { replace: true });
    expect(history.length).toBe(depth);
    await tick();
    expect(pathname()).toBe("/talk/mesh");
  });

  it("same-path is a no-op", async () => {
    navigateTo("/talk");
    await tick();
    const depth = history.length;
    navigateTo("/talk");
    expect(history.length).toBe(depth);
  });
});

describe("popstate", () => {
  it("re-derives the signal from the URL (back/forward)", async () => {
    navigateTo("/talk");
    await tick();
    history.replaceState(null, "", "/gears"); // simulate where a back landed
    window.dispatchEvent(new PopStateEvent("popstate"));
    await tick();
    expect(pathname()).toBe("/gears");
  });
});
