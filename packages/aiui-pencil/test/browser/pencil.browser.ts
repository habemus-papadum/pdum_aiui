import { utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { InkDocument, InkStroke } from "../../src/document";
import type { CanvasInkView } from "../../src/renderer";
import type { PencilSurface } from "../../src/surface";

const entry = `/@fs${fileURLToPath(new URL("../../src/index.ts", import.meta.url))}`;
const circleStore = `/@fs${fileURLToPath(new URL("../../../../demos/circle/src/model/store.ts", import.meta.url))}`;
const labStore = "/src/model/store.ts";
const port = Number(process.env.PENCIL_TEST_PORT_BASE ?? 5201);
const circleURL = `http://127.0.0.1:${port}`;
const labURL = `http://127.0.0.1:${port + 1}`;
const galleryURL = `http://127.0.0.1:${port + 2}`;
interface HmrProbe {
  document: InkDocument;
  view: CanvasInkView;
  canvas: HTMLCanvasElement;
  first: InkStroke;
}
type ProbeWindow = Window & { pencilHmrProbe?: HmrProbe };
type CaptureLossWindow = Window & {
  captureLossProbe: { surface: PencilSurface; pointerId: number; events: string[] };
};
const fixtureURL = `${circleURL}/@fs${fileURLToPath(new URL("./fixture.html", import.meta.url))}`;

test("pen strokes survive capture loss before pointerup inside and outside the canvas", async ({
  page,
  context,
}) => {
  await page.goto(fixtureURL);
  await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "400px",
      height: "300px",
    });
    document.body.append(target);
    const surface = new PencilSurface({ target, params: () => WRITE });
    surface.setActive(true);
    const probe = { surface, pointerId: 0, events: [] as string[] };
    Object.assign(window, { captureLossProbe: probe });
    for (const type of ["pointerdown", "pointerup", "pointercancel", "lostpointercapture"])
      document.addEventListener(
        type,
        (event) => {
          const pointer = event as PointerEvent;
          if (pointer.pointerType !== "pen") return;
          probe.pointerId = pointer.pointerId;
          probe.events.push(type);
        },
        true,
      );
  }, entry);
  const session = await context.newCDPSession(page);
  for (const [index, releaseX] of [200, 440].entries()) {
    const y = 60 + index * 100;
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      pointerType: "pen",
      button: "left",
      buttons: 1,
      x: 40,
      y,
      force: 0.6,
    });
    for (let x = 60; x <= 180; x += 20)
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        pointerType: "pen",
        buttons: 1,
        x,
        y,
        force: 0.6,
      });
    await page.evaluate(() => {
      const probe = (window as CaptureLossWindow).captureLossProbe;
      probe.surface.canvas.releasePointerCapture(probe.pointerId);
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      pointerType: "pen",
      button: "left",
      buttons: 0,
      x: releaseX,
      y,
      force: 0,
    });
    const result = await page.evaluate(() => {
      const { surface, events } = (window as CaptureLossWindow).captureLossProbe;
      surface.view.render();
      const snapshot = surface.document.snapshot();
      const context = surface.canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const pixels = context.getImageData(0, 0, surface.canvas.width, surface.canvas.height).data;
      return {
        events,
        strokes: snapshot.strokes.length,
        live: snapshot.live.length,
        last: snapshot.strokes.at(-1)?.points.at(-1),
        counts: surface.input.counts(),
        visible: pixels.some((value: number, i: number) => i % 4 === 3 && value > 0),
      };
    });
    expect(result.events.slice(-3)).toEqual(["pointerdown", "lostpointercapture", "pointerup"]);
    expect(result.strokes).toBe(index + 1);
    expect(result.live).toBe(0);
    expect(result.last).toMatchObject({ x: releaseX, y, pressure: 0, kind: "pen" });
    expect(result.counts).toMatchObject({ began: index + 1, ended: index + 1, cancelled: 0 });
    expect(result.visible).toBe(true);
  }
  await session.detach();
  await page.evaluate(() => (window as CaptureLossWindow).captureLossProbe.surface.dispose());
});

test("browser-delivered wide finger contacts navigate the lab", async ({ page, context }) => {
  await page.goto(labURL);
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Lab canvas missing");
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const point = (id: number, x: number, y: number) => ({
    id,
    x: box.x + x,
    y: box.y + y,
    radiusX: 36,
    radiusY: 36,
    force: 0.5,
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(1, 100, 150)],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(1, 100, 150), point(2, 200, 150)],
  });
  for (let i = 1; i <= 5; i++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(1, 100 - i * 4, 150 - i * 2), point(2, 200 + i * 8, 150 + i * 4)],
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("[data-scene-readout]")).toContainText("ink 1.63× / 11°");
  await expect(page.locator("[data-touch-status]")).toContainText("72 × 72 px · move: navigation");
  await expect(page.locator("[data-input-decisions]")).toContainText("0 accepted");
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await session.detach();
});

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
  page.on("console", (message) => {
    if (/STRICT_READ_UNTRACKED|REACTIVE_WRITE/.test(message.text())) errors.push(message.text());
  });
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

