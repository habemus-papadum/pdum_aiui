import { expect, type Page, test } from "@playwright/test";

async function inspect(page: Page) {
  return page.evaluate(() => {
    const tools = (
      window as unknown as Record<string, { call: (name: string, args?: object) => unknown }>
    )["__semantic-svg-lab"];
    return tools.call("inspect-circuit") as {
      revision: number;
      selection: { key: string };
      stages: { resistance: number }[];
      camera: { pan: { x: number; y: number } };
      lens: { position: { x: number; y: number } };
    };
  });
}
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "One circuit, several views" })).toBeVisible();
  await page.waitForFunction(() => {
    const svg = document.querySelector<SVGSVGElement>(".svg-lab-board > svg");
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
  });
}

test("editing through the lens updates every view, preserves B, and survives undo/redo and reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await page
    .locator('[data-projection="lens"] [data-feature="a/R1/value"] .svg-lab-value-box')
    .click();
  await page.getByRole("spinbutton", { name: "Resistance in kiloohms" }).fill("6.8");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator('[data-projection="main"] [data-feature="a/R1/value"]')).toContainText(
    "6.8 kΩ",
  );
  await expect(page.locator('[data-projection="lens"] [data-feature="a/R1/value"]')).toContainText(
    "6.8 kΩ",
  );
  await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("6.8 kΩ");
  expect((await inspect(page)).stages.map((stage) => stage.resistance)).toEqual([6800, 10000]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("spinbutton")).toHaveValue("4.7");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByRole("spinbutton")).toHaveValue("6.8");
  await page.reload();
  await expect(page.getByRole("spinbutton")).toHaveValue("6.8");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("hidden feature selection survives lens dismissal and navigation; keyboard selection reaches B", async ({
  page,
}) => {
  await ready(page);
  await page.locator('[data-projection="lens"] [data-feature="a/M1/bulk"] .svg-lab-pin').click();
  await expect(page.locator("[data-semantic-selection]")).toHaveText("a/M1/bulk");
  await page.getByRole("checkbox", { name: "Terminal lens" }).uncheck();
  expect((await inspect(page)).selection.key).toBe("a/M1/bulk");
  await expect(
    page.locator('[data-projection="main"] [data-feature="a/M1/body"] .svg-lab-symbol'),
  ).toHaveClass(/is-related/);
  const overview = await page.locator(".svg-lab-overview").boundingBox();
  if (!overview) throw new Error("Missing overview");
  const before = await inspect(page);
  await page.mouse.click(overview.x + overview.width * 0.8, overview.y + overview.height * 0.5);
  expect((await inspect(page)).camera.pan).not.toEqual(before.camera.pan);
  expect((await inspect(page)).selection.key).toBe("a/M1/bulk");
  expect((await inspect(page)).revision).toBe(0);
  await page.getByRole("button", { name: "Focus B" }).click();
  await page.getByRole("checkbox", { name: "Terminal lens" }).check();
  const value = page.locator('[data-projection="lens"] [data-feature="b/R1/value"]');
  await value.focus();
  await value.press("Enter");
  await expect(page.getByRole("spinbutton")).toHaveValue("10");
  expect((await inspect(page)).selection.key).toBe("b/R1/value");
});

test("a draft detects an intervening programmatic edit", async ({ page }) => {
  await ready(page);
  await page.getByRole("spinbutton").fill("8.2");
  await page.evaluate(() => {
    const tools = (
      window as unknown as Record<string, { call: (name: string, args?: object) => unknown }>
    )["__semantic-svg-lab"];
    tools.call("set-resistance", { key: "a/R1/value", ohms: 6800, expectedRevision: 0 });
  });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The circuit changed");
  expect((await inspect(page)).stages[0].resistance).toBe(6800);
  await page.getByRole("button", { name: "Reload value" }).click();
  await expect(page.getByRole("spinbutton")).toHaveValue("6.8");
});

test("lens dragging and responsive resizing keep the editor inside the lens", async ({ page }) => {
  await ready(page);
  const handle = await page.locator("[data-lens-handle]").boundingBox();
  if (!handle) throw new Error("Missing lens handle");
  const before = await inspect(page);
  await page.mouse.move(handle.x + 30, handle.y + 14);
  await page.mouse.down();
  await page.mouse.move(handle.x + 210, handle.y + 54, { steps: 10 });
  await page.mouse.up();
  expect((await inspect(page)).lens.position).not.toEqual(before.lens.position);
  expect((await inspect(page)).revision).toBe(0);
  for (const width of [360, 390, 414, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("button", { name: "Focus A" }).click();
    await expect(page.getByRole("spinbutton")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect
      .poll(async () => {
        const frame = await page.locator(".svg-lab-lens-frame").boundingBox();
        const editor = await page.locator(".svg-lab-lens-editor").boundingBox();
        return (
          frame &&
          editor &&
          editor.x >= frame.x &&
          editor.x + editor.width <= frame.x + frame.width + 1 &&
          editor.y >= frame.y &&
          editor.y + editor.height <= frame.y + frame.height + 1
        );
      })
      .toBe(true);
    await page.getByRole("spinbutton").fill("5.6");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator('[data-overview-occurrence="a"]')).toContainText("5.6 kΩ");
  }
});
