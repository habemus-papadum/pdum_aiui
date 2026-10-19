import { expect, type Page, test } from "@playwright/test";
import type { DCResult } from "../../src/model/dc-circuit";
import type { DCLayout } from "../../src/model/dc-layout";

type State = DCResult & {
  anchor: string;
  selection: string;
  layout: DCLayout;
  proposal: { phase: string; stale: boolean; capturedStrokes: number } | null;
};
async function call(page: Page, name: string, args?: unknown) {
  return page.evaluate(
    ({ name, args }) =>
      (window as unknown as Record<string, { call: (name: string, args?: unknown) => unknown }>)[
        "__semantic-svg-lab"
      ].call(name, args),
    { name, args },
  );
}
const inspect = (page: Page) => call(page, "dc/inspect") as Promise<State>;
async function ready(page: Page) {
  await page.goto("/?lab=dc");
  await expect(
    page.getByRole("heading", { name: "Trace a circuit, repair a connection" }),
  ).toBeVisible();
  await expect(page.locator("[data-dc-output]")).toHaveText("6.000 V");
}
async function connect(page: Page, a: string, b: string) {
  await page.getByRole("button", { name: "Connect terminals", exact: true }).click();
  await page.locator(`.svg-dc-board [data-ref="pin/${a}"]`).click();
  await page.locator(`.svg-dc-board [data-ref="pin/${b}"]`).click();
}
test("open a return, inspect its split net, reconnect and undo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await page.locator('.svg-dc-board [data-ref="wire/w3"] text').click();
  await page.getByRole("button", { name: "Disconnect W3", exact: true }).click();
  expect(await inspect(page)).toMatchObject({
    anchor: "R2/b",
    selection: "pin/R2/b",
    output: expect.closeTo(12),
    sourceCurrent: expect.closeTo(0),
    goalMet: false,
  });
  await expect(page.locator('.svg-dc-diagnostics [data-diagnostic="no-load-path"]')).toBeVisible();
  await expect(page.locator('.svg-dc-net-view [data-ref="pin/V1/n"]')).toHaveCount(0);
  await connect(page, "R2/b", "V1/n");
  expect((await inspect(page)).goalMet).toBe(true);
  await page.getByRole("button", { name: "Undo circuit edit", exact: true }).click();
  expect((await inspect(page)).output).toBeCloseTo(12);
  await page.getByRole("button", { name: "Redo circuit edit", exact: true }).click();
  expect((await inspect(page)).output).toBeCloseTo(6);
  expect(errors).toEqual([]);
});
test("equation selection and wire reconnection retain the underlying object identity", async ({
  page,
}) => {
  await ready(page);
  await page.locator('[data-aiui-term="dc-kcl-part-RL"]').click();
  expect((await inspect(page)).selection).toBe("part/RL");
  await expect(page.locator('.svg-dc-board [data-ref="part/RL"]')).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.locator('.svg-dc-board [data-ref="wire/w3"] text').click();
  await page.getByLabel("Wire first terminal").selectOption("R2/b");
  await page.getByLabel("Wire second terminal").selectOption("V1/p");
  await page.getByRole("button", { name: "Reconnect selected wire", exact: true }).click();
  const state = await inspect(page);
  expect(state.selection).toBe("wire/w3");
  expect(state.model.wires.find((w) => w.id === "w3")).toMatchObject({ a: "R2/b", b: "V1/p" });
  expect(state.output).toBeCloseTo(12);
  await page.getByRole("button", { name: "Undo circuit edit", exact: true }).click();
  expect((await inspect(page)).goalMet).toBe(true);
});
test("moving a symbol changes only presentation and arrow keys have the same scope", async ({
  page,
}) => {
  await ready(page);
  const before = await inspect(page);
  const part = page.locator('.svg-dc-board [data-ref="part/RL"] rect.svg-dc-resistor');
  await part.scrollIntoViewIfNeeded();
  const box = await part.boundingBox();
  if (!box) throw new Error("Missing RL");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 - 25, { steps: 10 });
  await page.mouse.up();
  const after = await inspect(page);
  expect(after.layout.RL).not.toEqual(before.layout.RL);
  expect(after.model).toEqual(before.model);
  expect(after.branches).toEqual(before.branches);
  await expect(page.getByRole("button", { name: "Undo circuit edit", exact: true })).toBeDisabled();
  await page.locator('.svg-dc-board [data-ref="part/RL"]').focus();
  await page.keyboard.press("ArrowUp");
  expect((await inspect(page)).layout.RL.y).toBe(after.layout.RL.y - 10);
  await page.getByRole("checkbox", { name: "Voltage lens" }).uncheck();
  expect((await inspect(page)).model).toEqual(before.model);
});
test("floating loads preserve referenced values; a supply short clears values until repaired", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Isolated load", exact: true }).click();
  expect(await inspect(page)).toMatchObject({
    status: "floating",
    output: expect.closeTo(8),
    branches: { RL: { current: 0 } },
  });
  await page
    .locator('.svg-dc-diagnostics [data-diagnostic^="floating"] [data-ref="pin/RL/a"]')
    .click();
  expect((await inspect(page)).anchor).toBe("RL/a");
  await expect(page.locator(".svg-dc-net-voltage")).toHaveText("unresolved");
  await page.getByRole("button", { name: "Shorted supply", exact: true }).click();
  await expect(page.locator("[data-dc-output]")).toHaveText("unresolved");
  const short = await inspect(page);
  expect(short.status).toBe("short");
  expect(short.branches.R1.current).toBeNull();
  const last = short.model.wires.at(-1);
  if (!last) throw new Error("Missing bypass");
  await page.locator(`.svg-dc-diagnostics [data-ref="wire/${last.id}"]`).click();
  await page
    .getByRole("button", { name: `Disconnect ${last.id.toUpperCase()}`, exact: true })
    .click();
  expect((await inspect(page)).goalMet).toBe(true);
});
async function sketch(page: Page) {
  await page.getByRole("button", { name: "Sketch return", exact: true }).click();
  const pad = page.getByLabel("Sketch the return wire");
  await expect(pad).toBeVisible();
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  if (!b) throw new Error("Missing pad");
  await page.mouse.move(b.x + b.width * 0.48, b.y + b.height * 0.74);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.48, b.y + b.height * 0.82, { steps: 5 });
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.82, { steps: 12 });
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.61, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Preview connection", exact: true }).click();
}
test("Pencil captures a return proposal; layout changes preserve it and electrical changes stale it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await page.getByRole("button", { name: "Open return", exact: true }).click();
  await sketch(page);
  expect(await inspect(page)).toMatchObject({
    output: expect.closeTo(12),
    proposal: { phase: "preview", capturedStrokes: 1, stale: false },
  });
  await call(page, "dc/place", { part: "R2", x: 450, y: 300 });
  await expect(page.getByRole("button", { name: "Apply connection", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply connection", exact: true }).click();
  expect((await inspect(page)).goalMet).toBe(true);
  await page.getByRole("button", { name: "Close request", exact: true }).click();
  await page.getByRole("button", { name: "Open return", exact: true }).click();
  await sketch(page);
  const current = await inspect(page);
  await call(page, "dc/edit", {
    expectedRevision: current.model.revision,
    edit: { kind: "resistance", part: "R2", ohms: 3000 },
  });
  await expect(page.getByRole("button", { name: "Apply connection", exact: true })).toBeDisabled();
  expect((await inspect(page)).proposal?.stale).toBe(true);
  expect(errors).toEqual([]);
});
test("phone wiring and value edits stay usable without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await ready(page);
  await page.getByRole("button", { name: "Open return", exact: true }).click();
  await connect(page, "R2/b", "V1/n");
  expect((await inspect(page)).goalMet).toBe(true);
  await page.getByLabel("Value component").selectOption("R1");
  await page.getByLabel("Component value").fill("2000");
  await page.getByRole("button", { name: "Apply value", exact: true }).click();
  expect((await inspect(page)).output).toBeCloseTo(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/semantic-svg-dc-phone.png", fullPage: true });
});

test("an intervening electrical edit cannot silently overwrite a value draft", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Component value").fill("3000");
  const current = await inspect(page);
  await call(page, "dc/edit", {
    expectedRevision: current.model.revision,
    edit: { kind: "resistance", part: "R1", ohms: 2000 },
  });
  await page.getByRole("button", { name: "Apply value", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("circuit changed");
  expect((await inspect(page)).model.resistance.R1).toBe(2000);
  await page.getByRole("button", { name: "Reload value", exact: true }).click();
  await expect(page.getByLabel("Component value")).toHaveValue("2000");
});
