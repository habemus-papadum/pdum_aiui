/**
 * router.test.ts — the SPA shell's routing seam: slug mapping (including the
 * legacy multi-entry `.html` URLs), base-prefixed hrefs, pushState navigation,
 * and the delegated link interceptor that keeps an anchor click from
 * hard-navigating the document (the turn-continuity requirement).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { hrefOf, interceptLocalLinks, navigate, route, routeOf } from "./router";

afterEach(() => {
  history.replaceState(null, "", "/");
});

/** Signal writes are batched — a same-tick read lies (the user guide's gotcha). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("routeOf", () => {
  it("maps slugs, the root, and unknown paths", () => {
    expect(routeOf("/")).toBe("morphogen");
    expect(routeOf("/aztec")).toBe("aztec");
    expect(routeOf("/seismos")).toBe("seismos");
    expect(routeOf("/nonsense")).toBe("morphogen");
  });

  it("maps the legacy multi-entry .html URLs onto the same routes", () => {
    expect(routeOf("/aztec.html")).toBe("aztec");
    expect(routeOf("/seismos.html")).toBe("seismos");
    expect(routeOf("/index.html")).toBe("morphogen");
  });
});

describe("navigate", () => {
  it("pushes the href and updates the route signal", async () => {
    navigate("aztec");
    expect(location.pathname).toBe(hrefOf("aztec"));
    await tick();
    expect(route()).toBe("aztec");
    navigate("morphogen");
    await tick();
    expect(route()).toBe("morphogen");
  });

  it("back/forward re-derives the route from the URL", async () => {
    navigate("seismos");
    await tick();
    history.replaceState(null, "", "/aztec"); // simulate where a back landed
    window.dispatchEvent(new PopStateEvent("popstate"));
    await tick();
    expect(route()).toBe("aztec");
  });
});

describe("interceptLocalLinks", () => {
  const click = (a: HTMLAnchorElement): MouseEvent => {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(e);
    return e;
  };

  it("turns a same-origin in-base anchor into a client-side navigation", async () => {
    const off = interceptLocalLinks();
    const a = document.createElement("a");
    a.href = "/seismos";
    document.body.append(a);
    const e = click(a);
    expect(e.defaultPrevented).toBe(true); // no document death
    await tick();
    expect(route()).toBe("seismos");
    a.remove();
    off();
  });

  it("leaves external links, targets, and downloads alone", () => {
    const off = interceptLocalLinks();
    for (const setup of [
      (a: HTMLAnchorElement) => {
        a.href = "https://example.com/aztec";
      },
      (a: HTMLAnchorElement) => {
        a.href = "/aztec";
        a.target = "_blank";
      },
      (a: HTMLAnchorElement) => {
        a.href = "/aztec";
        a.setAttribute("download", "");
      },
    ]) {
      const a = document.createElement("a");
      setup(a);
      document.body.append(a);
      const e = click(a);
      expect(e.defaultPrevented).toBe(false);
      a.remove();
    }
    off();
  });

  it("leaves same-path hash links to the browser (section jumps)", async () => {
    const off = interceptLocalLinks();
    navigate("aztec");
    await tick();
    const a = document.createElement("a");
    a.href = `${hrefOf("aztec")}#theory`;
    document.body.append(a);
    const e = click(a);
    expect(e.defaultPrevented).toBe(false);
    a.remove();
    off();
  });
});
