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

test("account controls remain fully visible at a 150 percent scaled viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });

  const accountControls = page.getByTestId("sidebar-account-controls");
  await expect(accountControls).toBeVisible();

  const accountBox = await accountControls.boundingBox();
  expect(accountBox).not.toBeNull();
  expect(accountBox!.y).toBeGreaterThanOrEqual(0);
  expect(accountBox!.y + accountBox!.height).toBeLessThanOrEqual(720);
});

test("guest model selector opens a swap dialog once the 3-model cap is reached", async ({ page }) => {
  // Guests now default to a 3-model comparison (Gemini/GPT/Claude), already
  // at the selection cap, so picking another free model swaps a panel
  // instead of adding a 4th one or asking the guest to sign in.
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);

  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();

  const freeUnselectedModel = dialog
    .locator(
      '[data-testid="model-option"][data-model-usage-class="Standard"][data-model-minimum-plan="Guest"][aria-pressed="false"]:not([disabled])'
    )
    .first();
  await expect(freeUnselectedModel).toBeVisible();
  await freeUnselectedModel.click();

  await expect(page.getByRole("dialog").last()).toBeVisible();
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
  await expectNoHorizontalOverflow(page);
});

test("model names remain readable in the narrow selector", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  const longName = dialog
    .locator('[data-model-id="perplexity/sonar-deep-research"]')
    .getByTestId("model-option-name");

  await expect(longName).toHaveText("Perplexity Sonar Deep Research");
  const styles = await longName.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      overflow: computed.overflow,
      textOverflow: computed.textOverflow,
      whiteSpace: computed.whiteSpace,
    };
  });
  expect(styles.whiteSpace).toBe("normal");
  expect(styles.textOverflow).not.toBe("ellipsis");
  expect(styles.overflow).not.toBe("hidden");
});

test("model picker prioritizes exact credits and shows the final input estimate", async ({ page }) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");

  // Guests start with the brand-trio default already at the 3-model cap, so
  // the recommendations card is hidden (it only shows below capacity).
  await expect(dialog.getByTestId("recommended-model-option")).toHaveCount(0);
  await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(3);

  const gptMini = dialog.locator(
    '[data-testid="model-option"][data-model-id="gpt-5-4-mini"]'
  );
  await expect(gptMini).toBeVisible();
  await expect(gptMini.getByTestId("model-credit-badge")).toContainText("1");
  await expect(gptMini.getByTestId("model-credit-badge").getByTestId("credit-coin-icon")).toBeVisible();
  await expect(gptMini).not.toContainText("Available");
  await expect(gptMini).not.toContainText("Standard ·");
  await expect(gptMini).not.toContainText("Best for");
  await expect(dialog.getByTestId("model-selection-summary")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByTestId("chat-textarea").fill("x".repeat(64_004));
  const estimate = page.getByTestId("request-credit-estimate");
  await expect(estimate).toContainText("1.5×");
  // Guests default to the 3-model brand trio, so the base estimate is the
  // combined cost of all three selected models (6), not a single model's.
  await expect(estimate).toContainText("6");
  await expect(estimate.getByTestId("credit-coin-icon").first()).toBeVisible();
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
