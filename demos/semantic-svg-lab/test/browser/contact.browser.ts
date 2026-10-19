import { expect, type Page, test } from "@playwright/test";

type ContactState = {
  radius: number;
  height: number;
  gap: number;
  locked: boolean;
  center: { x: number; y: number };
  state: string;
  selection: string | null;
};
async function inspect(page: Page): Promise<ContactState> {
  return page.evaluate(() =>
    (window as unknown as Record<string, { call: (name: string) => ContactState }>)[
      "__semantic-svg-lab"
    ].call("contact/inspect"),
  );
}
async function ready(page: Page) {
  await page.goto("/?lab=contact");
  await expect(page.getByRole("heading", { name: "When a circle meets a line" })).toBeVisible();
  await page.waitForSelector(".svg-contact-radius-knob[data-control]");
  await page.waitForFunction(() => {
    const svg = document.querySelector<SVGSVGElement>(".svg-contact-plate > svg");
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
}
async function dragCircle(page: Page, dx: number, dy: number) {
  const circle = await page.locator(".svg-contact-circle").boundingBox();
  if (!circle) throw new Error("Missing circle");
  // Grab the left interior, clear of the radius and normal interaction targets.
  const x = circle.x + circle.width * 0.3;
  const y = circle.y + circle.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

test("circle dragging changes the signed gap; one-time tangency remains freely editable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await dragCircle(page, 35, 100);
  expect((await inspect(page)).gap).toBeLessThan(0);
  await expect(page.locator("[data-contact-status]")).toHaveText("Crossing the line");
  await page.getByRole("button", { name: "Touch once" }).click();
  expect(await inspect(page)).toMatchObject({ gap: 0, locked: false, state: "tangent" });
  const body = page.locator('[data-contact-feature="circle"]');
  await body.focus();
  await body.press("ArrowDown");
  expect((await inspect(page)).gap).toBe(-0.5);
  await body.press("ArrowUp");
  await body.press("ArrowUp");
  expect((await inspect(page)).gap).toBe(0.5);
  expect(errors).toEqual([]);
});

test("SVG and equation radius knobs drive the same declared control", async ({ page }) => {
  await ready(page);
  const svgKnob = page.locator(".svg-contact-radius-knob");
  const equationKnob = page.locator('[data-aiui-term="contact-radius"]');
  await expect(svgKnob).toHaveAttribute("data-control", "semantic-svg-lab/contact/radius");
  await expect(equationKnob).toHaveAttribute("data-control", "semantic-svg-lab/contact/radius");
  await equationKnob.focus();
  await equationKnob.press("ArrowRight");
  expect((await inspect(page)).radius).toBe(60.5);
  await expect(svgKnob).toHaveAttribute("aria-valuenow", "60.5");
  const bounds = await svgKnob.boundingBox();
  if (!bounds) throw new Error("Missing radius knob");
  await page.mouse.move(bounds.x + 40, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 88, bounds.y + 15, { steps: 12 });
  await page.mouse.up();
  expect((await inspect(page)).radius).toBe(76.5);
  await expect(equationKnob).toHaveAttribute("aria-valuenow", "76.5");
  await expect(page.locator(".svg-contact-substitution")).toContainText("140.0 − 76.5 = 63.5 mm");
  await page.locator('[data-aiui-term="contact-height"]').click();
  await expect(page.locator('[data-contact-feature="height"]')).toHaveClass(/is-active/);
  expect((await inspect(page)).selection).toBe("height");
});

test("held tangency survives body and radius drags; releasing does not jump", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Keep tangent" }).click();
  const before = await inspect(page);
  await dragCircle(page, 80, -80);
  const after = await inspect(page);
  expect(after.center.x).toBeGreaterThan(before.center.x);
  expect(after.height).toBe(after.radius);
  expect(after.gap).toBe(0);
  const knob = page.locator('[data-aiui-term="contact-radius"]');
  await knob.focus();
  await knob.press("Shift+ArrowRight");
  const grown = await inspect(page);
  expect(grown.radius).toBe(65);
  expect(grown.height).toBe(65);
  expect(grown.gap).toBe(0);
  await page.getByRole("button", { name: "Release tangency" }).click();
  expect((await inspect(page)).center).toEqual(grown.center);
  await page.locator('[data-contact-feature="circle"]').press("ArrowUp");
  expect((await inspect(page)).gap).toBe(0.5);
});

test("the same interaction works in a narrow viewport without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Keep tangent" }).click();
  await dragCircle(page, 35, -35);
  expect((await inspect(page)).gap).toBe(0);
  const knob = page.locator('[data-aiui-term="contact-radius"]');
  await knob.focus();
  await knob.press("ArrowLeft");
  expect((await inspect(page)).radius).toBe(59.5);
  expect((await inspect(page)).height).toBe(59.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
