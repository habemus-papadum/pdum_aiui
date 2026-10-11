import { afterEach, expect, it, vi } from "vitest";
import { browserScreenCaptureDriver, screenCaptureCapabilities } from "./browser";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function rig() {
  const cropTo = vi.fn(async (_token: unknown) => {});
  const restrictTo = vi.fn(async (_token: unknown) => {});
  const region = vi.fn(async (_element: Element) => ({ kind: "region" }));
  const element = vi.fn(async (_element: Element) => ({ kind: "element" }));
  vi.stubGlobal("CropTarget", { fromElement: region });
  vi.stubGlobal("RestrictionTarget", { fromElement: element });
  vi.stubGlobal("BrowserCaptureMediaStreamTrack", { prototype: { cropTo, restrictTo } });
  const track = {
    cropTo,
    restrictTo,
    readyState: "live",
    getSettings: () => ({ displaySurface: "browser" }),
  } as unknown as MediaStreamTrack;
  const target = document.createElement("div");
  target.setAttribute("data-screen-capture-target", "");
  target.style.cssText = "isolation:isolate;transform-style:flat";
  document.body.append(target);
  return {
    track,
    target,
    cropTo,
    restrictTo,
    region,
    element,
    driver: browserScreenCaptureDriver(),
  };
}
it("detects modes independently", () => {
  rig();
  vi.stubGlobal("RestrictionTarget", undefined);
  expect(screenCaptureCapabilities()).toMatchObject({ region: true, element: false });
});
it("caches native tokens and switches modes without an intermediate uncropped frame", async () => {
  const { driver, track, target, cropTo, restrictTo, region, element } = rig();
  await driver.applyTarget(track, { element: target });
  await driver.applyTarget(track, { element: target }, "region");
  expect(region).toHaveBeenCalledOnce();
  await driver.applyTarget(track, { element: target, mode: "element" }, "region");
  expect(cropTo).not.toHaveBeenCalledWith(null);
  expect(element).toHaveBeenCalledOnce();
  await driver.applyTarget(track, { element: target, mode: "region" }, "element");
  expect(restrictTo).not.toHaveBeenCalledWith(null);
  await driver.applyTarget(track, null, "element");
  expect(restrictTo).toHaveBeenLastCalledWith(null);
});
it("rejects a desktop/window source instead of returning a full-screen crop", async () => {
  const { driver, track, target, cropTo } = rig();
  track.getSettings = () => ({ displaySurface: "monitor" });
  await expect(driver.applyTarget(track, { element: target })).rejects.toThrow("this browser tab");
  expect(cropTo).not.toHaveBeenCalled();
});
it("retries failed token creation", async () => {
  const { driver, track, target, region } = rig();
  region.mockRejectedValueOnce(new Error("not ready"));
  await expect(driver.applyTarget(track, { element: target })).rejects.toThrow("not ready");
  await driver.applyTarget(track, { element: target });
  expect(region).toHaveBeenCalledTimes(2);
});

it("opens the general source chooser unless a tab preference or crop is requested", async () => {
  const { driver, target } = rig();
  const acquire = vi.fn(async () => ({}) as MediaStream);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: acquire } });
  await driver.acquire({});
  expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ preferCurrentTab: false }));
  await driver.acquire({ preferCurrentTab: true });
  expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ preferCurrentTab: true }));
  await driver.acquire({ target: { element: target }, preferCurrentTab: false });
  expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ preferCurrentTab: true }));
});

it("rejects undeclared element-only targets before asking the browser to restrict", async () => {
  const { driver, track, target, restrictTo, element } = rig();
  target.removeAttribute("data-screen-capture-target");
  await expect(driver.applyTarget(track, { element: target, mode: "element" })).rejects.toThrow(
    "declared capture boundary",
  );
  expect(restrictTo).not.toHaveBeenCalled();
  expect(element).not.toHaveBeenCalled();
});
