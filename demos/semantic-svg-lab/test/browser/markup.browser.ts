import { expect, type Page, test } from "@playwright/test";

type MarkupState = {
  phase: string;
  capturedStrokes: number;
  workingStrokeIds: string[];
  laterStrokes: number;
  attachedStrokes: number;
  captureOnlyStrokes: number;
  sourceRevision: number;
  proposal: {
    target: string;
    before: number;
    after: number;
    evidenceRevision: number;
    expectedRevision: number;
  };
};
async function state(page: Page): Promise<MarkupState> {
  return page.evaluate(() =>
    (window as unknown as Record<string, { call: (name: string) => MarkupState }>)[
      "__semantic-svg-lab"
    ].call("inspect-markup"),
  );
}
async function prepare(page: Page, lens = true) {
  await page.goto("/?lab=markup");
  await expect(page.getByRole("heading", { name: "From a mark to a change" })).toBeVisible();
  await page.waitForFunction(() => {
    const svg = document.querySelector<SVGSVGElement>(".svg-lab-board > svg");
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
  if (!lens) await page.getByRole("checkbox", { name: "Terminal lens" }).uncheck();
  await page.getByRole("button", { name: "Begin marking" }).click();
  await page.waitForSelector(".svg-lab-markup-canvas");
  await page.waitForFunction(
    () => (document.querySelector(".svg-lab-markup-pad img") as HTMLImageElement).naturalWidth > 0,
  );
}
async function mark(page: Page, from = { x: 0.22, y: 0.3 }, to = { x: 0.27, y: 0.36 }) {
  const canvas = page.locator(".svg-lab-markup-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing writing surface");
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps: 18 });
  await page.mouse.up();
}
async function captureThenContinue(page: Page) {
  await mark(page);
  await page.getByRole("button", { name: "Capture request" }).click();
  const evidence = await page.locator(".svg-lab-evidence-ink").getAttribute("src");
  await expect(page.getByRole("button", { name: "Review scripted change" })).toBeDisabled();
  await mark(page, { x: 0.65, y: 0.7 }, { x: 0.72, y: 0.75 });
  await expect(page.locator(".svg-lab-evidence-ink")).toHaveAttribute("src", evidence ?? "");
  await page.getByRole("button", { name: "Review scripted change" }).click();
  return evidence;
}

test("guided capture stays immutable, target survives selection changes, and apply keeps newer ink", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await prepare(page);
  await expect(page.getByRole("button", { name: "Capture request" })).toBeDisabled();
  const evidence = await captureThenContinue(page);
  const before = await state(page);
  expect(before.attachedStrokes).toBe(1);
  await expect(page.locator('[data-annotation-target="a/R1/value"]')).toHaveCount(2);
  await page.getByRole("button", { name: "Focus B" }).click();
  expect((await state(page)).proposal.target).toBe("a/R1/value");
  await page.getByRole("button", { name: "Apply proposed change" }).click();
  await expect(page.locator('[data-workflow-phase="applied"]')).toBeVisible();
  expect((await state(page)).workingStrokeIds).toEqual([before.workingStrokeIds[1]]);
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("6.8 kΩ");
  await expect(page.locator('[data-overview-occurrence="b"]')).toContainText("10 kΩ");
  await expect(page.locator(".svg-lab-evidence-ink")).toHaveAttribute("src", evidence ?? "");
  await page.getByRole("button", { name: "Undo circuit change" }).click();
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("4.7 kΩ");
  expect((await state(page)).workingStrokeIds).toEqual([before.workingStrokeIds[1]]);
  expect(errors).toEqual([]);
});

test("intervening edits require explicit review and leave the original request untouched", async ({
  page,
}) => {
  await prepare(page);
  const evidence = await captureThenContinue(page);
  await page.getByRole("button", { name: "Try an intervening edit" }).click();
  await expect(
    page.getByRole("heading", { name: "The circuit changed after capture" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try original proposal" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was applied");
  expect((await state(page)).workingStrokeIds).toHaveLength(2);
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("8.2 kΩ");
  await page.getByRole("button", { name: "Review current circuit" }).click();
  expect((await state(page)).proposal).toMatchObject({
    before: 8200,
    after: 6800,
    expectedRevision: 1,
    evidenceRevision: 0,
  });
  await page.getByRole("button", { name: "Apply proposed change" }).click();
  await expect(page.locator(".svg-lab-evidence-ink")).toHaveAttribute("src", evidence ?? "");
  await page.getByRole("button", { name: "Undo circuit change" }).click();
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("8.2 kΩ");
});

test("main-view markup survives resizing and the guided workflow works on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await prepare(page, false);
  await mark(page, { x: 0.4, y: 0.3 }, { x: 0.55, y: 0.37 });
  await page.setViewportSize({ width: 414, height: 900 });
  await page.getByRole("button", { name: "Capture request" }).click();
  const evidence = await page.locator(".svg-lab-evidence-ink").getAttribute("src");
  await mark(page, { x: 0.6, y: 0.7 }, { x: 0.67, y: 0.76 });
  await page.getByRole("button", { name: "Review scripted change" }).click();
  await page.getByRole("button", { name: "Apply proposed change" }).click();
  await expect(page.locator('[data-workflow-phase="applied"]')).toBeVisible();
  expect((await state(page)).laterStrokes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".svg-lab-evidence-ink")).toHaveAttribute("src", evidence ?? "");
});

test("marks crossing the lens boundary stay in evidence without a false object attachment", async ({
  page,
}) => {
  await prepare(page);
  await mark(page, { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.32 });
  await page.getByRole("button", { name: "Capture request" }).click();
  expect(await state(page)).toMatchObject({
    capturedStrokes: 1,
    attachedStrokes: 0,
    captureOnlyStrokes: 1,
  });
  await mark(page, { x: 0.6, y: 0.7 }, { x: 0.7, y: 0.75 });
  await page.getByRole("button", { name: "Review scripted change" }).click();
  await expect(page.locator("[data-annotation-target]")).toHaveCount(0);
  await page.getByRole("button", { name: "Keep current value" }).click();
  expect((await state(page)).workingStrokeIds).toHaveLength(2);
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("4.7 kΩ");
});
