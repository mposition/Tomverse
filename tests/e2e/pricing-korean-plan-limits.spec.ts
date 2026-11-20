import { expect, test } from "@playwright/test";

for (const scenario of [
  { name: "default public limits", proDaily: 300, proAttachments: true, inputLimit: 128_000, longContext: false },
  { name: "changed public limits", proDaily: 180, proAttachments: false, inputLimit: 96_000, longContext: false },
  { name: "long context", proDaily: 300, proAttachments: true, inputLimit: 128_000, longContext: true },
]) {
  test(`Korean plan comparison reflects ${scenario.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
    await page.route("**/api/billing/config**", (route) => route.fulfill({ json: {
      plans: [
        { id: "free", name: "Free", monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD", monthlyMessageLimit: 300, dailyMessageLimit: 30, allowAttachments: true },
        { id: "pro", name: "Pro", monthlyPriceCents: 1_500, annualPriceCents: 14_400, currency: "USD", monthlyMessageLimit: 3_000, dailyMessageLimit: scenario.proDaily, allowAttachments: scenario.proAttachments },
        { id: "max", name: "Max", monthlyPriceCents: 2_500, annualPriceCents: 24_000, currency: "USD", monthlyMessageLimit: 10_000, dailyMessageLimit: 0, allowAttachments: true },
      ], creditPacks: [], featuredPromotion: null, appInputTokenLimit: scenario.inputLimit,
      appLongContext: scenario.longContext,
    } }));
    await page.goto("/pricing?lang=ko");
    // Daily limits come from the plan config: a number, or "없음" for a plan with none.
    await expect(page.getByTestId("pricing-plan-daily-free")).toContainText("30 크레딧");
    await expect(page.getByTestId("pricing-plan-daily-pro")).toContainText(`${scenario.proDaily} 크레딧`);
    await expect(page.getByTestId("pricing-plan-daily-max")).toContainText("없음");
    // The comparison table repeats the limits and the attachment rule of each plan.
    const dailyRow = page.getByRole("row").filter({ hasText: "하루 사용 한도" });
    await expect(dailyRow.getByRole("cell").nth(2)).toHaveText(`${scenario.proDaily} 크레딧`);
    const attachmentRow = page.getByRole("row").filter({ hasText: "파일 첨부 (허용 시)" });
    await expect(attachmentRow.getByRole("cell").nth(2)).toHaveText(scenario.proAttachments ? "10개 · 각 50 MiB · 총 100 MiB" : "현재 제공하지 않음");
    // The input ceiling is stated as configured: the long-context rule, or the plain ceiling.
    const limit = scenario.inputLimit.toLocaleString("ko-KR");
    if (scenario.longContext) {
      await expect(page.getByTestId("pricing-calc-long-context")).toContainText(`${limit}토큰을 넘으면 실제 공급사 비용으로 차감`);
      await expect(page.getByTestId("pricing-calc-input-limit")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("pricing-calc-input-limit")).toContainText(`${limit}토큰까지`);
      await expect(page.getByTestId("pricing-calc-long-context")).toHaveCount(0);
    }
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
  expect(typeof config.appLongContext).toBe("boolean");
});
