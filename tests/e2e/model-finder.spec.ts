import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, openModelCatalogue } from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

/**
 * STG-F008: the combo-finder CTA and the complementary nudge live on the
 * picker's recommended screen, so selecting a specific catalogue row means
 * stepping into "All models" and back again.
 */
async function backToRecommendations(page: Page) {
  await page.locator("#chat-input-popover").getByTestId("model-picker-back").first().click();
  await expect(
    page.locator("#chat-input-popover").getByTestId("recommended-model-option").first()
  ).toBeVisible();
}

/**
 * Opens the model picker's full catalogue and asserts that exactly the given
 * models are selected, then closes the popover again.
 */
async function expectSelectedModels(page: Page, expected: string[]) {
  await modelMenuTrigger(page).click();
  await openModelCatalogue(page);
  for (const modelId of expected) {
    await expect(
      page.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
    ).toHaveAttribute("aria-pressed", "true");
  }
  await expect(
    page.locator('[data-testid="model-option"][aria-pressed="true"]')
  ).toHaveCount(expected.length);
  await page.getByTestId("model-picker-done").click();
  await expect(page.locator("#chat-input-popover")).toBeHidden();
}

/**
 * Starts a new chat from wherever the shell keeps the control: the sidebar
 * button on desktop, the header button on mobile (hidden while the active
 * conversation is already blank -- then there is nothing to do).
 */
async function startNewChat(page: Page) {
  const sidebarButton = page.getByTestId("sidebar-new-chat");
  if (await sidebarButton.isVisible()) {
    await sidebarButton.click();
    return;
  }
  const headerButton = page.getByRole("button", { name: "새 대화" });
  if (await headerButton.isVisible()) {
    await headerButton.click();
  }
}

test("saving the combination persists it for the next new chat and across a reload", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.unroute("**/api/user/model-finder");
  await page.unroute("**/api/user/settings");

  // The mock HOLDS the saved state: the model-finder save writes it, and the
  // settings read serves it back -- the contract the real routes now follow.
  let savedCombination: string[] | null = null;

  await page.route("**/api/user/settings**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, settings: {} }),
      });
      return;
    }
    const lead = savedCombination?.[0] ?? "gpt-5-6-luna";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        theme: "dark",
        language: "ko",
        defaultModel: lead,
        defaultModelId: lead,
        newConversationModelIds: savedCombination ?? [lead],
        modelSelectionNotice: null,
        timeZone: "UTC",
        timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
      }),
    });
  });

  let savedBody: Record<string, unknown> | null = null;
  await page.route("**/api/user/model-finder", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settings: {
            preferredTasks: [],
            preferredPriority: null,
            defaultModelId: "gpt-5-4-mini",
            modelFinderCompletedAt: null,
          },
        }),
      });
      return;
    }

    savedBody = route.request().postDataJSON() as Record<string, unknown>;
    const modelIds = Array.isArray(savedBody.modelIds)
      ? (savedBody.modelIds as string[])
      : ["gpt-5-4-mini"];
    savedCombination = modelIds;
    // Canonical response: only what was persisted, never a request echo.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        defaultModelId: modelIds[0],
        newConversationModelIds: modelIds,
        modelFinderCompletedAt: "2026-07-24T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/chat?lang=ko");

  const finder = page.getByTestId("model-finder");
  await expect(finder).toBeHidden();

  await modelMenuTrigger(page).click();
  await page.getByTestId("model-combo-finder-cta").click();

  await expect(finder).toBeVisible();
  await expect(finder).toContainText("내 작업에 맞는 AI 조합 추천받기");
  await finder.getByRole("button", { name: "시작하기", exact: true }).click();

  await finder.getByRole("button", { name: "문서 요약·분석" }).click();
  await finder.getByRole("button", { name: "다음" }).click();
  await finder.getByRole("button", { name: "빠른 답변" }).click();
  await finder.getByRole("button", { name: "다음" }).click();

  await expect(finder).toContainText("추천 AI 조합");
  await expect(finder.getByRole("button", { name: /Claude Sonnet 5/ })).toBeVisible();

  // All combo cards start selected -- deselect the advanced add-on so only
  // the two Standard picks should be applied.
  await finder.getByRole("button", { name: /Claude Sonnet 5/ }).click();
  await expect(finder.getByTestId("model-finder-estimated-total")).toContainText("2크레딧");

  await finder.getByRole("button", { name: "기본 조합으로 저장" }).click();
  await expect(finder).toBeHidden();

  expect(savedBody).toMatchObject({
    action: "complete",
    answers: {
      tasks: ["documents"],
      priority: "fast",
    },
    modelIds: ["gpt-5-6-luna", "gemini-2-5-flash"],
  });

  // Completing the combo should land on a fresh chat rather than swap the
  // models under the conversation that was active when the finder opened.
  // The sidebar list is tucked in a drawer on mobile, so only check it
  // where it's already visible.
  const sidebarList = page.getByTestId("sidebar-conversation-list");
  if (await sidebarList.isVisible()) {
    const sidebarConversation = sidebarList.getByText("QA conversation");
    await expect(sidebarConversation.locator("..")).not.toHaveClass(/bg-zinc-200/);
  }

  // The fresh chat carries exactly the two saved models -- the canonical
  // combination the server persisted, not just its lead.
  await expectSelectedModels(page, ["gpt-5-6-luna", "gemini-2-5-flash"]);

  // A reload restores the previously active conversation, whose own
  // selectedModels rightly win -- so the persistence claim is asserted where
  // it applies: the NEXT new chat, whose start state is rebuilt from
  // GET /api/user/settings serving the saved combination.
  await page.reload();
  await expect(modelMenuTrigger(page)).toBeVisible();
  await startNewChat(page);
  await expectSelectedModels(page, ["gpt-5-6-luna", "gemini-2-5-flash"]);

  // And once more from the blank chat: pressing "New Chat" again must not
  // collapse the combination back to a single model.
  await startNewChat(page);
  await expectSelectedModels(page, ["gpt-5-6-luna", "gemini-2-5-flash"]);
});

