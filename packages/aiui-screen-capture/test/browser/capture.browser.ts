import { expect, test } from "@playwright/test";

// The centre pixel of the captured frame, snapped to the nearest primary. Tab capture
// round-trips the frame through YUV, and CI's software path encodes BT.601 but decodes BT.709:
// pure red comes back as (255, 25, 0) and pure blue as (0, 15, 255) — the matrix arithmetic
// exactly — and pure green would land near (0, 215, 0). The tests ask which element is in
// frame, not how faithful the chroma is, so each channel is classified at the midpoint.
const primary = (pixel: number[]) => pixel.map((channel) => (channel < 128 ? 0 : 255));

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const diagnostic = await page.evaluate(() => {
    const video = document.querySelector("video");
    const track = window.capture?.stream()?.getVideoTracks()[0];
    return {
      state: window.capture?.snapshot(),
      track: track && {
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: track.getSettings(),
      },
      video: video && {
        paused: video.paused,
        width: video.videoWidth,
        height: video.videoHeight,
        currentTime: video.currentTime,
        srcMatches: video.srcObject === window.capture?.stream(),
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        rect: video.getBoundingClientRect().toJSON(),
      },
      hidden: document.hidden,
      scroll: window.scrollY,
      target: window.capture?.target()?.element.getBoundingClientRect().toJSON(),
      animations: document
        .getAnimations()
        .map((animation) => ({ state: animation.playState, time: animation.currentTime })),
    };
  });
  await info.attach("capture-state", {
    body: JSON.stringify(diagnostic, null, 2),
    contentType: "application/json",
  });
});

test("synthetic stream drives preview/FPS; unmounting preview does not release capture", async ({
  page,
}) => {
  await page.goto("/test/browser/?synthetic");
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect(page.locator("figcaption")).toContainText("320 × 180");
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  await page.evaluate(() => window.togglePreview());
  await expect(page.locator("video")).toHaveCount(0);
  expect(await page.evaluate(() => window.borrowed?.getVideoTracks()[0]?.readyState)).toBe("live");
  await page.evaluate(() => window.togglePreview());
  await expect(page.locator("figcaption")).toContainText("320 × 180");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(await page.evaluate(() => window.borrowed?.getVideoTracks()[0]?.readyState)).toBe("ended");
  await expect(page.getByRole("status")).toHaveText("Not capturing");
});

test("native region capture follows size, scroll, target changes and clearing", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  expect(await page.evaluate(() => window.capture.capabilities().region)).toBe(true);
  await page.getByLabel("Capture area", { exact: true }).selectOption("Red chart");
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(300 / 180);
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([0, 0, 255, 255]);
  await page.locator("#first").evaluate((element) => {
    element.style.width = "240px";
    element.style.height = "140px";
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(240 / 140);
  const beforeScroll = await page.evaluate(
    () => document.querySelector("video")?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
  );
  await page.evaluate(() => window.scrollTo(0, 30));
  // Observe frames from the scrolled page; re-reading the old aspect ratio alone would pass
  // before capture had processed the layout change.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("video")?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
      ),
    )
    .toBeGreaterThan(beforeScroll + 1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(240 / 140);
  const originalTrackId = await page.evaluate(
    () => window.capture.stream()?.getVideoTracks()[0]?.id,
  );
  // Application/agent actions must be reflected by the same controls.
  await page.evaluate(() => {
    const element = document.querySelector("#second");
    if (!element) throw new Error("Green chart missing");
    return window.capture.setTarget({ element, label: "Green chart" });
  });
  await expect(page.getByLabel("Capture area", { exact: true })).toHaveValue("Green chart");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(2);
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([0, 255, 0, 255]);
  await page.getByLabel("Capture area", { exact: true }).selectOption("");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(1280 / 900);
  expect(await page.evaluate(() => window.capture.snapshot().crop)).toBeUndefined();
  expect(await page.evaluate(() => window.capture.stream()?.getVideoTracks()[0]?.id)).toBe(
    originalTrackId,
  );
});

test("native element isolation excludes overlapping siblings and survives hiding", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  expect(await page.evaluate(() => window.capture.capabilities().element)).toBe(true);
  await page.getByLabel("Capture area", { exact: true }).selectOption("Red chart");
  await page.getByLabel("Crop mode").selectOption("element");
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = document.querySelector("video");
        return v ? v.videoWidth / v.videoHeight : 0;
      }),
    )
    .toBeCloseTo(300 / 180);
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([255, 0, 0, 255]);
  await page.locator("#first").evaluate((element) => {
    element.style.display = "none";
  });
  await expect
    .poll(() => page.evaluate(() => window.capture.snapshot().crop?.available))
    .toBe(false);
  // A cached red frame does not prove that capture resumed after showing the target.
  const hiddenFrames = await page.evaluate(
    () => document.querySelector("video")?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
  );
  await page.locator("#first").evaluate((element) => {
    element.style.display = "block";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("video")?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
      ),
    )
    .toBeGreaterThan(hiddenFrames + 1);
  await expect
    .poll(() => page.evaluate(() => window.capture.snapshot().crop?.available))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([255, 0, 0, 255]);
  await page.getByLabel("Crop mode").selectOption("region");
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([0, 0, 255, 255]);
  await page.getByLabel("Crop mode").selectOption("element");
  await expect
    .poll(() => page.evaluate(() => window.pixel()).then(primary))
    .toEqual([255, 0, 0, 255]);
});

