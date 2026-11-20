import { expect, test } from "@playwright/test";
import { mockPublicBillingConfig, prepareGuestPage } from "./support/app-fixtures";
import { AVAILABLE_MODELS, canUseModelWithPlan, isPubliclySelectableModel } from "../../lib/models";

// Each plan's "see this plan's models" dialog lists the public models the plan can use, and
// shows the ones that need Pro or above as locked. It is a modal <dialog>: focus moves in,
// Escape closes it and focus goes back to the button that opened it.
test("each plan's dialog lists its eligible public models and the locked ones", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockPublicBillingConfig(page);
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: AVAILABLE_MODELS } }));
  await page.goto("/pricing?lang=en");
  const publicModels = AVAILABLE_MODELS.filter((item) => item.enabled && isPubliclySelectableModel(item));
  for (const plan of ["Free", "Pro", "Max"] as const) {
    const trigger = page.getByTestId(`pricing-models-${plan.toLowerCase()}`);
    const usable = publicModels.filter((model) => canUseModelWithPlan(plan, model));
    await expect(trigger).toContainText(`${usable.length} of ${publicModels.length}`);
    await trigger.click();
    const dialog = page.getByTestId("pricing-models-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-labelledby", "pd-title");
    await expect(page.locator("#pd-title")).toContainText(`${usable.length} models you can use`);
    // Focus moved into the dialog.
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
    for (const model of publicModels) {
      const item = dialog.locator(`[data-model-id="${model.id}"]`);
      await expect(item).toHaveCount(1);
      if (canUseModelWithPlan(plan, model)) await expect(item).not.toHaveClass(/locked/);
      else await expect(item).toHaveClass(/locked/);
    }
    await expect(dialog.getByRole("link", { name: /See base credits for every model/ })).toHaveAttribute("href", /^\/(en\/)?models$/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Free says Pro-only models are not available", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/pricing?lang=ko");
  await expect(page.getByTestId("pricing-plan-card-free")).toContainText("Pro 이상 전용 모델은 쓸 수 없습니다.");
});
