import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  prepareGuestPage,
} from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
});

test("recommended picker and credit summary fit the active viewport", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("model-option")).toHaveCount(3);
  await expect(dialog.getByTestId("model-selection-summary")).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport!.height);
  await expectNoHorizontalOverflow(page);
});

test("long input explains its multiplier beside the send controls", async ({ page }) => {
  await page.getByTestId("chat-textarea").fill("x".repeat(64_004));
  const estimate = page.getByTestId("request-credit-estimate");
  await expect(estimate).toContainText("1.5×");
  await expect(estimate).toContainText("2");

  const estimateBox = await estimate.boundingBox();
  const inputBox = await page.getByTestId("chat-input").boundingBox();
  expect(estimateBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(estimateBox!.x).toBeGreaterThanOrEqual(inputBox!.x);
  expect(estimateBox!.x + estimateBox!.width).toBeLessThanOrEqual(
    inputBox!.x + inputBox!.width
  );
  expect(estimateBox!.y + estimateBox!.height).toBeLessThanOrEqual(
    inputBox!.y + inputBox!.height
  );
  await expectNoHorizontalOverflow(page);
});
