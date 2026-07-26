import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

// STG-F009: on mobile the header showed a single representative model name
// ("GPT-5.4 mini") while the composer showed "3 AIs", so a multi-model
// comparison looked like a single-model chat until the picker was reopened.
// The header now derives its summary from the same selection state as the
// composer and shows "<model> +N", where N is the number of *additional
// active* models -- paused panels are excluded from both.

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const MODEL_NAMES: Record<string, string> = {
  "gpt-5-4-mini": "GPT-5.4 mini",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-2-5-flash": "Gemini 3.1 Flash-Lite",
};
const CHAT_ID = "guest_header_summary";
const TITLE = "Header summary test";

// Every mobile width the product supports, from the narrowest phone to the
// last width before the desktop shell takes over at 768px.
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 767, height: 1024 },
];

const summary = (page: Page) => page.getByTestId("mobile-header-model-summary");
const primaryModel = (page: Page) => page.getByTestId("mobile-header-primary-model");
const extraCount = (page: Page) => page.getByTestId("mobile-header-extra-model-count");
const composerCount = (page: Page) => page.getByTestId("composer-active-model-count");

async function seedGuestConversation(
  page: Page,
  selectedModels: string[],
  disabledPanels: string[] = []
) {
  await page.addInitScript(
    ({ chatId, title, selectedModels, disabledPanels }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels,
            disabledPanels,
            webSearchMode: "off",
            createdAt: new Date().toISOString(),
          },
        ])
      );
      for (const modelId of selectedModels) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "What is the capital of France?", status: "normal" },
            { id: "a1", role: "assistant", content: "The capital of France is Paris.", status: "normal" },
          ])
        );
      }
    },
    { chatId: CHAT_ID, title: TITLE, selectedModels, disabledPanels }
  );
}

// A saved guest conversation is offered on the welcome screen rather than
// auto-restored, so it takes a tap to become the current chat.
async function openSeededConversation(page: Page) {
  await page.goto("/chat?lang=en");
  await page.getByTestId("recent-conversation-card").filter({ hasText: TITLE }).click();
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
}

// Restoring a conversation keeps whichever panel was already on screen, so
// tests that assert a specific representative name pin the panel first.
async function showPanel(page: Page, modelId: string) {
  const tab = page.locator(`[data-testid="mobile-model-tab"][data-model-id="${modelId}"]`);
  await tab.click();
  // aria-selected lives on the role="tab" wrapper around the button.
  await expect(page.locator(`[role="tab"]:has([data-model-id="${modelId}"])`)).toHaveAttribute(
    "aria-selected",
    "true"
  );
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "The mobile header summary only renders in the mobile shell."
  );
  await prepareGuestPage(page, "en");
});

test("header names the model on screen and counts the other active ones", async ({
  page,
}) => {
  await seedGuestConversation(page, MODELS);
  await openSeededConversation(page);

  // The name in the header is always the panel actually on screen.
  const selectedModelId = await page
    .locator('[role="tab"][aria-selected="true"] [data-testid="mobile-model-tab"]')
    .getAttribute("data-model-id");
  expect(selectedModelId).toBeTruthy();
  await expect(primaryModel(page)).toHaveText(MODEL_NAMES[selectedModelId!]);
  await expect(extraCount(page)).toHaveText("+2");

  await showPanel(page, MODELS[0]);
  await expect(summary(page)).toHaveAttribute(
    "aria-label",
    `${MODEL_NAMES[MODELS[0]]} and 2 more models selected. 3 active models total. Open model picker.`
  );
});

test("a single model shows its full name and no +N", async ({ page }) => {
  await seedGuestConversation(page, [MODELS[0]]);
  await openSeededConversation(page);

  await expect(primaryModel(page)).toHaveText(MODEL_NAMES[MODELS[0]]);
  await expect(extraCount(page)).toHaveCount(0);
  await expect(summary(page)).toHaveAttribute(
    "aria-label",
    `${MODEL_NAMES[MODELS[0]]} selected. 1 active model total. Open model picker.`
  );
});

test("header and composer report the same active model count", async ({ page }) => {
  await seedGuestConversation(page, MODELS);
  await openSeededConversation(page);

  // "<primary> +2" up top must mean the same three models the composer is
  // about to send to.
  await expect(extraCount(page)).toHaveText("+2");
  await expect(composerCount(page)).toHaveText("3 AIs");
});

