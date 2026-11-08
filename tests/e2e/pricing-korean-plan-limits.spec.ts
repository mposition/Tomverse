import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";

for (const scenario of [
  { name: "default public limits", proDaily: 300, proAttachments: true, inputLimit: 128_000 },
  { name: "changed public limits", proDaily: 180, proAttachments: false, inputLimit: 96_000 },
]) {
  test(`Korean plan comparison reflects ${scenario.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
    await page.route("**/api/billing/config**", (route) => route.fulfill({ json: {
      plans: [
        { id: "free", name: "Free", monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD", monthlyMessageLimit: 300, dailyMessageLimit: 30, allowAttachments: true },
        { id: "pro", name: "Pro", monthlyPriceCents: 1_500, annualPriceCents: 14_400, currency: "USD", monthlyMessageLimit: 3_000, dailyMessageLimit: scenario.proDaily, allowAttachments: scenario.proAttachments },
        { id: "max", name: "Max", monthlyPriceCents: 2_500, annualPriceCents: 24_000, currency: "USD", monthlyMessageLimit: 10_000, dailyMessageLimit: 0, allowAttachments: true },
      ], creditPacks: [], featuredPromotion: null, appInputTokenLimit: scenario.inputLimit,
    } }));
    const models = ["gpt-6-luna", "claude-fable-5"].map((id) => AVAILABLE_MODELS.find((model) => model.id === id)!);
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models } }));
    await page.goto("/pricing?lang=ko");
    const pro = page.getByTestId("pricing-plan-limits-pro");
    const max = page.getByTestId("pricing-plan-limits-max");
    await expect(pro).toContainText(`${scenario.proDaily} 크레딧`);
    await expect(max).toContainText("별도 일일 플랜 크레딧 한도 없음");
    for (const block of [pro, max]) {
      await expect(block).toContainText(`${scenario.inputLimit.toLocaleString("ko-KR")} 토큰 · 플랜 공통`);
      await expect(block.getByRole("link", { name: "지원 모델과 이용 시작 플랜 보기" })).toHaveAttribute("href", "/ko/models");
      await block.locator("summary").click();
      await expect(block).toContainText("1,000,000 토큰");
      await expect(block).toContainText("실제 입력은 위 앱 상한 안에서 처리되며");
    }
    const attachmentRow = page.getByRole("row").filter({ hasText: "파일 첨부 (허용 시)" });
    await expect(attachmentRow.getByRole("cell").nth(2)).toHaveText(scenario.proAttachments ? "5개 · 각 10 MiB · 총 25 MiB" : "현재 제공하지 않음");
    await expect(max).toContainText("메시지당 5개 · 파일당 10 MiB · 총 25 MiB");
    await expect(pro).toContainText(scenario.proAttachments ? "메시지당 5개 · 파일당 10 MiB · 총 25 MiB" : "현재 플랜 설정에서 첨부 기능을 제공하지 않습니다.");
    await expect(page.getByTestId("pricing-plan-card-max")).not.toContainText("더 높은 첨부파일 및 맥락 한도");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("public billing response exposes the configured app input ceiling", async ({ request }) => {
  const response = await request.get("/api/billing/config");
  expect(response.status()).toBe(200);
  const config = await response.json();
  expect(Number.isSafeInteger(config.appInputTokenLimit)).toBe(true);
  expect(config.appInputTokenLimit).toBeGreaterThan(0);
});
