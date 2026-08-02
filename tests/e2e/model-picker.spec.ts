import { expect, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  modelMenuTrigger,
  openModelCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
});

test("opening the picker shows recommendations only, not the full catalogue", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();

  const recommendations = dialog.getByTestId("recommended-model-option");
  const count = await recommendations.count();
  expect(count).toBeGreaterThanOrEqual(6);
  expect(count).toBeLessThanOrEqual(8);

  // STG-F008: the 30+ model list and the advanced filters are one step away,
  // so a beginner is not asked to understand provider/usage filters first.
  await expect(dialog.getByTestId("model-option")).toHaveCount(0);
  await expect(dialog.getByTestId("model-filter-sheet-trigger")).toHaveCount(0);
  await expect(dialog.getByTestId("model-task-filter")).toHaveCount(0);

  // The search entry point and the completion control stay on this screen --
  // the 2026-07-17 collapsed picker was reverted precisely because search was
  // hidden behind the expand.
  await expect(dialog.getByTestId("model-search-input")).toBeVisible();
  await expect(dialog.getByTestId("model-picker-open-all")).toBeVisible();
  await expect(dialog.getByTestId("model-selection-summary")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("every recommendation explains itself in task language with an exact cost", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  const cards = dialog.getByTestId("recommended-model-option");

  for (let index = 0; index < (await cards.count()); index += 1) {
    const card = cards.nth(index);
    await expect(card).toHaveAttribute("aria-pressed", /true|false/);
    await expect(card).toHaveAttribute("data-recommendation-source", /.+/);
    await expect(card.getByTestId("recommended-model-credit-badge")).toBeVisible();
    // Provider names may appear in the model name, never as the reason.
    const reason = await card.getAttribute("data-recommendation-source");
    expect(reason).not.toBe("");
  }
});

test("All models reveals the full catalogue and its filters", async ({ page }) => {
  const dialog = await openModelCatalogue(page);

  await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(20);
  await expect(dialog.getByTestId("model-task-filter")).toBeVisible();
  await expect(dialog.getByTestId("model-filter-sheet-trigger")).toBeVisible();
  await expect(dialog.getByTestId("model-catalogue-result-count")).toBeVisible();
  await expect(dialog.getByTestId("recommended-model-option")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("new models are listed and historical retirements stay hidden on desktop and mobile", async ({
  page,
}) => {
  const dialog = await openModelCatalogue(page);

  for (const modelId of [
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-6-luna",
    "gemini-3-6-flash",
    "grok-4-5",
  ]) {
    await expect(
      dialog.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
    ).toHaveCount(1);
  }

  for (const modelId of [
    "deepseek-r1",
    "grok-3",
    "grok-4-3",
    "grok-4",
    "grok-3-mini",
    "llama-3-1",
    "llama-3-3",
    "llama-4-scout",
  ]) {
    await expect(
      dialog.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
    ).toHaveCount(0);
  }

  await expect(
    dialog.locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
  ).toContainText("Gemini 3.5 Flash-Lite");
  await expect(
    dialog.locator('[data-testid="model-option"][data-model-id="mistral-medium-3-1"]')
  ).toContainText("Mistral Medium 3.5");
});

test("going back from All models keeps the selection intact", async ({ page }) => {
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.reload();
  const dialog = await openModelCatalogue(page);

  const target = dialog.locator(
    '[data-testid="model-option"][data-model-id="claude-haiku-4-5"]'
  );
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("selected-model-chip")).toHaveCount(2);

  await dialog.getByTestId("model-picker-back").first().click();
  await expect(dialog.getByTestId("recommended-model-option").first()).toBeVisible();
  await expect(dialog.getByTestId("selected-model-chip")).toHaveCount(2);

  // The same model reads as selected on the recommended screen too.
  const recommended = dialog.locator(
    '[data-testid="recommended-model-option"][data-model-id="claude-haiku-4-5"]'
  );
  await expect(recommended).toHaveAttribute("aria-pressed", "true");
});

test("selection state stays synchronized between both screens", async ({ page }) => {
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.reload();
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");

  const modelId = await dialog
    .locator('[data-testid="recommended-model-option"][aria-pressed="false"][data-model-plan-locked="false"]')
    .first()
    .getAttribute("data-model-id");
  expect(modelId).toBeTruthy();
  // Pinned by id, not by position: selecting a card changes which one is
  // "first unselected", so a positional locator would drift to another card.
  const recommended = dialog.locator(
    `[data-testid="recommended-model-option"][data-model-id="${modelId}"]`
  );
  await recommended.click();
  await expect(recommended).toHaveAttribute("aria-pressed", "true");

  await openModelCatalogue(page);
  await expect(
    dialog.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
  ).toHaveAttribute("aria-pressed", "true");
});

test("search jumps into the catalogue and cancelling restores the recommendations", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog.getByTestId("recommended-model-option").first()).toBeVisible();

  await dialog.getByTestId("model-search-input").fill("Perplexity Sonar Deep Research");
  await expect(dialog.getByTestId("recommended-model-option")).toHaveCount(0);
  await expect(
    dialog.locator(
      '[data-testid="model-option"][data-model-id="perplexity/sonar-deep-research"]'
    )
  ).toBeVisible();
  await expect(dialog.getByTestId("model-option")).toHaveCount(1);

  await dialog.getByTestId("model-search-clear").click();
  await expect(dialog.getByTestId("model-option")).toHaveCount(0);
  const restored = await dialog.getByTestId("recommended-model-option").count();
  expect(restored).toBeGreaterThanOrEqual(6);
});

test("the filter sheet reports its active count, result count, and resets", async ({ page }) => {
  const dialog = await openModelCatalogue(page);
  const resultCount = dialog.getByTestId("model-catalogue-result-count");
  const unfiltered = await resultCount.innerText();

  await dialog.getByTestId("model-filter-sheet-trigger").click();
  const sheet = dialog.getByTestId("model-filter-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("capability-filter-search").click();
  await sheet.getByTestId("model-filter-apply").click();

  // Closing the sheet keeps the filter applied and shows how many are active.
  await expect(sheet).toHaveCount(0);
  await expect(dialog.getByTestId("model-filter-sheet-trigger")).toContainText("1");
  await expect(resultCount).not.toHaveText(unfiltered);
  await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(0);
  // "Web search" is a capability, not a provider: since 911ded5 the native
  // web-search models (GPT-5.5, Claude, Gemini Pro/Flash) qualify alongside the
  // Perplexity search models, so the filter is checked against a model that
  // does support it and one that does not.
  await expect(
    dialog.locator('[data-testid="model-option"][data-model-id="perplexity/sonar"]')
  ).toHaveCount(1);
  await expect(
    dialog.locator('[data-testid="model-option"][data-model-id="deepseek-v4-flash"]')
  ).toHaveCount(0);
  await expect(
    dialog.locator('[data-testid="model-option"][data-model-id="gpt-5-4-mini"]')
  ).toHaveCount(0);

  await dialog.getByTestId("model-filter-reset-all").click();
  await expect(resultCount).toHaveText(unfiltered);
  await expect(dialog.getByTestId("model-filter-sheet-trigger")).not.toContainText("1");
});

test("Escape closes the filter sheet, then the catalogue, then the picker", async ({ page }) => {
  const dialog = await openModelCatalogue(page);

  await dialog.getByTestId("model-filter-sheet-trigger").click();
  await expect(dialog.getByTestId("model-filter-sheet")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog.getByTestId("model-filter-sheet")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog.getByTestId("recommended-model-option").first()).toBeVisible();
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("guests are told what a gated recommendation needs before they pick it", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  const locked = dialog.locator(
    '[data-testid="recommended-model-option"][data-model-plan-locked="true"]'
  );

  // Gated models are allowed a couple of slots, and each one states the
  // required action rather than failing silently on click.
  const lockedCount = await locked.count();
  expect(lockedCount).toBeLessThanOrEqual(2);
  if (lockedCount > 0) {
    await expect(locked.first()).toContainText(/Sign in|로그인/);
  }
});

test("completed model finder answers personalize the recommendations", async ({ page }) => {
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
  const personalized = dialog.locator(
    '[data-testid="recommended-model-option"][data-recommendation-source="personalized"]'
  );
  await expect(personalized.first()).toBeVisible();
  await expect(
    dialog.locator(
      '[data-testid="recommended-model-option"][data-model-id="deepseek-v4-flash"]'
    )
  ).toBeVisible();
});

test("favorited models lead the recommendations", async ({ page }) => {
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.evaluate(() => {
    localStorage.setItem(
      "favorite_model_ids",
      // Both Free-tier and live: a favourite that is retired (deepseek-r1 was,
      // once DeepSeek dropped deepseek-reasoner) is deliberately filtered out
      // of recommendations, which is covered in tests/modelRecommendations.
      JSON.stringify(["claude-sonnet-5", "mistral-medium-3-1"])
    );
  });
  await page.reload();
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");

  const cards = dialog.getByTestId("recommended-model-option");
  await expect(cards.nth(0)).toHaveAttribute("data-model-id", "claude-sonnet-5");
  await expect(cards.nth(0)).toHaveAttribute("data-recommendation-source", "favorite");
  await expect(cards.nth(1)).toHaveAttribute("data-model-id", "mistral-medium-3-1");
});

test("long input explains its multiplier beside the send controls", async ({ page }) => {
  await page.getByTestId("chat-textarea").fill("x".repeat(64_004));
  const estimate = page.getByTestId("request-credit-estimate");
  await expect(estimate).toContainText("1.5×");
  // Guests default to the 3-model brand trio, so the base estimate is the
  // combined cost of all three selected models (6), not a single model's.
  await expect(estimate).toContainText("6");

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
