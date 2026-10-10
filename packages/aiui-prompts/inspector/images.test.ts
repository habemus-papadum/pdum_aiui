// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Group, Image, snapshot } from "../src/index.ts";
import { mountInspector } from "./view.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function host() {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

const asset = { id: "plot:42", alt: "Energy by trial", width: 520, height: 260 };
const record = () =>
  snapshot(Group({ children: ["Before the figure.", Image({ asset }), "After the figure."] }));

describe("inline multimodal preview", () => {
  it("renders images in part order, keeps raw output textual, and links the image to its owner", () => {
    const root = host();
    const retained = record();
    const view = mountInspector(root, retained, {
      resolveAsset: () => "https://example.invalid/plot.png",
    });
    disposers.push(view.dispose);
    const preview = root.querySelector<HTMLElement>(".prompt-preview") as HTMLElement;
    const children = [...preview.children];
    const figure = preview.querySelector("figure.prompt-inline-image");
    expect(figure).not.toBeNull();
    const index = children.indexOf(figure as Element);
    expect(children[index - 1].textContent).toBe("Before the figure.");
    expect(children[index + 1].textContent).toBe("After the figure.");
    const image = figure?.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("https://example.invalid/plot.png");
    expect(image.alt).toBe("Energy by trial");
    expect(image.width).toBe(520);
    expect(image.height).toBe(260);
    expect(image.loading).toBe("lazy");
    expect(image.referrerPolicy).toBe("no-referrer");
    expect(root.querySelector(".prompt-raw img")).toBeNull();
    expect(root.querySelector(".prompt-raw [data-asset]")?.textContent).toBe(
      "Image: Energy by trial",
    );
    const frame = figure?.querySelector("button") as HTMLButtonElement;
    expect(frame.dataset.part).toBe("p1");
    expect(frame.dataset.precision).toBe("atomic-asset");
    expect(frame.hasAttribute("data-start")).toBe(false);
    frame.dispatchEvent(new Event("pointerenter"));
    expect((root.querySelector(".prompt-image-popup") as HTMLElement).hidden).toBe(true);
    frame.focus();
    frame.click();
    const owner = view.controller.compiled?.contributions.find(
      (entry) => entry.part === "p1",
    )?.occurrence;
    expect(view.controller.state.selected).toBe(owner);
    expect(document.activeElement).toBe(root.querySelector(".prompt-inline-image-frame"));
    expect(root.querySelector(".prompt-inline-image-frame")?.getAttribute("data-selected")).toBe(
      "true",
    );
    expect(view.controller.record).toEqual(retained);
    expect(JSON.stringify(view.controller.record)).not.toContain("https://example.invalid");
  });

  it("coordinates folds without changing output or repeating resolution on view-only changes", () => {
    const root = host();
    let resolutions = 0;
    const view = mountInspector(root, record(), {
      resolveAsset: () => {
        resolutions++;
        return "https://example.invalid/plot.png";
      },
    });
    disposers.push(view.dispose);
    const compiled = view.controller.compiled;
    const owner = compiled?.contributions.find((entry) => entry.part === "p1")
      ?.occurrence as string;
    expect(resolutions).toBe(1);
    view.controller.select(owner);
    view.controller.toggleFold(owner);
    expect(root.querySelector(".prompt-inline-image")).toBeNull();
    expect(root.querySelector(".prompt-preview")?.textContent).toContain("[Folded image:");
    expect(root.querySelector(".prompt-raw")?.textContent).toContain("[Folded image:");
    expect(view.controller.compiled).toBe(compiled);
    view.controller.toggleFold(owner);
    expect(root.querySelector(".prompt-preview img")).not.toBeNull();
    expect(resolutions).toBe(1);
    view.controller.recompile();
    expect(resolutions).toBe(2);
    expect(view.controller.compiled).toEqual(compiled);
  });

  it("shows missing, failed, and stale image states without breaking the inspector", () => {
    const root = host();
    let phase = "missing";
    const view = mountInspector(root, record(), {
      resolveAsset: () => {
        if (phase === "missing") return undefined;
        if (phase === "throw") throw new Error("capture expired");
        return "https://example.invalid/plot.png";
      },
    });
    disposers.push(view.dispose);
    expect(root.querySelector(".prompt-inline-image")?.textContent).toContain(
      "No preview URL is available",
    );
    phase = "throw";
    view.controller.recompile();
    expect(root.querySelector(".prompt-inline-image")?.textContent).toContain("capture expired");
    phase = "loaded";
    view.controller.recompile();
    const oldImage = root.querySelector(".prompt-preview img") as HTMLImageElement;
    view.controller.select(view.controller.compiled?.occurrences[0].id ?? null);
    const currentImage = root.querySelector(".prompt-preview img") as HTMLImageElement;
    oldImage.dispatchEvent(new Event("error"));
    expect(root.querySelector(".prompt-preview img")).toBe(currentImage);
    currentImage.dispatchEvent(new Event("error"));
    expect(root.querySelector(".prompt-preview img")).toBeNull();
    expect(root.querySelector(".prompt-inline-image")?.textContent).toContain(
      "Image could not be loaded",
    );
    expect(root.querySelector(".prompt-provenance")).not.toBeNull();
    view.dispose();
    currentImage.dispatchEvent(new Event("error"));
    expect(root.childElementCount).toBe(0);
  });
});