test("element picker selects without activating the target and Escape cancels", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  await page.evaluate(() => {
    document.querySelector("#second")?.setAttribute("onclick", "this.dataset.activated='yes'");
  });
  await page.getByRole("button", { name: "Pick an element…" }).click();
  await page.locator("#second").click({ position: { x: 90, y: 50 } });
  await expect(page.getByLabel("Capture area", { exact: true })).toHaveValue("Green chart");
  await expect(page.locator("#second")).not.toHaveAttribute("data-activated");
  await page.getByRole("button", { name: "Pick an element…" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Pick an element…" })).toBeEnabled();
  await expect(page.getByLabel("Capture area", { exact: true })).toHaveValue("Green chart");
});

test("demo renders without errors at desktop and phone sizes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5196");
  await expect(page.getByRole("heading", { name: "Screen capture", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share screen…" })).toBeVisible();
  await page.screenshot({ path: "test-results/demo-desktop.png", fullPage: true });
  for (const width of [360, 390, 414]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByRole("heading", { name: "Screen capture", exact: true })).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.screenshot({ path: "test-results/demo-phone.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("demo captures its complete chart and can reveal another target", async ({ page }) => {
  await page.goto("http://127.0.0.1:5196");
  await page.evaluate(() => {
    document.title = "Screen capture browser tests";
  });
  await page.getByLabel("Capture area", { exact: true }).selectOption("Wave chart");
  const chart = await page.locator(".screen-demo-chart").boundingBox();
  if (!chart) throw new Error("Wave chart missing");
  expect(chart.y + chart.height).toBeLessThanOrEqual(900);
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const video = document.querySelector("video");
        return video ? video.videoWidth / video.videoHeight : 0;
      }),
    )
    .toBeCloseTo(chart.width / chart.height, 1);
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  await page.screenshot({ path: "test-results/demo-capturing.png", fullPage: true });
  await page.getByLabel("Capture area", { exact: true }).selectOption("Field notes");
  await page.getByRole("button", { name: "Show target", exact: true }).click();
  const notes = await page.locator(".screen-demo-notes").boundingBox();
  if (!notes) throw new Error("Field notes missing");
  expect(notes.y).toBeGreaterThanOrEqual(0);
  expect(notes.y + notes.height).toBeLessThanOrEqual(900);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const video = document.querySelector("video");
        return video ? video.videoWidth / video.videoHeight : 0;
      }),
    )
    .toBeCloseTo(notes.width / notes.height, 1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Not capturing");
});

test("element picker captures the declared chart when its paragraph is clicked", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5196");
  await page.evaluate(() => {
    document.title = "Screen capture browser tests";
  });
  await page.getByLabel("Crop mode").selectOption("element");
  await page.getByRole("button", { name: "Pick an element…" }).click();
  await page.locator(".screen-demo-caption").click();
  await expect(page.getByLabel("Capture area", { exact: true })).toHaveValue("Wave chart");
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  const chart = await page.locator(".screen-demo-chart").boundingBox();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth / v.videoHeight),
    )
    .toBeCloseTo((chart?.width ?? 0) / (chart?.height ?? 1), 1);

  // The same child is a valid Region crop, but switching it to Element only must not silently expand it.
  const trackId = await page
    .locator("video")
    .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]?.id);
  await page.getByLabel("Crop mode").selectOption("region");
  await page.getByRole("button", { name: "Pick an element…" }).click();
  await page.locator(".screen-demo-caption").click();
  await expect(page.getByLabel("Capture area", { exact: true })).toHaveValue("p");
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  await page.getByLabel("Crop mode").selectOption("element");
  await expect(page.getByRole("alert")).toContainText("declared capture boundary");
  await expect(page.getByLabel("Crop mode")).toHaveValue("region");
  expect(
    await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]?.id),
  ).toBe(trackId);
  expect(
    await page.locator(".screen-demo-caption").evaluate((e) => getComputedStyle(e).isolation),
  ).toBe("auto");

  // The second boundary uses the JSX props helper instead of a wrapper component.
  await page.getByLabel("Capture area", { exact: true }).selectOption("Field notes");
  await page.getByRole("button", { name: "Show target", exact: true }).click();
  await page.getByLabel("Crop mode").selectOption("element");
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unprepared API targets are rejected and a boundary losing CSS reports its problem", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  await page.getByLabel("Capture area", { exact: true }).selectOption("Red chart");
  await page.getByLabel("Crop mode").selectOption("element");
  await page.getByRole("button", { name: "Share screen…" }).click();
  await expect(page.locator("figcaption")).toContainText(/Preview: [1-9]\d*\.\d fps/);
  const error = await page.evaluate(async () => {
    try {
      await window.capture.setTarget({
        element: document.querySelector("#first .motion") as Element,
        mode: "element",
      });
    } catch (cause) {
      return String(cause);
    }
    return undefined;
  });
  expect(error).toContain("declared capture boundary");
  expect(await page.evaluate(() => window.capture.target()?.element.id)).toBe("first");
  await page.locator("#first").evaluate((e) => {
    e.style.isolation = "auto";
  });
  await expect(page.locator(".aiui-capture-empty")).toContainText("isolation styles");
  await expect(page.locator(".aiui-capture-controls [role=status]")).toHaveText(
    "Capture target unavailable",
  );
  const frames = await page
    .locator("video")
    .evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  await page.locator("#first").evaluate((e) => {
    e.style.isolation = "isolate";
  });
  await expect(page.locator(".aiui-capture-empty")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames),
    )
    .toBeGreaterThan(frames + 1);
});
