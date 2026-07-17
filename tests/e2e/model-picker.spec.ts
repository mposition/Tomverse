import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
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
  await expect(dialog.getByTestId("recommended-model-option")).toHaveCount(3);
  await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(3);
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

test("mobile model picker scrolls from recommendations through the full model list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await modelMenuTrigger(page).click();

  const dialog = page.locator("#chat-input-popover");
  const scrollRegion = dialog.getByTestId("model-picker-scroll-region");
  const summary = dialog.getByTestId("model-selection-summary");
  await expect(scrollRegion).toBeVisible();
  await expect(summary).toBeVisible();

  const dimensions = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const lastModel = dialog.getByTestId("model-option").last();
  await lastModel.scrollIntoViewIfNeeded();
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(lastModel).toBeVisible();
  await expect(summary).toBeVisible();
});

test("search hides recommendations and shows matching full-list models", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog.getByTestId("model-recommendations")).toBeVisible();

  await dialog.getByTestId("model-search-input").fill("Perplexity Sonar Deep Research");

  await expect(dialog.getByTestId("model-recommendations")).toHaveCount(0);
  await expect(
    dialog.locator(
      '[data-testid="model-option"][data-model-id="perplexity/sonar-deep-research"]'
    )
  ).toBeVisible();
  await expect(dialog.getByTestId("model-option")).toHaveCount(1);
});

test("recommended shortcuts stay synchronized with the full model list", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.reload();
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  const recommended = dialog.getByTestId("recommended-model-option").nth(1);
  const modelId = await recommended.getAttribute("data-model-id");
  expect(modelId).toBeTruthy();
  const fullListOption = dialog.locator(
    `[data-testid="model-option"][data-model-id="${modelId}"]`
  );

  await recommended.click();
  await expect(recommended).toHaveAttribute("aria-pressed", "true");
  await expect(fullListOption).toHaveAttribute("aria-pressed", "true");

  await fullListOption.click();
  await expect(recommended).toHaveAttribute("aria-pressed", "false");
  await expect(fullListOption).toHaveAttribute("aria-pressed", "false");
});

test("completed model finder answers personalize the recommendation shortcuts", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.unroute("**/api/user/model-finder");
  await page.route("**/api/user/model-finder", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        variant: "treatment",
        shouldShow: false,
        settings: {
          preferredTasks: ["coding"],
          preferredPriority: "deep",
          usesFilesFrequently: "rarely",
          defaultModelId: "deepseek-v4-flash",
          modelFinderCompletedAt: "2026-07-17T00:00:00.000Z",
          modelFinderDismissedAt: null,
        },
      }),
    })
  );
  await page.reload();

  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  const recommendations = dialog.getByTestId("model-recommendations");
  await expect(recommendations).toHaveAttribute(
    "aria-label",
    /Recommended for you|나에게 추천/
  );
  await expect(
    recommendations.locator(
      '[data-testid="recommended-model-option"][data-model-id="deepseek-v4-flash"]'
    )
  ).toBeVisible();
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
