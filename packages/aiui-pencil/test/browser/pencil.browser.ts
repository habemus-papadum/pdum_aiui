import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const entry = `/@fs${fileURLToPath(new URL("../../src/index.ts", import.meta.url))}`;
const circleStore = `/@fs${fileURLToPath(new URL("../../../../demos/circle/src/model/store.ts", import.meta.url))}`;
const labStore = "/src/model/store.ts";

async function drawCircle(page: Page) {
  const canvas = page.locator("canvas.circle-paper");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No circle canvas");
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.48;
  const radius = Math.min(box.width * 0.17, box.height * 0.22);
  await page.mouse.move(cx + radius, cy);
  await page.mouse.down();
  for (let i = 1; i <= 48; i++) {
    const angle = (i / 48) * Math.PI * 2;
    await page.mouse.move(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    if (i === 30) await expect(page.locator(".turn-pill")).toHaveClass(/live/);
  }
  await page.mouse.up();
  await expect(page.locator(".gauge-num")).toBeVisible();
  expect(Number(await page.locator(".gauge-num").textContent())).toBeGreaterThan(90);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Observe sockets without blocking Vite's own HMR connection.
  page.on("websocket", (socket) => {
    if (/\/(pencil|bar)\//.test(socket.url()))
      errors.push(`Unexpected collaboration socket: ${socket.url()}`);
  });
  await page.exposeFunction("testPageErrors", () => errors);
});

test.afterEach(async ({ page }) => {
  const errors = await page.evaluate(() =>
    (window as unknown as { testPageErrors(): Promise<string[]> }).testPageErrors(),
  );
  expect(errors).toEqual([]);
});

test("programmatic strokes render, erase, undo, replay silently, and cancel", async ({ page }) => {
  await page.goto("http://127.0.0.1:5201");
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      width: "200px",
      height: "200px",
      left: "0",
      top: "0",
    });
    document.body.append(target);
    let starts = 0;
    let ends = 0;
    let cancels = 0;
    const params = { ...WRITE, size: 8, grain: 0 };
    const surface = new PencilSurface({
      target,
      localInput: false,
      params: () => params,
      onStrokeStart: () => starts++,
      onStrokeEnd: () => ends++,
      onStrokeCancel: () => cancels++,
    });
    const point = (x: number) => ({
      x,
      y: 50,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    const frame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const pixels = () => {
      const context = surface.canvas.getContext("2d");
      const data = context.getImageData(0, 0, surface.canvas.width, surface.canvas.height).data;
      let alpha = 0;
      for (let i = 3; i < data.length; i += 4) alpha += data[i];
      return alpha;
    };
    surface.beginStroke("draw", { tool: "draw", params, point: point(20) });
    surface.appendPoints("draw", [point(40), point(60), point(80)]);
    surface.endStroke("draw", point(100));
    await frame();
    const ink = pixels();
    const samples = surface.ink().strokes[0].points.length;
    surface.beginStroke("erase", {
      tool: "erase",
      params: { ...params, size: 16 },
      point: point(20),
    });
    surface.appendPoints("erase", [point(40), point(60), point(80), point(100)]);
    surface.endStroke("erase");
    await frame();
    const erased = pixels();
    surface.undo();
    await frame();
    const restored = pixels();
    const beforeReplay = [starts, ends];
    surface.clear();
    surface.beginStroke("replay", { tool: "draw", params, point: point(20), notify: false });
    surface.appendPoints("replay", [point(40), point(60), point(80), point(100)]);
    surface.endStroke("replay");
    target.style.width = "220px";
    await frame();
    const afterReplay = [starts, ends];
    surface.beginStroke("cancel", { tool: "draw", params, point: point(20) });
    surface.cancelStroke("cancel");
    const live = surface.ink().live.length;
    surface.dispose();
    target.remove();
    return { ink, samples, erased, restored, beforeReplay, afterReplay, cancels, live };
  }, entry);
  expect(result.ink).toBeGreaterThan(0);
  expect(result.samples).toBe(5);
  expect(result.erased).toBeLessThan(result.ink);
  expect(result.restored).toBe(result.ink);
  expect(result.afterReplay).toEqual(result.beforeReplay);
  expect(result.cancels).toBe(1);
  expect(result.live).toBe(0);
});

test("Circle measures while drawing, freezes after pen-up and fade, and clears", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5201");
  await drawCircle(page);
  await page.screenshot({ path: test.info().outputPath("circle.png"), fullPage: true });
  const score = await page.locator(".gauge-num").textContent();
  await expect(page.locator(".turn-pill")).not.toHaveClass(/live/);
  await expect
    .poll(() =>
      page.evaluate(async (path) => (await import(path)).paper.ink().strokes.length, circleStore),
    )
    .toBe(0);
  await expect(page.locator(".gauge-num")).toHaveText(score ?? "");
  for (const mode of ["Guide", "Blind", "Zen"]) {
    const button = page.getByRole("button", { name: mode, exact: true });
    await button.click();
    await expect(button).toHaveClass(/active/);
  }
  await page.locator(".circle-page").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".readout-empty")).toBeVisible();
});