test("editable ink renders continuous partial erasure, undo, and cache reconstruction", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      width: "240px",
      height: "160px",
      left: "0",
      top: "0",
    });
    document.body.append(target);
    const params = { ...WRITE, size: 6, grain: 0 };
    const surface = new PencilSurface({ target, localInput: false, params: () => params });
    const ink = surface.document;
    const point = (x: number, y = 60, t = x) => ({
      x,
      y,
      t,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    const pixels = () => {
      surface.view.render();
      const data = surface.canvas
        .getContext("2d")
        .getImageData(0, 0, surface.canvas.width, surface.canvas.height).data;
      let sum = 0;
      for (let i = 3; i < data.length; i += 4) sum += data[i];
      return sum;
    };
    const alpha = (x: number, y = 60) =>
      surface.canvas
        .getContext("2d")
        .getImageData(Math.floor(x * devicePixelRatio), Math.floor(y * devicePixelRatio), 1, 1)
        .data[3];
    ink.begin("line", { tool: "draw", params, point: point(20) });
    ink.append("line", [point(60), point(100), point(140)]);
    ink.finish("line", point(180));
    const drawn = pixels();
    const source = ink.snapshot().strokes[0];
    // Only two eraser samples: the entire crossing between them must be removed.
    ink.begin("cut", { tool: "erase", params: { ...params, size: 8 }, point: point(100, 20, 200) });
    ink.append("cut", [point(100, 100, 240)]);
    const preview = pixels();
    const previewGap = alpha(100);
    ink.finish("cut");
    const erased = pixels();
    const erasedCapture = ink.capture();
    const gap = alpha(100);
    const left = alpha(70);
    const right = alpha(130);
    surface.view.evictCache();
    const rebuilt = pixels();
    ink.undo();
    const restored = pixels();
    const originalId = ink.snapshot().strokes[0].id;
    const pointsPreserved =
      JSON.stringify(ink.snapshot().strokes[0].points) === JSON.stringify(source.points);
    ink.redo();
    const erasedAgain = pixels();
    ink.begin("cancelled", { tool: "draw", params, point: point(30, 120) });
    ink.cancel("cancelled");
    const live = ink.snapshot().live.length;
    ink.clear();
    const capturedCanvas = surface.view.renderCapture(erasedCapture, 240, 160, devicePixelRatio);
    const capturedData = capturedCanvas
      .getContext("2d")
      .getImageData(0, 0, capturedCanvas.width, capturedCanvas.height).data;
    let capturedErased = 0;
    for (let i = 3; i < capturedData.length; i += 4) capturedErased += capturedData[i];
    surface.dispose();
    target.remove();
    return {
      drawn,
      preview,
      previewGap,
      erased,
      gap,
      left,
      right,
      rebuilt,
      restored,
      originalId,
      pointsPreserved,
      erasedAgain,
      capturedErased,
      live,
    };
  }, entry);
  expect(result.drawn).toBeGreaterThan(0);
  expect(result.erased).toBeLessThan(result.drawn);
  expect(result.preview).toBe(result.erased);
  expect(result.previewGap).toBe(0);
  expect(result.gap).toBe(0);
  expect(result.left).toBeGreaterThan(0);
  expect(result.right).toBeGreaterThan(0);
  expect(result.rebuilt).toBe(result.erased);
  expect(result.restored).toBe(result.drawn);
  expect(result.originalId).toBe("line");
  expect(result.pointsPreserved).toBe(true);
  expect(result.erasedAgain).toBe(result.erased);
  expect(result.capturedErased).toBe(result.erased);
  expect(result.live).toBe(0);
});

test("shared ink has independent views, stable coordinates, and immutable captures", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { createInkDocument, createCanvasInkView, WRITE } = await import(path);
    const targets = [0, 1].map((i) => {
      const target = document.createElement("div");
      Object.assign(target.style, {
        position: "fixed",
        left: `${i * 250}px`,
        top: "0",
        width: "240px",
        height: "160px",
      });
      document.body.append(target);
      return target;
    });
    const ink = createInkDocument();
    const a = createCanvasInkView({ document: ink, target: targets[0] });
    const b = createCanvasInkView({
      document: ink,
      target: targets[1],
      viewport: { x: 40, y: 20, scale: 1.5 },
    });
    const point = (x: number, y = 40) => ({
      x,
      y,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    const params = { ...WRITE, size: 5, grain: 0 };
    ink.begin("first", { tool: "draw", params, point: point(20) });
    ink.finish("first", point(80));
    const original = ink.snapshot();
    a.render();
    b.render();
    const context = (canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable");
      return ctx;
    };
    const alpha = (canvas: HTMLCanvasElement, x: number, y: number) =>
      context(canvas).getImageData(
        Math.floor(x * devicePixelRatio),
        Math.floor(y * devicePixelRatio),
        1,
        1,
      ).data[3];
    const aInk = alpha(a.canvas, 40, 40);
    const bInk = alpha(b.canvas, 100, 80);
    const bEmpty = alpha(b.canvas, 40, 40);
    const capture = ink.capture();
    const saved = a.renderCapture(capture, 240, 160);
    const capturedPixels = Array.from(context(saved).getImageData(0, 0, 240, 160).data);
    a.setViewport({ x: 10, y: 5, scale: 2 });
    targets[0].style.width = "300px";
    a.render();
    const unchanged = ink.snapshot() === original;
    const bView = b.getViewport();
    ink.begin("new", { tool: "draw", params, point: point(20, 120) });
    ink.finish("new", point(80, 120));
    ink.retire(capture);
    a.setViewport({ x: 0, y: 0, scale: 1 });
    const replayed = a.renderCapture(capture, 240, 160);
    const replayedPixels = Array.from(context(replayed).getImageData(0, 0, 240, 160).data);
    const captureStable = capturedPixels.every((value, i) => value === replayedPixels[i]);
    const survivors = ink.snapshot().strokes.map((stroke: { id: string }) => stroke.id);
    const captureIds = capture.strokes.map((stroke: { id: string }) => stroke.id);
    a.dispose();
    b.dispose();
    targets.forEach((target) => {
      target.remove();
    });
    return { aInk, bInk, bEmpty, unchanged, bView, captureStable, survivors, captureIds };
  }, entry);
  expect(result.aInk).toBeGreaterThan(0);
  expect(result.bInk).toBeGreaterThan(0);
  expect(result.bEmpty).toBe(0);
  expect(result.unchanged).toBe(true);
  expect(result.bView).toEqual({ x: 40, y: 20, scale: 1.5 });
  expect(result.captureStable).toBe(true);
  expect(result.survivors).toEqual(["new"]);
  expect(result.captureIds).toEqual(["first"]);
});