test("the finder can be closed mid-flow without completing it", { tag: "@ui-risk" }, async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=ko");

  const finder = page.getByTestId("model-finder");
  await modelMenuTrigger(page).click();
  await page.getByTestId("model-combo-finder-cta").click();
  await expect(finder).toBeVisible();

  await finder.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(finder).toContainText("AI를 주로 어디에 사용하시나요?");

  await page.getByTestId("model-finder-close").click();
  await expect(finder).toBeHidden();
});

test("using the combination for this conversation only does not save it as the account default", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  let saveRequestCount = 0;
  await page.route("**/api/user/model-finder", async (route) => {
    if (route.request().method() === "POST") saveRequestCount += 1;
    await route.fallback();
  });

  await page.goto("/chat?lang=ko");
  const finder = page.getByTestId("model-finder");
  await modelMenuTrigger(page).click();
  await page.getByTestId("model-combo-finder-cta").click();

  await finder.getByRole("button", { name: "시작하기", exact: true }).click();
  await finder.getByRole("button", { name: "문서 요약·분석" }).click();
  await finder.getByRole("button", { name: "다음" }).click();
  await finder.getByRole("button", { name: "빠른 답변" }).click();
  await finder.getByRole("button", { name: "다음" }).click();

  await finder.getByRole("button", { name: "이번 대화에 사용" }).click();
  await expect(finder).toBeHidden();
  expect(saveRequestCount).toBe(0);
});

test("selecting two models suggests one complementary model instead of the full questionnaire", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=ko");

  await modelMenuTrigger(page).click();
  await openModelCatalogue(page);
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await backToRecommendations(page);

  const suggestion = page.getByTestId("model-combo-complementary-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(page.getByTestId("model-combo-finder-cta")).toHaveCount(0);

  await page.getByTestId("model-combo-complementary-add").click();
  await openModelCatalogue(page);

  // The selection carries no reasoning model, so the complementary slot is
  // filled from REASONING_SUGGESTION_ORDER. This asserted groq-gpt-oss-120b
  // until that model left the catalogue, which left the expectation naming a
  // model the picker can no longer render -- the assertion has been failing
  // since, independently of which model is the app default.
  //
  // The live head of that order is grok-4-5, which is Pro-only. This viewer is
  // on Free, so the suggestion is offered as an upgrade prompt and the add is
  // refused rather than silently handing out a tier they have not paid for --
  // the same rule the gated recommendations in model-picker.spec.ts assert.
  const suggestedOption = page.locator(
    '[data-testid="model-option"][data-model-id="grok-4-5"]'
  );
  await expect(suggestedOption).toHaveAttribute("data-model-plan-locked", "true");
  await expect(suggestedOption).toHaveAttribute("aria-pressed", "false");
});

test("the picker shows a compact re-recommend link once the model cap is reached", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=ko");

  await modelMenuTrigger(page).click();
  await openModelCatalogue(page);
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await page
    .locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]')
    .click();
  await backToRecommendations(page);

  await expect(page.getByTestId("model-combo-finder-cta")).toHaveCount(0);
  await expect(page.getByTestId("model-combo-complementary-suggestion")).toHaveCount(0);

  const finder = page.getByTestId("model-finder");
  await page.getByTestId("model-combo-finder-cta-compact").click();
  await expect(finder).toBeVisible();
});