test("a paused panel drops out of both the header count and the composer", async ({
  page,
}) => {
  await seedGuestConversation(page, MODELS, [MODELS[2]]);
  await openSeededConversation(page);
  await showPanel(page, MODELS[0]);

  await expect(extraCount(page)).toHaveText("+1");
  await expect(composerCount(page)).toHaveText("2 AIs");
  await expect(summary(page)).toHaveAttribute(
    "aria-label",
    `${MODEL_NAMES[MODELS[0]]} and 1 more model selected. 2 active models total. 1 model paused. Open model picker.`
  );
});

test("switching the visible panel moves the representative name, not the count", async ({
  page,
}) => {
  await seedGuestConversation(page, MODELS);
  await openSeededConversation(page);
  await showPanel(page, MODELS[0]);
  await expect(primaryModel(page)).toHaveText(MODEL_NAMES[MODELS[0]]);

  await showPanel(page, MODELS[1]);

  await expect(primaryModel(page)).toHaveText(MODEL_NAMES[MODELS[1]]);
  await expect(extraCount(page)).toHaveText("+2");
});

test("tapping the summary opens the existing model picker and returns focus", async ({
  page,
}) => {
  await seedGuestConversation(page, MODELS);
  await openSeededConversation(page);

  await summary(page).click();

  const picker = page.locator("#chat-input-popover");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute("aria-label", "Choose AI models");
  // The full selection, with provider and per-model cost, is reachable from
  // the header -- not just the representative name.
  for (const modelId of MODELS) {
    await expect(
      picker.locator(`[data-model-id="${modelId}"]`).first()
    ).toBeVisible();
  }

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(summary(page)).toBeFocused();
});

test("the summary is keyboard operable", async ({ page }) => {
  await seedGuestConversation(page, MODELS);
  await openSeededConversation(page);

  await summary(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#chat-input-popover")).toBeVisible();
});

test("no smaller intermediate count is painted while the conversation restores", async ({
  page,
}) => {
  await seedGuestConversation(page, MODELS);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __extraCountHistory: string[] }).__extraCountHistory = seen;
    const sample = () => {
      const node = document.querySelector(
        '[data-testid="mobile-header-extra-model-count"]'
      );
      const value = node?.textContent?.trim() ?? "";
      if (value && seen[seen.length - 1] !== value) seen.push(value);
    };
    // Polling is installed first and observation is attached to `document`:
    // at document_start `document.documentElement` does not exist yet, and a
    // throw here would leave the recorder silently empty.
    const interval = setInterval(sample, 8);
    setTimeout(() => clearInterval(interval), 15_000);
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await openSeededConversation(page);
  await expect(extraCount(page)).toHaveText("+2");

  const history = await page.evaluate(
    () => (window as unknown as { __extraCountHistory: string[] }).__extraCountHistory
  );
  // "+1" appearing before "+2" would mean the header briefly claimed fewer
  // models than the restored conversation actually has.
  expect(history).toEqual(["+2"]);
});

for (const viewport of VIEWPORTS) {
  test(`header summary stays readable and tappable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await seedGuestConversation(page, MODELS);
    await openSeededConversation(page);

    await expect(primaryModel(page)).toBeVisible();
    await expect(extraCount(page)).toBeVisible();
    await expect(extraCount(page)).toHaveText("+2");
    await expect(composerCount(page)).toHaveText("3 AIs");

    // The header's own controls must survive next to the summary.
    await expect(page.getByTestId("mobile-sidebar-open")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // "+2" is the load-bearing part: the model name may ellipsize, the count
    // may not be clipped by its own box or pushed outside the header.
    const countBox = await extraCount(page).boundingBox();
    const headerBox = await page
      .getByTestId("mobile-chat-shell")
      .locator("header")
      .boundingBox();
    expect(countBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(
      headerBox!.x + headerBox!.width + 0.5
    );
    const isCountClipped = await extraCount(page).evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1
    );
    expect(isCountClipped).toBe(false);

    const summaryBox = await summary(page).boundingBox();
    expect(summaryBox).not.toBeNull();
    expect(summaryBox!.height).toBeGreaterThanOrEqual(43.5);
    expect(summaryBox!.width).toBeGreaterThanOrEqual(43.5);

    await summary(page).click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}