test("overlay attachment follows scroll and explicitly suspends uncertain layout", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, bindInkAttachment, WRITE } = await import(path);
    const stage = document.createElement("div");
    Object.assign(stage.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "240px",
      height: "160px",
    });
    const scroll = document.createElement("div");
    Object.assign(scroll.style, { width: "240px", height: "160px", overflow: "auto" });
    const content = document.createElement("div");
    content.style.height = "600px";
    scroll.append(content);
    stage.append(scroll);
    document.body.append(stage);
    const params = { ...WRITE, size: 5, grain: 0 };
    const surface = new PencilSurface({ target: stage, params: () => params });
    const attachment = bindInkAttachment({
      surface,
      scrollTarget: scroll,
      viewport: () => ({ x: 0, y: -scroll.scrollTop, scale: 1 }),
      resizeTargets: [scroll],
    });
    const point = (x: number) => ({
      x,
      y: 120,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    surface.document.begin("attached", { tool: "draw", params, point: point(30) });
    surface.document.finish("attached", point(170));
    const record = surface.document.snapshot().strokes[0];
    const frame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    scroll.scrollTop = 50;
    await frame();
    surface.view.render();
    const alpha = (y: number) =>
      surface.canvas
        .getContext("2d")
        .getImageData(80 * devicePixelRatio, y * devicePixelRatio, 1, 1).data[3];
    const movedInk = alpha(70),
      oldPosition = alpha(120);
    surface.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 42,
        pointerType: "pen",
        clientX: 60,
        clientY: 20,
        pressure: 1,
        bubbles: true,
      }),
    );
    const mappedY = surface.document.snapshot().live[0].points[0].y;
    attachment.invalidate();
    const hidden = surface.canvas.style.visibility;
    const cancelled = surface.document.snapshot().live.length;
    scroll.scrollTop = 80;
    await frame();
    const pausedViewport = surface.view.getViewport();
    attachment.resume();
    surface.view.render();
    const resumedInk = alpha(40),
      resumedVisibility = surface.canvas.style.visibility;
    const valid = attachment.valid();
    attachment.dispose();
    scroll.scrollTop = 0;
    await frame();
    const finalViewport = surface.view.getViewport();
    const unchanged = surface.document.snapshot().strokes[0] === record;
    surface.dispose();
    stage.remove();
    return {
      movedInk,
      oldPosition,
      mappedY,
      hidden,
      cancelled,
      pausedViewport,
      resumedInk,
      resumedVisibility,
      valid,
      finalViewport,
      unchanged,
    };
  }, entry);
  expect(result.movedInk).toBeGreaterThan(0);
  expect(result.oldPosition).toBe(0);
  expect(result.mappedY).toBe(70);
  expect(result.hidden).toBe("hidden");
  expect(result.cancelled).toBe(0);
  expect(result.pausedViewport).toEqual({ x: 0, y: -50, scale: 1 });
  expect(result.resumedInk).toBeGreaterThan(0);
  expect(result.resumedVisibility).toBe("");
  expect(result.valid).toBe(true);
  expect(result.finalViewport).toEqual({ x: 0, y: -80, scale: 1 });
  expect(result.unchanged).toBe(true);
});

test("completed ink fades without affecting a live stroke and the renderer becomes idle", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "200px",
      height: "160px",
    });
    document.body.append(target);
    const params = { ...WRITE, size: 6, grain: 0 };
    const surface = new PencilSurface({ target, localInput: false, params: () => params });
    const ink = surface.document;
    const point = (x: number, y: number) => ({
      x,
      y,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    ink.begin("finished", { tool: "draw", params, point: point(20, 40) });
    ink.finish("finished", point(140, 40));
    ink.begin("live", { tool: "draw", params, point: point(20, 100) });
    ink.append("live", [point(140, 100)]);
    surface.fadeCompleted(0.08, false);
    await new Promise((resolve) => setTimeout(resolve, 180));
    surface.view.render();
    const alpha = (y: number) =>
      surface.canvas
        .getContext("2d")
        .getImageData(70 * devicePixelRatio, y * devicePixelRatio, 1, 1).data[3];
    const hiddenAlpha = alpha(40),
      liveAlpha = alpha(100);
    const retained = ink.snapshot().strokes.length;
    ink.cancel("live");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const idle = surface.view.report();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterIdle = surface.view.report();
    surface.fadeCompleted(0, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const removed = ink.snapshot().strokes.length;
    surface.dispose();
    const disposed = surface.view.report();
    target.remove();
    return { hiddenAlpha, liveAlpha, retained, idle, afterIdle, removed, disposed };
  }, entry);
  expect(result.hiddenAlpha).toBe(0);
  expect(result.liveAlpha).toBeGreaterThan(0);
  expect(result.retained).toBe(1);
  expect(result.idle.scheduled).toBe(false);
  expect(result.afterIdle.frames).toBe(result.idle.frames);
  expect(result.removed).toBe(0);
  expect(result.disposed.scheduled).toBe(false);
  expect(result.disposed.cacheBytes).toBe(0);
});

