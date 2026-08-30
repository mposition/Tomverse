import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  mockComparisonReview,
  mockConversationHistory,
  openReviewConversation,
  reviewModels,
} from "./support/comparison-review-fixtures";

/**
 * The per-item quality feedback control.
 *
 * docs/policy/ai-review-m5-quality-contract.md §9.
 *
 * Everything below drives the real dialog through the real request surface,
 * with the item-feedback endpoint mocked -- so the ids the buttons send are
 * the ones the server-side derivation produced, not values a test invented.
 */

async function mockItemFeedback(page: Page) {
  const calls: Array<{ method: string; body: unknown }> = [];
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews/item-feedback**",
    async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ feedback: [] }),
        });
        return;
      }
      calls.push({ method, body: route.request().postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verdict: null }),
      });
    }
  );
  return { calls };
}

async function openReview(page: Page) {
  await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
  const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /교차검토 실행/ }).click();
  await expect(dialog.getByText("1. 공통된 내용")).toBeVisible();
  return dialog;
}

for (const viewport of [
  { name: "desktop", width: 1366, height: 720 },
  { name: "mobile", width: 390, height: 844 },
  // The narrowest supported width. A four-button row is exactly the shape
  // that wraps badly, and the mobile composer contract's 320px rule is the
  // reason this width is in the matrix at all.
  { name: "narrow", width: 320, height: 720 },
]) {
  test(`AI Review item feedback renders and submits on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: reviewModels });
    await mockConversationHistory(page);
    await mockComparisonReview(page);
    const feedback = await mockItemFeedback(page);
    await page.goto("/chat");
    await openReviewConversation(page);

    const dialog = await openReview(page);
    const rows = dialog.getByTestId("ai-review-item-feedback");
    await expect(rows.first()).toBeVisible();

    const first = rows.first();
    const helpful = first.getByTestId("ai-review-item-feedback-helpful");
    await expect(helpful).toBeEnabled();
    await expect(helpful).toHaveAttribute("aria-pressed", "false");
    await helpful.click();
    await expect(helpful).toHaveAttribute("aria-pressed", "true");

    expect(feedback.calls).toHaveLength(1);
    expect(feedback.calls[0].method).toBe("PUT");
    expect(feedback.calls[0].body).toMatchObject({
      reviewId: "review-1",
      verdict: "helpful",
    });
    // The id the button sends is the server's derived id, not something the
    // client built: a client-side derivation is exactly what would drift.
    expect(
      (feedback.calls[0].body as { reviewItemId: string }).reviewItemId
    ).toMatch(/^primary:consensus:0:[0-9a-f]{16}$/);

    await expectNoHorizontalOverflow(page);
  });
}

test("selecting the same verdict again withdraws it", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  const feedback = await mockItemFeedback(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  const first = dialog.getByTestId("ai-review-item-feedback").first();
  const incorrect = first.getByTestId("ai-review-item-feedback-incorrect");

  await incorrect.click();
  await expect(incorrect).toHaveAttribute("aria-pressed", "true");
  await incorrect.click();
  await expect(incorrect).toHaveAttribute("aria-pressed", "false");

  expect(feedback.calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);
  expect(feedback.calls[1].body).not.toHaveProperty("verdict");
});

test("the three negative verdicts stay separate reports", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  const feedback = await mockItemFeedback(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  const first = dialog.getByTestId("ai-review-item-feedback").first();

  for (const verdict of ["incorrect", "unclear", "missing_point"]) {
    await first.getByTestId(`ai-review-item-feedback-${verdict}`).click();
    await expect(
      first.getByTestId(`ai-review-item-feedback-${verdict}`)
    ).toHaveAttribute("aria-pressed", "true");
  }
  expect(
    feedback.calls.map((call) => (call.body as { verdict?: string }).verdict)
  ).toEqual(["incorrect", "unclear", "missing_point"]);
});

test("each claim carries its own control, and the two reviewers' claims are separate", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page, { withSecondary: true });
  const feedback = await mockItemFeedback(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  await dialog
    .getByTestId("ai-review-item-feedback")
    .first()
    .getByTestId("ai-review-item-feedback-helpful")
    .click();

  await dialog.getByRole("tab", { name: /검토자 2/ }).click();
  await dialog
    .getByTestId("ai-review-item-feedback")
    .first()
    .getByTestId("ai-review-item-feedback-helpful")
    .click();

  const ids = feedback.calls.map(
    (call) => (call.body as { reviewItemId: string }).reviewItemId
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^primary:/);
  expect(ids[1]).toMatch(/^secondary:/);
  expect(ids[0]).not.toBe(ids[1]);
});

test("the control is reachable and operable by keyboard, and names its own group", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  const feedback = await mockItemFeedback(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  const group = dialog.getByRole("group", { name: "이 항목이 도움이 되었나요?" }).first();
  await expect(group).toBeVisible();

  const helpful = group.getByTestId("ai-review-item-feedback-helpful");
  await helpful.focus();
  await expect(helpful).toBeFocused();
  // A visible focus ring, not just focus: the control is a small chip and a
  // keyboard user has to be able to see which one they are on.
  const outline = await helpful.evaluate(
    (element) => getComputedStyle(element).outlineStyle
  );
  expect(outline).not.toBe("");
  await page.keyboard.press("Enter");
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  expect(feedback.calls).toHaveLength(1);
});

test("a failed submission restores the previous state and says so", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews/item-feedback**",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ feedback: [] }),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "QA fixture: feedback failed." }),
      });
    }
  );
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  const first = dialog.getByTestId("ai-review-item-feedback").first();
  const helpful = first.getByTestId("ai-review-item-feedback-helpful");
  await helpful.click();

  // The optimistic selection is rolled back rather than left showing a
  // verdict the server never stored.
  await expect(helpful).toHaveAttribute("aria-pressed", "false");
  await expect(first).toContainText("저장하지 못했습니다");
});

test("the control never claims the review itself is right or wrong", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  await mockItemFeedback(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const dialog = await openReview(page);
  const first = dialog.getByTestId("ai-review-item-feedback").first();
  await expect(first).toContainText("이 항목 하나에 대한 회원님의 판단입니다");
  await expect(first).toContainText("맞다·틀리다로 표시하지 않습니다");
});
