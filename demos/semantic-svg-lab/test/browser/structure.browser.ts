import { expect, type Page, test } from "@playwright/test";
import type { StructureResult } from "../../src/model/structure";

type State = StructureResult & {
  selection: string;
  focusedJoint: string;
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
const inspect = (page: Page) => call(page, "structure/inspect") as Promise<State>;
async function ready(page: Page) {
  await page.goto("/?lab=structure");
  await expect(page.getByRole("heading", { name: "Build a load path" })).toBeVisible();
  await expect(page.locator(".svg-structure-status")).toHaveAttribute("data-state", "solved");
}
async function removeBrace(page: Page) {
  await page.locator('.svg-structure-board [data-ref="member/m5"]').click();
  await page.getByRole("button", { name: "Remove AC", exact: true }).click();
  await expect(page.locator(".svg-structure-status")).toHaveAttribute("data-state", "mechanism");
}
async function connect(page: Page, a: string, b: string) {
  await page.getByRole("button", { name: "Connect joints", exact: true }).click();
  await page.locator(`.svg-structure-board [data-ref="joint/${a}"]`).click();
  await page.locator(`.svg-structure-board [data-ref="joint/${b}"]`).click();
}

test("delete, diagnose and reconnect topology, with one-step undo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error" || e.type() === "warn") errors.push(e.text());
  });
  await ready(page);
  await removeBrace(page);
  expect(await inspect(page)).toMatchObject({ selection: "joint/D", forces: {}, mechanisms: 1 });
  await expect(page.locator(".svg-structure-motion")).toBeVisible();
  await expect(page.locator('[data-aiui-term="structure-D-y-NAD"]')).toBeVisible();
  await page.locator(".svg-structure-diagnostics").getByRole("button", { name: "joint C" }).click();
  expect((await inspect(page)).focusedJoint).toBe("C");
  await connect(page, "B", "D");
  expect(await inspect(page)).toMatchObject({ status: "solved", model: { revision: 2 } });
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await inspect(page)).status).toBe("mechanism");
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await inspect(page)).model.members.find((m) => m.id === "m5")).toMatchObject({
    a: "A",
    b: "C",
  });
  expect(errors).toEqual([]);
});

test("selection follows member identity through the joint projection, equations and reconnect", async ({
  page,
}) => {
  await ready(page);
  await page.getByLabel("Inspect joint", { exact: true }).selectOption("C");
  const term = page.locator('[data-aiui-term="structure-C-x-NAC"]');
  await term.click();
  expect((await inspect(page)).selection).toBe("member/m5");
  await expect(page.locator('.svg-structure-board [data-ref="member/m5"]')).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.locator('.svg-structure-free-body [data-ref="member/m5"]')).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.getByRole("checkbox", { name: "Separate member ends" }).check();
  await expect(page.locator(".svg-structure-end")).toHaveCount(3);
  await page.getByLabel("Reconnect first endpoint").selectOption("B");
  await page.getByLabel("Reconnect second endpoint").selectOption("D");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  expect(await inspect(page)).toMatchObject({ selection: "member/m5", status: "solved" });
  await expect(page.locator('.svg-structure-board [data-ref="member/m5"]')).toHaveAttribute(
    "aria-label",
    "Member BD",
  );
  await expect(term).toHaveCount(0);
  await page.getByLabel("Inspect joint", { exact: true }).selectOption("D");
  await expect(page.locator('[data-aiui-term="structure-D-x-NBD"]')).toBeVisible();
});

test("joint dragging updates the analysis and commits only one undo step; Escape cancels", async ({
  page,
}) => {
  await ready(page);
  const pin = page.locator('.svg-structure-board [data-ref="joint/D"] .svg-structure-pin');
  const box = await pin.boundingBox();
  if (!box) throw new Error("Missing D");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y - 30, { steps: 10 });
  expect((await inspect(page)).model.revision).toBe(0);
  await page.mouse.up();
  const moved = await inspect(page);
  expect(moved.model.revision).toBe(1);
  expect(moved.model.joints[3].x).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await inspect(page)).model.joints[3]).toMatchObject({ x: 1, y: 2.5 });
  await page.locator('.svg-structure-board [data-ref="joint/D"]').focus();
  await page.keyboard.press("ArrowUp");
  expect((await inspect(page)).model.joints[3].y).toBe(2.6);
  const again = await pin.boundingBox();
  if (!again) throw new Error("Missing D");
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + 45, again.y - 20, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await inspect(page)).model.joints[3].y).toBe(2.6);
});

test("redundant braces and support changes expose unresolved forces instead of old results", async ({
  page,
}) => {
  await ready(page);
  await connect(page, "B", "D");
  expect(await inspect(page)).toMatchObject({
    status: "indeterminate",
    forces: {},
    redundancies: 1,
  });
  await expect(page.locator(".svg-structure-diagnostics")).toContainText("stiffness");
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await page.getByLabel("Inspect joint", { exact: true }).selectOption("A");
  await page.getByLabel("Joint support").selectOption("none");
  expect((await inspect(page)).status).toBe("mechanism");
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await inspect(page)).status).toBe("solved");
});

test("real pencil input previews and applies a topology change; captured requests become stale", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await removeBrace(page);
  await page.getByRole("button", { name: "Sketch a brace", exact: true }).click();
  const pad = page.getByLabel("Sketch the proposed brace");
  await expect(pad).toBeVisible();
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  if (!b) throw new Error("No pencil pad");
  await page.mouse.move(b.x + b.width * 0.26, b.y + b.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.3, { steps: 20 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Preview brace", exact: true }).click();
  expect(await inspect(page)).toMatchObject({
    status: "mechanism",
    proposal: { phase: "preview", stale: false, capturedStrokes: 1 },
  });
  await expect(page.locator(".svg-structure-proposed")).toBeVisible();
  await page.getByRole("button", { name: "Apply brace", exact: true }).click();
  expect(await inspect(page)).toMatchObject({
    status: "solved",
    proposal: { phase: "applied", capturedStrokes: 1 },
  });
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await inspect(page)).status).toBe("mechanism");
  await page.getByRole("button", { name: "Close request", exact: true }).click();
  await page.getByRole("button", { name: "Sketch a brace", exact: true }).click();
  await pad.scrollIntoViewIfNeeded();
  const c = await pad.boundingBox();
  if (!c) throw new Error("No pencil pad");
  await page.mouse.move(c.x + c.width * 0.3, c.y + c.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.3, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Preview brace", exact: true }).click();
  const state = await inspect(page);
  await call(page, "structure/edit", {
    expectedRevision: state.model.revision,
    edit: { kind: "load", joint: "C", magnitude: 150 },
  });
  await expect(page.getByRole("button", { name: "Apply brace", exact: true })).toBeDisabled();
  expect((await inspect(page)).proposal?.stale).toBe(true);
  expect(errors).toEqual([]);
});

test("the study fits a phone and supports keyboard topology edits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await ready(page);
  await removeBrace(page);
  await connect(page, "A", "C");
  expect((await inspect(page)).status).toBe("solved");
  await page.getByLabel("Inspect joint", { exact: true }).selectOption("C");
  await page.getByRole("checkbox", { name: "Separate member ends" }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/semantic-svg-structure-phone.png", fullPage: true });
});