test("Circle measures while drawing, freezes after pen-up and fade, and clears", async ({
  page,
}) => {
  await page.goto(circleURL);
  await drawCircle(page);
  await page.screenshot({ path: test.info().outputPath("circle.png"), fullPage: true });
  const score = await page.locator(".gauge-num").textContent();
  await expect(page.locator(".turn-pill")).not.toHaveClass(/live/);
  await expect
    .poll(() =>
      page.evaluate(
        async (path) => (await import(path)).paper.document.snapshot().strokes.length,
        circleStore,
      ),
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
  await page.goto(circleURL);
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
  await page.goto(`${galleryURL}/circle`);
  await drawCircle(page);
  const initialTurn = await page.locator(".turn-pill").textContent();
  await page.locator('nav a[href="/gears"]').first().click();
  await expect(page.locator("canvas.circle-paper")).toHaveCount(0);
  await page.locator('nav a[href="/circle"]').first().click();
  await expect(page.locator(".turn-pill")).toHaveText(initialTurn ?? "");
  await drawCircle(page);
  await expect(page.locator(".turn-pill")).toHaveText("turn 2");
});

test("lab changes stored stroke profiles without replacing identity and supports undo", async ({
  page,
}) => {
  await page.goto(labURL);
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No lab canvas");
  await page.mouse.move(box.x + 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 130, { steps: 20 });
  await page.mouse.up();
  const count = () =>
    page.evaluate(
      async (path) => (await import(path)).paper.document.snapshot().strokes.length,
      labStore,
    );
  await expect.poll(count).toBe(1);
  const currentStroke = () =>
    page.evaluate(async (path) => {
      const stroke = (await import(path)).paper.document.snapshot().strokes[0];
      return stroke ? { id: stroke.id, size: stroke.params.size, points: stroke.points } : null;
    }, labStore);
  const original = await currentStroke();
  await page.evaluate(async () => {
    const kit = (
      window as unknown as Record<string, { call(name: string, args: unknown): Promise<unknown> }>
    )["__pencil-lab"];
    await kit.call("set", { name: "pencil-lab/size", value: 6 });
  });
  await expect.poll(async () => (await currentStroke())?.size).toBe(6);
  expect((await currentStroke())?.id).toBe(original?.id);
  expect((await currentStroke())?.points).toEqual(original?.points);
  await page.screenshot({ path: test.info().outputPath("lab.png"), fullPage: true });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await currentStroke())?.size).toBe(original?.size);
  expect((await currentStroke())?.id).toBe(original?.id);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.poll(count).toBe(0);
  await expect(page.getByRole("heading", { name: "Remote", exact: true })).toHaveCount(0);
});

test("lab capture review replaces submitted ink while keeping newer writing", async ({ page }) => {
  await page.goto(labURL);
  await expect(page.locator("canvas.paper-canvas")).toBeVisible();
  const draw = (id: string, y: number) =>
    page.evaluate(
      async ({ path, id, y }) => {
        const { paper, currentParams } = await import(path);
        const point = (x: number) => ({
          x,
          y,
          t: x,
          pressure: 1,
          altitude: Math.PI / 2,
          azimuth: 0,
          twist: 0,
          kind: "pen",
          width: 1,
          height: 1,
        });
        paper.document.begin(id, { tool: "draw", params: currentParams(), point: point(30) });
        paper.document.finish(id, point(150));
      },
      { path: labStore, id, y },
    );
  await draw("submitted", 70);
  await page.getByRole("button", { name: "Capture ink", exact: true }).click();
  await expect(page.locator("[data-capture-status]")).toContainText("Captured 1 strokes");
  const originalImage = await page
    .getByAltText("Ink preserved at capture time")
    .getAttribute("src");
  await draw("newer", 120);
  await page.getByRole("button", { name: "Apply sample result", exact: true }).click();
  await expect(page.locator("[data-symbolic-result]")).toHaveText("x² + y² = r²");
  await expect(page.locator("[data-capture-status]")).toContainText("retired 1");
  const ids = await page.evaluate(
    async (path) =>
      (await import(path)).paper.document
        .snapshot()
        .strokes.map((stroke: { id: string }) => stroke.id),
    labStore,
  );
  expect(ids).toEqual(["newer"]);
  expect(await page.getByAltText("Ink preserved at capture time").getAttribute("src")).toBe(
    originalImage,
  );
});

