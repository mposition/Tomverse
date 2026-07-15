import { expect, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
} from "./support/app-fixtures";

test("new signed-in users can choose a Standard default with explicit optional upgrades", async ({
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
          variant: "finder",
          shouldShow: true,
          settings: {
            preferredTasks: [],
            preferredPriority: null,
            usesFilesFrequently: null,
            defaultModelId: "gpt-5-4-mini",
            modelFinderCompletedAt: null,
          },
        }),
      });
      return;
    }

    savedBody = route.request().postDataJSON() as Record<string, unknown>;
    const selectedModel =
      typeof savedBody.defaultModelId === "string"
        ? savedBody.defaultModelId
        : "gpt-5-4-mini";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        defaultModelId: selectedModel,
        modelFinderCompletedAt: "2026-07-15T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/chat?lang=ko");

  const finder = page.getByTestId("model-finder");
  await expect(finder).toBeVisible();
  await expect(finder).toContainText("20초 만에 나에게 맞는 AI 찾기");
  await page.getByRole("button", { name: "모델 찾기 시작" }).click();

  await page.getByRole("button", { name: "문서 요약·분석" }).click();
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "빠른 답변" }).click();
  await page.getByRole("button", { name: "다음" }).click();
  await page
    .getByRole("button", { name: "PDF·Office 문서를 자주 사용" })
    .click();
  await page.getByRole("button", { name: "다음" }).click();

  await expect(finder).toContainText("추천 기본 모델");
  await expect(finder).toContainText("Standard · 기본 1크레딧");
  await expect(finder).toContainText("Claude Sonnet 5");
  await expect(finder).toContainText("Advanced · 4 credits");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "이 모델로 시작하기" }).click();

  await expect(finder).toBeHidden();
  expect(savedBody).toMatchObject({
    action: "complete",
    answers: {
      tasks: ["documents"],
      priority: "fast",
      fileUsage: "documents",
    },
    defaultModelId: "gemini-2-5-flash",
  });
  await expect(
    page.getByRole("button", {
      name: /문서를 첨부하고 이렇게 물어보세요/,
    })
  ).toBeVisible();
});
