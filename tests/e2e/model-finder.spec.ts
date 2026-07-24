import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

test("the in-picker combo CTA recommends an AI combination and applies only the kept models", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.unroute("**/api/user/model-finder");

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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        defaultModelId: modelIds[0],
        modelIds,
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
    modelIds: ["gpt-5-4-mini", "gemini-2-5-flash"],
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
});

test("the finder can be closed mid-flow without completing it", async ({ page }) => {
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

test("using the combination for this conversation only does not save it as the account default", async ({
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

test("selecting two models suggests one complementary model instead of the full questionnaire", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=ko");

  await modelMenuTrigger(page).click();
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();

  const suggestion = page.getByTestId("model-combo-complementary-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(page.getByTestId("model-combo-finder-cta")).toHaveCount(0);

  await page.getByTestId("model-combo-complementary-add").click();
  await expect(
    page.locator('[data-testid="model-option"][data-model-id="deepseek-r1"]')
  ).toHaveAttribute("aria-pressed", "true");
});

test("the picker shows a compact re-recommend link once the model cap is reached", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=ko");

  await modelMenuTrigger(page).click();
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await page
    .locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]')
    .click();

  await expect(page.getByTestId("model-combo-finder-cta")).toHaveCount(0);
  await expect(page.getByTestId("model-combo-complementary-suggestion")).toHaveCount(0);

  const finder = page.getByTestId("model-finder");
  await page.getByTestId("model-combo-finder-cta-compact").click();
  await expect(finder).toBeVisible();
});