test("Circle cancels an interrupted pointer without a stuck drawing turn", async ({ page }) => {
  await page.goto("http://127.0.0.1:5201");
  const canvas = page.locator("canvas.circle-paper");
  await canvas.dispatchEvent("pointerdown", {
    pointerId: 12,
    pointerType: "pen",
    clientX: 100,
    clientY: 100,
    pressure: 0.5,
  });
  await expect(page.locator(".turn-pill")).toHaveClass(/live/);
  await canvas.dispatchEvent("pointercancel", { pointerId: 12, pointerType: "pen" });
  await expect(page.locator(".turn-pill")).toHaveText("ready");
  await expect(page.locator(".readout-empty")).toBeVisible();
});

test("Circle still draws after leaving and returning through the gallery", async ({ page }) => {
  await page.goto("http://127.0.0.1:5203/circle");
  await drawCircle(page);
  const initialTurn = await page.locator(".turn-pill").textContent();
  await page.locator('nav a[href="/gears"]').first().click();
  await expect(page.locator("canvas.circle-paper")).toHaveCount(0);
  await page.locator('nav a[href="/circle"]').first().click();
  await expect(page.locator(".turn-pill")).toHaveText(initialTurn ?? "");
  await drawCircle(page);
  await expect(page.locator(".turn-pill")).toHaveText("turn 2");
});

test("local lab preserves drawing, parameter replay, undo, and clear", async ({ page }) => {
  await page.goto("http://127.0.0.1:5202");
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No lab canvas");
  await page.mouse.move(box.x + 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 130, { steps: 20 });
  await page.mouse.up();
  const count = () =>
    page.evaluate(async (path) => (await import(path)).paper.ink().strokes.length, labStore);
  await expect.poll(count).toBe(1);
  await page.evaluate(async () => {
    const kit = (
      window as unknown as Record<string, { call(name: string, args: unknown): Promise<unknown> }>
    )["__pencil-lab"];
    await kit.call("set", { name: "pencil-lab/size", value: 6 });
  });
  await expect.poll(count).toBe(1);
  await page.screenshot({ path: test.info().outputPath("lab.png"), fullPage: true });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(count).toBe(0);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remote", exact: true })).toHaveCount(0);
});

test("surface local input uses the retained pencil priority and gesture policy", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5202");
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "200px",
      height: "200px",
    });
    document.body.append(container);
    let cancelled = 0;
    let pans = 0;
    let zooms = 0;
    const surface = new PencilSurface({
      target: container,
      params: () => WRITE,
      onStrokeCancel: () => cancelled++,
      onPan: () => pans++,
      onZoom: () => zooms++,
    });
    surface.setActive(true);
    const send = (type: string, pointerType: string, pointerId: number, x = 30, contact = 1) => {
      surface.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType,
          clientX: x,
          clientY: 30,
          width: contact,
          height: contact,
          pressure: 0.6,
          bubbles: true,
        }),
      );
    };
    send("pointerdown", "touch", 1);
    send("pointerdown", "pen", 2);
    send("pointerdown", "touch", 3, 40, 66);
    send("pointermove", "pen", 2, 60);
    send("pointerup", "pen", 2, 80);
    send("pointerup", "touch", 1);
    send("pointerup", "touch", 3);
    const kinds = surface
      .ink()
      .strokes.map((stroke: { points: { kind: string }[] }) => stroke.points[0].kind);
    // Past the binding's post-pen navigation cooldown.
    await new Promise((resolve) => setTimeout(resolve, 510));
    send("pointerdown", "touch", 4, 40, 66);
    send("pointerdown", "touch", 5, 60, 66);
    send("pointermove", "touch", 5, 90, 66);
    const strokeCount = surface.ink().strokes.length;
    surface.dispose();
    send("pointerdown", "pen", 6);
    const liveAfterDispose = surface.ink().live.length;
    container.remove();
    return { cancelled, kinds, pans, zooms, strokeCount, liveAfterDispose };
  }, entry);
  expect(result.cancelled).toBe(1);
  expect(result.kinds).toEqual(["pen"]);
  expect(result.pans).toBeGreaterThan(0);
  expect(result.zooms).toBeGreaterThan(0);
  expect(result.strokeCount).toBe(1);
  expect(result.liveAfterDispose).toBe(0);
});
