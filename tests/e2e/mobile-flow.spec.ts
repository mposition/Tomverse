import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { restoreActiveConversation } from "./support/chat-state-fixtures";

// The mobile shell renders one ChatApp per selected model and hides every
// panel except the active one (`hidden` + aria-hidden, see
// components/chat/MobileChatShell.tsx). A page-wide message locator therefore
// resolves to one node per model -- three for the guest default trio -- and
// fails strict mode even though only one of them is on screen. Everything
// below asks for the visible node instead, which is both what the test means
// and what a user can actually see.
const visibleMessages = (page: Page, role: "user" | "assistant"): Locator =>
  page.locator(`[data-message-role="${role}"]`).filter({ visible: true });

const TWO_MODELS = ["gemini-2-5-flash", "gpt-5-4-mini"];
// The mobile header is one row and names how many models will answer, not
// which panel is on screen -- the tab strip right below it marks that, and the
// header used to repeat it. The panel on screen is asserted from the tab.

// The tab strip only exists for a conversation that already has history
// (`!isConversationEmpty && selectedModels.length > 1`), so seeding two
// selected models is not on its own enough: each panel has to load at least
// one turn or the shell stays on its welcome screen and renders no tabs.
const SEEDED_MESSAGES: QaConversationMessage[] = [
  {
    id: "qa-message-user-1",
    role: "user",
    content: "이전 비교 질문",
    status: "normal",
  },
  ...TWO_MODELS.map((modelId, index) => ({
    id: `qa-message-assistant-${index + 1}`,
    role: "assistant" as const,
    modelId,
    content: `Seeded answer from ${modelId}`,
    status: "normal",
  })),
];

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile flow only runs in mobile projects.");

  // prepareGuestPage first, mockAuthenticatedApi second, and never the other
  // way round: the guest fixture routes GET /api/auth/session to `null` and
  // clears storage on every navigation, so an authenticated fixture installed
  // before it would be shadowed (Playwright resolves routes newest-first) and
  // the page would come up as a guest with the guest model trio instead of the
  // two-model account conversation these tests describe.
  await prepareGuestPage(page, "ko");
  const needsMultipleModels =
    testInfo.title.includes("model tab") ||
    testInfo.title.includes("horizontal swipe");
  if (needsMultipleModels) {
    await mockAuthenticatedApi(page, {
      selectedModels: TWO_MODELS,
      messages: SEEDED_MESSAGES,
    });
    // Without this the account lands on a *new* chat, where the selection comes
    // from GET /api/user/settings' single defaultModel and the seeded
    // conversation is never opened -- which is why these tests used to see one
    // model and zero tabs while the fixture claimed two.
    await restoreActiveConversation(page);
  }
  await mockChatStream(page, "Mobile QA response");
  await page.goto("/chat");
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
  if (needsMultipleModels) {
    // Proves the two-model fixture actually landed, rather than the page
    // coming up on a single-model default.
    await expect(page.getByTestId("mobile-header-model-count")).toHaveText("2개 모델");
  }
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
  // A guest starts on the three-model comparison default, so the panel on
  // screen is identified by the selected tab rather than by the header. An
  // empty conversation has no tab strip yet, hence the count check first.
  const selectedTabLocator = page.locator(
    '[data-testid="mobile-model-tab"][aria-selected="true"]'
  );
  const activeModelName =
    (await selectedTabLocator.count()) === 1
      ? await selectedTabLocator.textContent()
      : null;

  await page.getByTestId("chat-textarea").fill("Mobile immediate message");
  await page.getByTestId("chat-send-button").click();

  await expect(
    visibleMessages(page, "user").filter({ hasText: "Mobile immediate message" })
  ).toBeVisible();
  await expect(
    visibleMessages(page, "assistant").filter({ hasText: "Mobile QA response" })
  ).toBeVisible();
  // The tab strip appears as soon as the conversation stops being empty --
  // that is expected. What must not change is which panel the send left on
  // screen.
  const selectedTab = page.locator(
    '[data-testid="mobile-model-tab"][aria-selected="true"]'
  );
  await expect(selectedTab).toHaveCount(1);
  if (activeModelName) {
    await expect(selectedTab).toHaveText(activeModelName);
  }
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
  const tabs = page.getByTestId("mobile-model-tab");
  await expect(tabs).toHaveCount(2);
  // The focusable model button owns both role="tab" and aria-selected. The
  // adjacent remove button is deliberately outside the tab widget.
  await expect(
    page.locator('[data-testid="mobile-model-tab"][aria-selected="true"]')
  ).toHaveCount(1);

  const targetModelId = await page
    .locator('[data-testid="mobile-model-tab"][aria-selected="false"]')
    .first()
    .getAttribute("data-model-id");
  expect(targetModelId).toBeTruthy();
  const targetTab = page.locator(
    `[data-testid="mobile-model-tab"][data-model-id="${targetModelId}"]`
  );
  await targetTab.click();
  await expect(targetTab).toHaveAttribute("aria-selected", "true");
  // The point of a tab is which panel it puts on screen: the visible answer
  // must be the one seeded for the model just selected, not the other panel's.
  await expect(
    visibleMessages(page, "assistant").filter({
      hasText: `Seeded answer from ${targetModelId}`,
    })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("horizontal swipe changes the active model tab", async ({ page }) => {
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
  await expect(
    visibleMessages(page, "assistant").filter({
      hasText: `Seeded answer from ${TWO_MODELS[1]}`,
    })
  ).toBeVisible();
});
