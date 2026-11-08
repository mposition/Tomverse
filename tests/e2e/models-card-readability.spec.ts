import { expect, test } from "@playwright/test";
import { AVAILABLE_MODELS } from "../../lib/models";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`model-card labels and identifier are readable at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setDeterministicTheme(page, theme);
    const model = AVAILABLE_MODELS.find((item) => item.id === "perplexity/sonar-reasoning-pro")!;
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: [model] } }));
    await page.goto("/models?lang=ko");
    const card = page.getByRole("article");
    await expect(card).toHaveCount(1);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    for (const text of [model.id, "이용 시작 플랜", "공급자", "크레딧 사용 등급", "짧은 요청의 기본 크레딧", "상태"]) {
      const label = card.getByText(text, { exact: true });
      await expect(label).toBeVisible();
      const metrics = await label.evaluate((node) => ({ font: parseFloat(getComputedStyle(node).fontSize), leading: parseFloat(getComputedStyle(node).lineHeight), overflow: node.scrollWidth > node.clientWidth + 1 }));
      expect(metrics.font).toBeGreaterThanOrEqual(14);
      expect(metrics.leading).toBeGreaterThanOrEqual(20);
      expect(metrics.overflow).toBe(false);
      await expectAccessibleContrast(label, `Model field: ${text}`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