test("lab hot reload replaces view logic while preserving completed ink and input", async ({
  page,
}) => {
  await page.goto(labURL);
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const draw = async (offset: number) => {
    const box = await canvas.boundingBox();
    if (!box) throw new Error("No lab canvas");
    await page.mouse.move(box.x + 40, box.y + 60 + offset);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 80 + offset, { steps: 12 });
    await page.mouse.up();
  };
  await draw(0);
  const realCanvas = await page.evaluate(async (path) => {
    const loaded = performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname === path)
      .at(-1);
    if (!loaded) throw new Error("The app store has not loaded");
    const { paper } = await import(loaded.name);
    (window as ProbeWindow).pencilHmrProbe = {
      document: paper.document,
      view: paper.view,
      canvas: paper.canvas,
      first: paper.document.snapshot().strokes[0],
    };
    return paper.canvas === document.querySelector("canvas.paper-canvas");
  }, labStore);
  expect(realCanvas).toBe(true);
  // Trigger the actual Vite watcher without modifying source contents.
  const now = new Date();
  await utimes(fileURLToPath(new URL("../../lab/src/model/store.ts", import.meta.url)), now, now);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = (window as ProbeWindow).pencilHmrProbe;
        return (
          !!probe &&
          document.querySelector("canvas.paper-canvas") !== probe.canvas &&
          !probe.canvas.isConnected
        );
      }),
    )
    .toBe(true);
  await expect(canvas).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as ProbeWindow).pencilHmrProbe?.view.report().cacheBytes),
    )
    .toBe(0);
  const afterReload = await page.evaluate(() => {
    const probe = (window as ProbeWindow).pencilHmrProbe;
    if (!probe) throw new Error("The page reloaded instead of preserving state through HMR");
    return {
      sameStroke: probe.document.snapshot().strokes[0] === probe.first,
      oldScheduled: probe.view.report().scheduled,
      oldCache: probe.view.report().cacheBytes,
    };
  });
  expect(afterReload).toEqual({ sameStroke: true, oldScheduled: false, oldCache: 0 });
  await draw(50);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ProbeWindow).pencilHmrProbe?.document.snapshot().strokes.length,
      ),
    )
    .toBe(2);
});

test("local input coordinates pen priority, navigation, cancellation, and disposal", async ({
  page,
}) => {
  await page.goto(fixtureURL);
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
      inputOptions: {
        onNavigate: (gesture: {
          from: { x: number; y: number };
          to: { x: number; y: number };
          scale: number;
        }) => {
          if (gesture.from.x !== gesture.to.x || gesture.from.y !== gesture.to.y) pans++;
          if (gesture.scale !== 1) zooms++;
        },
      },
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
    const kinds = surface.document
      .snapshot()
      .strokes.map((stroke: { points: { kind: string }[] }) => stroke.points[0].kind);
    send("pointerdown", "touch", 4, 40, 10);
    send("pointerdown", "touch", 5, 60, 10);
    send("pointermove", "touch", 5, 90, 10);
    const strokeCount = surface.document.snapshot().strokes.length;
    surface.dispose();
    send("pointerdown", "pen", 6);
    const liveAfterDispose = surface.document.snapshot().live.length;
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

for (const viewport of [
  { name: "tablet-landscape", width: 1180, height: 820 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "phone-portrait", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ hasTouch: true });
    test(`lab controls scroll independently at ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(labURL);
      const canvas = page.locator("canvas.paper-canvas");
      const controls = page.getByRole("complementary", {
        name: "Pencil controls and measurements",
      });
      await expect(canvas).toBeVisible();
      await expect(controls).toBeVisible();
      await expect(controls).toHaveAttribute("tabindex", "0");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      expect(
        (await page.getByRole("button", { name: "Undo", exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
      const canvasBefore = await canvas.boundingBox();
      const controlsBefore = await controls.boundingBox();
      if (!canvasBefore || !controlsBefore) throw new Error("Lab panes are missing");
      expect(canvasBefore.height).toBeGreaterThan(200);
      expect(canvasBefore.y + canvasBefore.height).toBeLessThanOrEqual(viewport.height);
      expect(controlsBefore.y + controlsBefore.height).toBeLessThanOrEqual(viewport.height);
      expect(
        await controls.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
      await controls.hover();
      await page.mouse.wheel(0, 650);
      await expect
        .poll(() => controls.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(200);
      expect(await canvas.boundingBox()).toEqual(canvasBefore);
      expect(await controls.boundingBox()).toEqual(controlsBefore);
      expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
        x: 0,
        y: 0,
      });

      // Keyboard users can reach the controls at the end of the pane without moving the page.
      await controls.focus();
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          controls.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(2);
      await expect(page.getByText("fill dabs", { exact: true })).toBeVisible();
      expect(await canvas.boundingBox()).toEqual(canvasBefore);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}.png`) });
    });
  });
}

