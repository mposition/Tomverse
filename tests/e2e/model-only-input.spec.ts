import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

test.beforeEach(async ({ page }, testInfo) => {
  // MobileChatShell always hides the model-only input regardless of model
  // count (a separate, deliberate mobile space-saving choice); this test
  // covers the desktop model-count-based visibility rule.
  test.skip(
    testInfo.project.name.includes("mobile"),
    "Model-only input visibility by model count is a desktop-only rule."
  );
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
});

test("model-only follow-up input is hidden with one model and appears once a second is added", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.reload();

  const modelOnlyInput = page.getByPlaceholder(/Ask only this model|이 모델에게만 추가 질문/);
  await expect(modelOnlyInput).toHaveCount(0);

  const dialog = await openModelPickerCatalogue(page);
  const secondModel = dialog.locator(
    '[data-testid="model-option"][data-model-id="claude-sonnet-5"]'
  );
  await secondModel.click();
  await expect(secondModel).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Done$|^선택 완료$/ }).click();

  await expect(modelOnlyInput).toHaveCount(2);
});
