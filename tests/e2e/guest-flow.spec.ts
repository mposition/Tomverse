import { expect, type Page, test } from "@playwright/test";
import {
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

const languageSelect = (page: Page) =>
  page
    .locator("select")
    .filter({ has: page.locator('option[value="ko"]') })
    .last();

const modelSelectorTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

async function openMobileDrawerIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? 1024) >= 768) return;

  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await page.getByTestId("mobile-chat-shell").locator("header button").first().click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");
});

test("guest can change and persist language", async ({ page }) => {
  await page.goto("/chat");
  await openMobileDrawerIfNeeded(page);

  await languageSelect(page).selectOption("en");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_language")))
    .toBe("en");

  await page.reload();
  await openMobileDrawerIfNeeded(page);
  await expect(languageSelect(page)).toHaveValue("en");

  await languageSelect(page).selectOption("zh");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_language")))
    .toBe("zh");

  await page.reload();
  await openMobileDrawerIfNeeded(page);
  await expect(languageSelect(page)).toHaveValue("zh");
});

test("guest message appears immediately with mocked response", async ({ page }) => {
  await page.goto("/chat");

  await page.getByTestId("chat-textarea").fill("First QA message");
  await page.getByTestId("chat-textarea").press("Enter");

  // The guest default is 3 comparison panels, so the same user message and
  // mocked response each legitimately appear once per panel.
  await expect(
    page.locator('[data-message-role="user"]').filter({ hasText: "First QA message" }).first()
  ).toBeVisible();
  await expect(page.getByText("QA mock response", { exact: true }).first()).toBeVisible();
});

test("guest cannot activate a paid model", async ({ page }) => {
  await page.goto("/chat");

  await modelSelectorTrigger(page).click();
  const selectedModels = page.locator('[data-testid="model-option"][aria-pressed="true"]');
  const selectedCountBefore = await selectedModels.count();
  const paidModel = page
    .locator(
      '[data-testid="model-option"][data-model-plan-locked="true"]:not([disabled])'
    )
    .first();

  await expect(paidModel).toBeVisible();
  await paidModel.click();
  await expect(page.getByRole("dialog").last()).toBeVisible();
  // Clicking a plan-locked model must not change the current selection --
  // whatever the guest default was (currently 3 models) stays as it was.
  await expect(selectedModels).toHaveCount(selectedCountBefore);
});