test("lab completed fades stay hidden through duration changes while captures retain ink", async ({
  page,
}) => {
  await page.goto(labURL);
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const storeURL = await page.evaluate((path) => {
    const loaded = performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname === path)
      .at(-1);
    if (!loaded) throw new Error("Lab store did not load");
    return loaded.name;
  }, labStore);
  const duration = async (seconds: number) => {
    await page.evaluate(
      async ({ path, seconds }) => {
        (await import(path)).fadeSec.set(seconds);
        // Let the reactive appearance bridge and its next paint complete.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      },
      { path: storeURL, seconds },
    );
  };
  const draw = async (y: number) => {
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Lab canvas missing");
    await page.mouse.move(box.x + 40, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + y + 10, { steps: 8 });
    await page.mouse.up();
  };
  const inkPixels = () =>
    page.evaluate(async (path) => {
      const { paper } = await import(path);
      paper.view.render();
      const canvas: HTMLCanvasElement = paper.canvas;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let oldInk = 0,
        newInk = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] === 0 || pixels[i] >= 180 || pixels[i + 1] >= 180 || pixels[i + 2] >= 180)
          continue;
        const y = Math.floor(i / 4 / canvas.width) / devicePixelRatio;
        if (y < 110) oldInk++;
        else newInk++;
      }
      return { oldInk, newInk, strokes: paper.document.snapshot().strokes.length };
    }, storeURL);

  await duration(0.5);
  await draw(60);
  await expect.poll(async () => (await inkPixels()).strokes).toBe(1);
  await expect.poll(async () => (await inkPixels()).oldInk).toBe(0);
  await duration(0);
  expect(await inkPixels()).toEqual({ oldInk: 0, newInk: 0, strokes: 1 });
  await duration(5);
  expect(await inkPixels()).toEqual({ oldInk: 0, newInk: 0, strokes: 1 });

  const capturedInk = await page.evaluate(async (path) => {
    const { paper } = await import(path);
    const capture = paper.document.capture();
    const size = paper.view.size();
    const saved: HTMLCanvasElement = paper.view.renderCapture(capture, size.width, size.height);
    const context = saved.getContext("2d");
    if (!context) throw new Error("Capture unavailable");
    const pixels = context.getImageData(0, 0, saved.width, saved.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180)
        dark++;
    }
    return { strokes: capture.strokes.length, dark };
  }, storeURL);
  expect(capturedInk.strokes).toBe(1);
  expect(capturedInk.dark).toBeGreaterThan(0);
  await duration(0);
  await draw(150);
  await expect.poll(async () => (await inkPixels()).newInk).toBeGreaterThan(0);
  expect((await inkPixels()).oldInk).toBe(0);
  expect((await inkPixels()).strokes).toBe(2);
});

test("Pencil navigation rotates and zooms around fingers, maps new ink, and excludes palms", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE, applyTransform } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "400px",
      height: "300px",
    });
    document.body.append(target);
    const surface = new PencilSurface({
      target,
      params: () => WRITE,
      inputOptions: { penMode: "explicit", penEnabled: true, palmContactPx: 60 },
    });
    surface.setActive(true);
    const send = (type: string, id: number, x: number, y: number, kind = "touch", width = 10) =>
      surface.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: kind,
          clientX: x,
          clientY: y,
          width,
          height: width,
          pressure: 1,
          buttons: type === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    send("pointerdown", 1, 80, 100);
    send("pointerdown", 2, 120, 100);
    send("pointermove", 2, 140, 120);
    send("pointermove", 1, 80, 80);
    const navigated = surface.view.getViewport();
    const anchor = applyTransform({ x: 100, y: 100 }, navigated);
    send("pointerdown", 3, 200, 180, "touch", 90);
    send("pointermove", 3, 230, 210, "touch", 90);
    const afterPalm = surface.view.getViewport();
    send("pointerup", 1, 80, 80);
    send("pointerup", 2, 140, 120);
    send("pointerup", 3, 230, 210, "touch", 90);
    const start = applyTransform({ x: 60, y: 60 }, navigated);
    const end = applyTransform({ x: 90, y: 60 }, navigated);
    send("pointerdown", 4, start.x, start.y, "pen", 1);
    send("pointermove", 4, end.x, end.y, "pen", 1);
    send("pointerup", 4, end.x, end.y, "pen", 1);
    const points = surface.document.snapshot().strokes[0].points;
    const count = surface.document.snapshot().strokes.length;
    surface.dispose();
    const disabled = new PencilSurface({
      target,
      params: () => WRITE,
      navigation: false,
      inputOptions: { penMode: "explicit", penEnabled: true },
    });
    disabled.setActive(true);
    for (const [type, id, x, y] of [
      ["pointerdown", 5, 80, 100],
      ["pointerdown", 6, 120, 100],
      ["pointermove", 6, 160, 130],
    ] as const)
      disabled.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          width: 10,
          height: 10,
          bubbles: true,
        }),
      );
    const unchanged = disabled.view.getViewport();
    disabled.dispose();
    target.remove();
    return {
      navigated,
      anchor,
      afterPalm,
      first: points[0],
      last: points.at(-1),
      count,
      unchanged,
    };
  }, entry);
  expect(result.navigated.scale).toBeCloseTo(Math.hypot(60, 40) / 40);
  expect(result.navigated.rotation).toBeCloseTo(Math.atan2(40, 60));
  expect(result.anchor.x).toBeCloseTo(110);
  expect(result.anchor.y).toBeCloseTo(100);
  expect(result.afterPalm).toEqual(result.navigated);
  expect(result.first.x).toBeCloseTo(60);
  expect(result.first.y).toBeCloseTo(60);
  expect(result.last.x).toBeCloseTo(90);
  expect(result.last.y).toBeCloseTo(60);
  expect(result.count).toBe(1);
  expect(result.unchanged.x).toBe(0);
  expect(result.unchanged.y).toBe(0);
  expect(result.unchanged.scale).toBe(1);
  expect(result.unchanged.rotation ?? 0).toBe(0);
});

