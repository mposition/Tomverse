import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

async function addSecondFreeModel(page: Page) {
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
  await page.keyboard.press("Escape");
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile flow only runs in mobile projects.");

  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "Mobile QA response");
  await page.goto("/chat");
  await expect(
    page.getByTestId("mobile-chat-shell").locator("header p").nth(1)
  ).toHaveText("Gemini 3.1 Flash-Lite");
});

test("mobile shell and drawer stay inside viewport", async ({ page }) => {
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("mobile-chat-shell").locator("header button").first().click();
  const drawer = page.getByRole("dialog").first();
  await expect(drawer).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("sent message renders without leaving the active model", async ({ page }) => {
  const activeModel = page
    .getByTestId("mobile-chat-shell")
    .locator("header p")
    .nth(1);
  const activeModelName = await activeModel.textContent();

  await page.getByTestId("chat-textarea").fill("Mobile immediate message");
  await page.getByTestId("chat-textarea").press("Enter");

  await expect(
    page
      .locator('[data-message-role="user"]')
      .filter({ hasText: "Mobile immediate message" })
  ).toBeVisible();
  await expect(page.getByText("Mobile QA response", { exact: true })).toBeVisible();
  await expect(page.getByTestId("mobile-model-tab")).toHaveCount(0);
  await expect(activeModel).toHaveText(activeModelName || "");
});

test("input remains reachable at virtual-keyboard height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();

  const textarea = page.getByTestId("chat-textarea");
  const mobileFontSize = await textarea.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)
  );
  expect(mobileFontSize).toBeGreaterThanOrEqual(16);

  await textarea.focus();
  const box = await page.getByTestId("chat-input").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(520);
  await expectNoHorizontalOverflow(page);
});

test("model tab changes the visible chat panel", async ({ page }) => {
  await addSecondFreeModel(page);

  const tabs = page.getByTestId("mobile-model-tab");
  await expect(tabs).toHaveCount(2);
  await expect(
    page.locator('[data-testid="mobile-model-tab"][aria-selected="true"]')
  ).toHaveCount(1);

  const inactiveTab = page
    .locator('[data-testid="mobile-model-tab"][aria-selected="false"]')
    .first();
  const targetModelId = await inactiveTab.getAttribute("data-model-id");
  expect(targetModelId).toBeTruthy();
  const targetTab = page.locator(
    `[data-testid="mobile-model-tab"][data-model-id="${targetModelId}"]`
  );
  await targetTab.click();
  await expect(targetTab).toHaveAttribute("aria-selected", "true");
  await expectNoHorizontalOverflow(page);
});

test("horizontal swipe changes the active model tab", async ({ page }) => {
  await addSecondFreeModel(page);

  const tabs = page.getByTestId("mobile-model-tab");
  await expect(tabs).toHaveCount(2);
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  const chatArea = page.getByTestId("mobile-chat-shell").locator("section").first();
  await chatArea.dispatchEvent("touchstart", {
    touches: [
      {
        identifier: 1,
        clientX: 330,
        clientY: 320,
        radiusX: 1,
        radiusY: 1,
        force: 0.5,
      },
    ],
  });
  await chatArea.dispatchEvent("touchend", {
    changedTouches: [
      {
        identifier: 1,
        clientX: 80,
        clientY: 330,
        radiusX: 1,
        radiusY: 1,
        force: 0,
      },
    ],
  });

  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
});
