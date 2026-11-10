import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";

test("Korean model descriptions use per-model facts instead of shared performance claims", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  const ids = ["claude-fable-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-sonnet-5"];
  const weights = [80, 1, 32, 16];
  const models = ids.map((id, index) => ({ ...AVAILABLE_MODELS.find((model) => model.id === id)!, creditWeight: weights[index], inputCapabilities: { image: index !== 0 } }));
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models } }));
  await page.goto("/models?lang=ko");
  await expect(page.getByTestId("model-selection-criteria")).toHaveCount(4);
  for (const [index, model] of models.entries()) {
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
    const criteria = card.getByTestId("model-selection-criteria");
    await expect(criteria).toContainText(`이용 시작: ${model.minimumPlan === "Guest" ? "게스트" : model.minimumPlan === "Free" ? "무료" : model.minimumPlan}`);
    await expect(criteria).toContainText(`짧은 요청: ${model.creditWeight} 크레딧`);
    await expect(criteria).toContainText(`이미지 입력: ${index === 0 ? "미지원" : "지원"}`);
    await expect(card.getByText("글쓰기", { exact: true })).toHaveCount(0);
    await expect(card.getByText("분석", { exact: true })).toHaveCount(0);
  }
  // The note is part of the full introduction, which phones collapse (#3546).
  if (info.project.name.includes("mobile")) await expect(page.getByText(/비용 차이가 성능 우열을 뜻하지는 않습니다/)).toBeAttached();
  else await expect(page.getByText(/비용 차이가 성능 우열을 뜻하지는 않습니다/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