test("rotated ink and erasure survive offscreen navigation and cache eviction", async ({
  page,
}) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { PencilSurface, WRITE } = await import(path);
    const target = document.createElement("div");
    Object.assign(target.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "240px",
      height: "240px",
    });
    document.body.append(target);
    const params = {
      ...WRITE,
      size: 8,
      grain: 0,
      flow: 1,
      pressureToAlpha: [1, 1],
      velocityToAlpha: [1, 1],
    };
    const surface = new PencilSurface({ target, localInput: false, params: () => params });
    const point = (x: number, y: number) => ({
      x,
      y,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    const ink = surface.document;
    ink.begin("line", { tool: "draw", params, point: point(40, 100) });
    ink.finish("line", point(180, 100));
    ink.begin("cut", { tool: "erase", params: { ...params, size: 10 }, point: point(100, 80) });
    ink.finish("cut", point(100, 120));
    const original = ink.snapshot();
    const viewport = { x: 200, y: 0, scale: 1, rotation: Math.PI / 2 };
    surface.setViewport(viewport);
    surface.view.render();
    const alpha = (x: number, y: number) =>
      surface.canvas.getContext("2d").getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1)
        .data[3];
    const cut = alpha(100, 100),
      kept = alpha(100, 60);
    const before = surface.canvas.toDataURL();
    surface.setViewport({ ...viewport, x: -1000 });
    surface.view.render();
    const offscreen = surface.canvas
      .getContext("2d")
      .getImageData(0, 0, surface.canvas.width, surface.canvas.height)
      .data.some((value: number, i: number) => i % 4 === 3 && value > 0);
    surface.view.evictCache();
    surface.setViewport(viewport);
    surface.view.render();
    const restored = surface.canvas.toDataURL() === before;
    const unchanged = ink.snapshot() === original;
    surface.dispose();
    target.remove();
    return { cut, kept, offscreen, restored, unchanged };
  }, entry);
  expect(result.cut).toBe(0);
  expect(result.kept).toBeGreaterThan(0);
  expect(result.offscreen).toBe(false);
  expect(result.restored).toBe(true);
  expect(result.unchanged).toBe(true);
});

test("fade spreads and hollows the displayed stroke while capture keeps its solid source", async ({
  page,
}, testInfo) => {
  await page.goto(fixtureURL);
  const result = await page.evaluate(async (path) => {
    const { createInkDocument, CanvasInkView, InkPresentation, WRITE } = await import(path);
    let clock = 0;
    const ink = createInkDocument({ now: () => clock });
    const params = {
      ...WRITE,
      size: 6,
      grain: 0,
      flow: 1,
      pressureToAlpha: [1, 1],
      velocityToAlpha: [1, 1],
    };
    const point = (x: number) => ({
      x,
      y: 60,
      t: x,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    });
    ink.begin("line", { tool: "draw", params, point: point(30) });
    ink.finish("line", point(170));
    const capture = ink.capture();
    const target = document.createElement("div");
    Object.assign(target.style, { position: "relative", width: "200px", height: "120px" });
    document.body.append(target);
    const presentation = new InkPresentation(ink, { durationMs: 1000, now: () => clock });
    const view = new CanvasInkView({ document: ink, target, presentation });
    const picture = (label: string, canvas: HTMLCanvasElement) => {
      const figure = document.createElement("figure"),
        image = document.createElement("img");
      const caption = document.createElement("figcaption");
      caption.textContent = label;
      image.src = canvas.toDataURL();
      image.width = 400;
      figure.append(caption, image);
      document.body.append(figure);
    };
    view.render();
    picture("Ink", view.canvas);
    const alpha = (canvas: HTMLCanvasElement, y: number, density = devicePixelRatio) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      return ctx.getImageData(100 * density, y * density, 1, 1).data[3];
    };
    const originalCenter = alpha(view.canvas, 60),
      originalEdge = alpha(view.canvas, 70);
    clock = 960;
    view.render();
    const hollowCenter = alpha(view.canvas, 60),
      spreadEdge = alpha(view.canvas, 70);
    picture("Spread and hollow", view.canvas);
    const saved = view.renderCapture(capture, 200, 120);
    const captureCenter = alpha(saved, 60, 1);
    picture("Retained capture", saved);
    view.dispose();
    presentation.dispose();
    target.remove();
    return {
      originalCenter,
      originalEdge,
      hollowCenter,
      spreadEdge,
      captureCenter,
      unchanged: ink.snapshot().strokes[0] === capture.strokes[0],
    };
  }, entry);
  expect(result.originalCenter).toBeGreaterThan(0);
  expect(result.originalEdge).toBe(0);
  expect(result.hollowCenter).toBe(0);
  expect(result.spreadEdge).toBeGreaterThan(0);
  expect(result.captureCenter).toBeGreaterThan(0);
  expect(result.unchanged).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("fade-spread.png"), fullPage: true });
});

