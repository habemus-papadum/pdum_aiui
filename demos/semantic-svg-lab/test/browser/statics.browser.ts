import { expect, type Page, test } from "@playwright/test";

type BeamState = {
  load: number;
  positionPercent: number;
  left: number;
  right: number;
  freeBody: boolean;
  selection: string | null;
};
async function inspect(page: Page): Promise<BeamState> {
  return page.evaluate(() =>
    (window as unknown as Record<string, { call: (name: string) => BeamState }>)[
      "__semantic-svg-lab"
    ].call("statics/inspect"),
  );
}
async function ready(page: Page) {
  await page.goto("/?lab=statics");
  await expect(page.getByRole("heading", { name: "Where the load goes" })).toBeVisible();
  await page.waitForSelector(".svg-statics-load[data-control]");
  await page.waitForFunction(() => {
    const svg = document.querySelector<SVGSVGElement>(".svg-statics-plate > svg");
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
}
async function moveLoad(page: Page, fraction: number) {
  const grip = await page.locator(".svg-statics-load-grip").boundingBox();
  const beam = await page.locator(".svg-statics-beam").boundingBox();
  if (!grip || !beam) throw new Error("Missing beam or load");
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + fraction * beam.width, y, { steps: 15 });
  await page.mouse.up();
}

test("dragging the load redistributes reactions and the centre preset divides them equally", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await moveLoad(page, 0.4);
  expect(await inspect(page)).toMatchObject({ positionPercent: 70, left: 36, right: 84 });
  await expect(page.locator('[data-reaction="left"]')).toHaveText("36.00 N");
  await page.getByRole("button", { name: "Centre load" }).click();
  expect(await inspect(page)).toMatchObject({ positionPercent: 50, left: 60, right: 60 });
  expect(errors).toEqual([]);
});

test("force and position knobs are shared between SVG and both equilibrium equations", async ({
  page,
}) => {
  await ready(page);
  const force = page.locator('[data-aiui-term="beam-load-force"]');
  const momentForce = page.locator('[data-aiui-term="beam-load-moment"]');
  const diagramForce = page.locator(".svg-statics-knob");
  for (const knob of [force, momentForce, diagramForce])
    await expect(knob).toHaveAttribute("data-control", "semantic-svg-lab/statics/load");
  await force.focus();
  await force.press("ArrowRight");
  expect(await inspect(page)).toMatchObject({ load: 125, left: 87.5, right: 37.5 });
  const bounds = await diagramForce.boundingBox();
  if (!bounds) throw new Error("Missing force label");
  await page.mouse.move(bounds.x + 30, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 54, bounds.y + 15, { steps: 8 });
  await page.mouse.up();
  expect((await inspect(page)).load).toBe(145);
  await expect(momentForce).toHaveAttribute("aria-valuenow", "145");
  const position = page.locator('[data-aiui-term="beam-position"]');
  await expect(position).toHaveAttribute("data-control", "semantic-svg-lab/statics/loadPosition");
  await position.focus();
  await position.press("End");
  expect(await inspect(page)).toMatchObject({ positionPercent: 100, left: 0, right: 145 });
  await expect(page.locator(".svg-statics-zero")).toHaveCount(1);
});

test("selection follows a reaction across the equations and free-body view", async ({ page }) => {
  await ready(page);
  await page.locator('[data-aiui-term="beam-right-moment"]').click();
  expect((await inspect(page)).selection).toBe("right");
  await expect(page.locator('[data-beam-feature="right"]')).toHaveAttribute("data-active", "true");
  const before = await inspect(page);
  await page.getByRole("checkbox", { name: "Free-body view" }).check();
  await expect(page.locator(".svg-statics-support")).toHaveCount(0);
  expect(await inspect(page)).toMatchObject({ ...before, freeBody: true });
  await expect(page.locator('[data-beam-feature="right"]')).toHaveAttribute("data-active", "true");
});

test("load dragging and equation controls work on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await ready(page);
  await moveLoad(page, 0.2);
  expect(await inspect(page)).toMatchObject({ positionPercent: 50, left: 60, right: 60 });
  const force = page.locator('[data-aiui-term="beam-load-force"]');
  await force.focus();
  await force.press("ArrowUp");
  expect(await inspect(page)).toMatchObject({ load: 125, left: 62.5, right: 62.5 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
