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

  await finder.getByRole("button", { name: "이 조합 사용하기" }).click();
  await expect(finder).toBeHidden();

  expect(savedBody).toMatchObject({
    action: "complete",
    answers: {
      tasks: ["documents"],
      priority: "fast",
    },
    modelIds: ["gpt-5-4-mini", "gemini-2-5-flash"],
  });
});