test("lab links ink to scrolling and transformed content, and pauses uncertain reflow", async ({
  page,
}, testInfo) => {
  await page.goto(labURL);
  const canvas = page.locator("canvas.paper-canvas");
  await expect(canvas).toBeVisible();
  const storeURL = await page.evaluate((path) => {
    const resource = performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname === path)
      .at(-1);
    if (!resource) throw new Error("Lab store missing");
    return resource.name;
  }, labStore);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Lab canvas missing");
  await page.mouse.move(box.x + 60, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 100, { steps: 8 });
  await page.mouse.up();
  const inspect = () =>
    page.evaluate(async (path) => {
      const { paper } = await import(path);
      const scroller = document.querySelector<HTMLElement>(".scene-scroll");
      const content = document.querySelector<HTMLElement>(".scene-content");
      if (!scroller || !content) throw new Error("Scene missing");
      paper.view.render();
      const matrix = new DOMMatrix(getComputedStyle(content).transform);
      const viewport = paper.view.getViewport();
      const pixels = paper.canvas
        .getContext("2d")
        .getImageData(0, 0, paper.canvas.width, paper.canvas.height).data;
      return {
        viewport,
        content: {
          x: matrix.e - scroller.scrollLeft,
          y: matrix.f - scroller.scrollTop,
          scale: Math.hypot(matrix.a, matrix.b),
          rotation: Math.atan2(matrix.b, matrix.a),
        },
        scrollTop: scroller.scrollTop,
        width: content.offsetWidth,
        ink: JSON.stringify(paper.document.snapshot().strokes),
        visiblePixels: pixels.some((value: number, i: number) => i % 4 === 3 && value > 0),
      };
    }, storeURL);
  const assertAligned = async () => {
    const state = await inspect();
    expect(state.content.x).toBeCloseTo(state.viewport.x, 3);
    expect(state.content.y).toBeCloseTo(state.viewport.y, 3);
    expect(state.content.scale).toBeCloseTo(state.viewport.scale, 4);
    expect(state.content.rotation).toBeCloseTo(state.viewport.rotation ?? 0, 4);
    return state;
  };
  const original = await assertAligned();
  expect(original.visiblePixels).toBe(true);
  await canvas.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    const send = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          clientX: rect.x + x,
          clientY: rect.y + y,
          width: 10,
          height: 10,
          bubbles: true,
          cancelable: true,
        }),
      );
    send("pointerdown", 101, 100, 200);
    send("pointerdown", 102, 200, 200);
    send("pointermove", 102, 220, 230);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    send("pointermove", 101, 80, 180);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    send("pointerup", 101, 80, 180);
    send("pointerup", 102, 220, 230);
  });
  const gestured = await assertAligned();
  expect(gestured.viewport.scale).toBeCloseTo(Math.hypot(140, 50) / 100);
  expect(gestured.viewport.rotation).toBeCloseTo(Math.atan2(50, 140));
  expect(gestured.ink).toBe(original.ink);
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page.getByRole("button", { name: "Scroll down", exact: true }).click();
  await expect.poll(async () => (await inspect()).scrollTop).toBe(260);
  const away = await assertAligned();
  expect(away.visiblePixels).toBe(false);
  expect(away.ink).toBe(original.ink);
  await page.getByRole("button", { name: "Scroll up", exact: true }).click();
  await expect.poll(async () => (await inspect()).visiblePixels).toBe(true);
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const transformed = await assertAligned();
  expect(transformed.viewport.rotation).toBeCloseTo(Math.PI / 12);
  expect(transformed.viewport.scale).toBeCloseTo(1.25);
  expect(transformed.ink).toBe(original.ink);
  await page.screenshot({ path: testInfo.outputPath("linked-scene.png") });

  await page.getByLabel("Link ink and content", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Scroll down", exact: true }).click();
  await expect.poll(async () => (await inspect()).scrollTop).toBe(260);
  const separate = await inspect();
  expect(separate.viewport).toEqual(transformed.viewport);
  expect(separate.content.y).toBeCloseTo(transformed.content.y - 260, 3);
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
  const independent = await inspect();
  expect(independent.content.rotation).toBeCloseTo(transformed.content.rotation);
  expect(independent.viewport.rotation).toBeCloseTo(Math.PI / 6);
  await page.getByRole("combobox", { name: "Button target", exact: true }).selectOption("content");
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const contentOnly = await inspect();
  expect(contentOnly.viewport).toEqual(independent.viewport);
  expect(contentOnly.content.rotation).toBeCloseTo(Math.PI / 6);
  expect(contentOnly.content.scale).toBeCloseTo(transformed.content.scale * 1.25);
  expect(contentOnly.ink).toBe(original.ink);
  await page.getByLabel("Link ink and content", { exact: true }).check();
  await assertAligned();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page.getByRole("button", { name: "Reflow content", exact: true }).click();
  await expect(canvas).toBeHidden();
  await expect(page.locator("[data-mapping-status]")).toContainText("Content reflowed");
  expect((await inspect()).width).toBeLessThan(original.width);
  await page.getByRole("button", { name: "Scroll down", exact: true }).click();
  await expect(canvas).toBeHidden();
  expect((await inspect()).ink).toBe(original.ink);
  await page.getByRole("button", { name: "Resume at current coordinates", exact: true }).click();
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Scroll up", exact: true }).click();
  const resumed = await assertAligned();
  expect(resumed.ink).toBe(original.ink);
  expect(resumed.visiblePixels).toBe(true);
});
