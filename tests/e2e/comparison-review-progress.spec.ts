import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage, expectNoHorizontalOverflow } from "./support/app-fixtures";
import { mockComparisonReview, mockConversationHistory, openReviewConversation, reviewModels } from "./support/comparison-review-fixtures";

for (const finalizes of [true, false]) {
  test(`AI Review displays primary before ${finalizes ? "final persistence" : "a finalization failure"}`, async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: reviewModels });
    await mockConversationHistory(page);
    const api = await mockComparisonReview(page, { withSecondary: true });
    await page.addInitScript(({ finalizes }) => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await realFetch(input, init);
        if (!String(input).endsWith("/comparison-reviews") || init?.method !== "POST" || !response.ok) return response;
        const final = await response.json();
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "primary", data: {
            ...final, id: undefined, reviewItems: undefined, persisted: false,
            result: { primary: final.result.primary, secondary: null, agreement: null },
          } })}\n`));
          (window as unknown as { finishReviewFixture: () => void }).finishReviewFixture = () => {
            controller.enqueue(encoder.encode(`${JSON.stringify(finalizes
              ? { type: "complete", data: final }
              : { type: "error", data: { error: "Final save failed", code: "COMPARISON_REVIEW_FAILED" } })}\n`));
            controller.close();
          };
        } }), { headers: { "Content-Type": "application/x-ndjson" } });
      };
    }, { finalizes });
    await page.goto("/review");
    await openReviewConversation(page);
    await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
    const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
    await dialog.getByRole("button", { name: /교차검토 실행/ }).click();
    await expect(dialog.getByTestId("ai-review-secondary-pending")).toBeVisible();
    await expect(dialog.locator('[data-testid="ai-review-workspace"]:visible')).toBeVisible();
    await expect(dialog.getByRole("tab", { name: /검토자 2/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.evaluate(() => (window as unknown as { finishReviewFixture: () => void }).finishReviewFixture());
    await expect(dialog.getByTestId("ai-review-secondary-pending")).toHaveCount(0);
    if (finalizes) {
      await expect(dialog.getByRole("tab", { name: /검토자 2/ })).toBeVisible();
    } else {
      await expect(dialog.getByText(/The first review is available, but the final result could not be confirmed/)).toBeVisible();
      await expect(dialog.locator('[data-testid="ai-review-workspace"]:visible')).toBeVisible();
      await expect(dialog.getByRole("tab", { name: /검토자 2/ })).toHaveCount(0);
    }
    expect(api.getRunCount()).toBe(1);
  });
}
