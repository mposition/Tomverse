import { expect, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  prepareGuestPage,
} from "./support/app-fixtures";

const actionMenuTrigger = (page: import("@playwright/test").Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();

const modelMenuTrigger = (page: import("@playwright/test").Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/chat");
});

test("desktop shell fits compact viewport", async ({ page }) => {
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const inputBox = await page.getByTestId("chat-input").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(768);
});

test("desktop model selector adds a second free model panel", async ({ page }) => {
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(1);

  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();

  const freeUnselectedModel = dialog
    .locator('[data-testid="model-option"][aria-pressed="false"]:not([disabled])')
    .filter({ hasText: "Free" })
    .first();
  await expect(freeUnselectedModel).toBeVisible();
  await freeUnselectedModel.click();

  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
});

test("action and model popovers remain visible and keyboard closable", async ({ page }) => {
  const actions = actionMenuTrigger(page);
  await actions.click();

  const actionDialog = page.locator("#chat-input-popover");
  await expect(actionDialog).toBeVisible();
  let box = await actionDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);

  await page.keyboard.press("Escape");
  await expect(actionDialog).toBeHidden();
  await expect(actions).toBeFocused();

  const models = modelMenuTrigger(page);
  await models.click();
  const modelDialog = page.locator("#chat-input-popover");
  await expect(modelDialog).toBeVisible();
  box = await modelDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);

  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(modelDialog).toBeHidden();
  await expect(models).toBeFocused();
});

test("dropping a file does not navigate the browser", async ({ page }) => {
  const before = page.url();
  const transfer = await page.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["qa"], "qa.txt", { type: "text/plain" }));
    return dataTransfer;
  });

  await page.getByTestId("chat-input").dispatchEvent("dragover", {
    dataTransfer: transfer,
  });
  await page.getByTestId("chat-input").dispatchEvent("drop", {
    dataTransfer: transfer,
  });

  await expect(page).toHaveURL(before);
});
