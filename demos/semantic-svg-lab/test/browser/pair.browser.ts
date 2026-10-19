import { expect, type Page, test } from "@playwright/test";

type PairState = {
  radiusA: number;
  radiusB: number;
  distance: number;
  angle: number;
  gap: number;
  held: boolean;
  relation: string;
  centerA: { x: number; y: number };
  centerB: { x: number; y: number };
  normal: { x: number; y: number } | null;
  facingA: { x: number; y: number } | null;
  facingB: { x: number; y: number } | null;
  selection: string | null;
};
async function call(page: Page, name: string, args?: Record<string, unknown>) {
  return page.evaluate(
    ({ name, args }) =>
      (
        window as unknown as Record<
          string,
          { call: (name: string, args?: Record<string, unknown>) => unknown }
        >
      )["__semantic-svg-lab"].call(name, args),
    { name, args },
  );
}
async function inspect(page: Page): Promise<PairState> {
  return (await call(page, "pair/inspect")) as PairState;
}
async function ready(page: Page) {
  await page.goto("/?lab=pair");
  await expect(page.getByRole("heading", { name: "Two circles, one contact" })).toBeVisible();
  await page.waitForSelector(".svg-pair-knob[data-control]");
  await page.waitForFunction(() => {
    const svg = document.querySelector<SVGSVGElement>(".svg-pair-plate > svg");
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
}
async function orbit(page: Page, angle: number) {
  const a = await page.locator(".svg-pair-circle.a").boundingBox(),
    b = await page.locator(".svg-pair-circle.b").boundingBox();
  if (!a || !b) throw new Error("Missing circles");
  const ax = a.x + a.width / 2,
    ay = a.y + a.height / 2,
    bx = b.x + b.width / 2,
    by = b.y + b.height / 2;
  const distance = Math.hypot(bx - ax, by - ay);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(
    ax + distance * Math.cos((angle * Math.PI) / 180),
    ay - distance * Math.sin((angle * Math.PI) / 180),
    { steps: 16 },
  );
  await page.mouse.up();
}

test("held tangency follows a changing normal and either radius without a release jump", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await page.getByRole("button", { name: "Keep tangent", exact: true }).click();
  await orbit(page, 90);
  expect(await inspect(page)).toMatchObject({
    held: true,
    angle: 90,
    distance: 115,
    gap: 0,
    relation: "external-tangent",
  });
  const a = page.locator('[data-aiui-term="pair-radius-a"]');
  await a.focus();
  await a.press("Shift+ArrowRight");
  const b = page.locator(".svg-pair-knob.b");
  await b.focus();
  await b.press("ArrowRight");
  const held = await inspect(page);
  expect(held).toMatchObject({ radiusA: 75, radiusB: 45.5, distance: 120.5, gap: 0 });
  expect(held.facingA).toEqual(held.facingB);
  await page.getByRole("button", { name: "Release tangency" }).click();
  expect((await inspect(page)).centerB).toEqual(held.centerB);
  expect(errors).toEqual([]);
});
test("intersection, containment and coincident-centre cases remain distinct", async ({ page }) => {
  await ready(page);
  await call(page, "pair/set-pose", { distance: 90, angle: 0 });
  await expect(page.locator("[data-pair-status]")).toHaveText("Intersecting");
  await expect(page.locator(".svg-pair-crossing")).toHaveCount(2);
  await call(page, "pair/set-pose", { distance: 25, angle: 0 });
  await expect(page.locator("[data-pair-status]")).toHaveText("Internal tangency");
  await expect(page.locator(".svg-pair-tangent")).toHaveCount(1);
  await call(page, "pair/set-pose", { distance: 10, angle: 0 });
  await expect(page.locator("[data-pair-status]")).toHaveText("Contained");
  await expect(page.locator(".svg-pair-tangent")).toHaveCount(0);
  await page.getByRole("button", { name: "Align centres" }).click();
  expect((await inspect(page)).normal).toBeNull();
  await expect(page.locator(".svg-pair-normal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Keep tangent", exact: true })).toBeDisabled();
  await call(page, "set", { name: "semantic-svg-lab/pair/radiusB", value: 70 });
  await expect(page.locator("[data-pair-status]")).toHaveText("Coincident circles");
  const moving = page.locator('[data-pair-feature="moving"]');
  await moving.focus();
  await moving.press("ArrowRight");
  expect((await inspect(page)).normal).toEqual({ x: 1, y: 0 });
  await expect(page.getByRole("button", { name: "Keep tangent", exact: true })).toBeEnabled();
});
test("both circle radii share their SVG and equation controls while free centres stay put", async ({
  page,
}) => {
  await ready(page);
  const before = await inspect(page);
  await expect(page.locator(".svg-pair-knob.a")).toHaveAttribute(
    "data-control",
    "semantic-svg-lab/pair/radiusA",
  );
  await expect(page.locator('[data-aiui-term="pair-radius-a"]')).toHaveAttribute(
    "data-control",
    "semantic-svg-lab/pair/radiusA",
  );
  const knob = await page.locator(".svg-pair-knob.a").boundingBox();
  if (!knob) throw new Error("Missing knob");
  await page.mouse.move(knob.x + 30, knob.y + 15);
  await page.mouse.down();
  await page.mouse.move(knob.x + 54, knob.y + 15, { steps: 8 });
  await page.mouse.up();
  expect((await inspect(page)).radiusA).toBe(77);
  expect((await inspect(page)).centerB).toEqual(before.centerB);
  await page.locator('[data-aiui-term="pair-radius-b"]').focus();
  await page.locator('[data-aiui-term="pair-radius-b"]').press("ArrowUp");
  expect((await inspect(page)).gap).toBe(47.5);
  await page.locator('[data-aiui-term="pair-gap"]').click();
  await expect(page.locator(".svg-pair-gap")).toHaveAttribute("data-active", "true");
});
test("the orbit interaction works on a phone and zoom leaves the model unchanged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Keep tangent", exact: true }).click();
  await orbit(page, 90);
  const before = await inspect(page);
  await call(page, "set", { name: "semantic-svg-lab/pair/pairZoom", value: 1 });
  expect(await inspect(page)).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-pair-feature="moving"]').focus();
  await page.locator('[data-pair-feature="moving"]').press("ArrowLeft");
  expect((await inspect(page)).angle).toBe(91);
  expect((await inspect(page)).gap).toBe(0);
});
