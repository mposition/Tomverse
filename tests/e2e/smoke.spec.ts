import { expect, test } from "@playwright/test";
import {
  mockChatStream,
  mockPublicBillingConfig,
  mockPublicProofMetrics,
  prepareGuestPage,
} from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await mockPublicBillingConfig(page);
  await mockPublicProofMetrics(page);
});

test("home renders the marketing site", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: "Ask once. Compare multiple AI answers.",
    })
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1024) >= 768) {
    await expect(page.getByRole("link", { name: /^Chat$/i }).first()).toHaveAttribute(
      "href",
      "/chat?lang=en"
    );
  }
  await expect(page.getByTestId("landing-primary-cta")).toHaveText(
    "Start chatting free"
  );
  await expect(page.getByTestId("landing-primary-cta")).toHaveAttribute(
    "href",
    "/chat?lang=en&entry=guest-preview"
  );
  await expect(page.getByTestId("landing-guest-note")).toHaveText(
    "No sign-up required to try a free model."
  );
  await expect(page.getByTestId("landing-guest-cta")).toHaveCount(0);

  await page.getByLabel("Language").selectOption("ko");
  await expect(
    page.getByRole("heading", {
      name: "한 번 질문하고, 여러 AI 답변을 비교하세요.",
    })
  ).toBeVisible();
});

test("signed-in homepage keeps the page visible and offers one continue action", async ({
  page,
}) => {
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "qa-user", email: "qa@example.com" },
        expires: "2099-01-01T00:00:00.000Z",
      }),
    })
  );

  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("landing-primary-cta")).toHaveText(
    /Continue chatting/
  );
  await expect(page.getByTestId("landing-primary-cta")).toHaveAttribute(
    "href",
    "/chat?lang=en"
  );
  await expect(page.getByTestId("landing-guest-note")).toHaveCount(0);
  await expect(page.getByTestId("landing-guest-cta")).toHaveCount(0);
});

test("guest preview opens a 3-model comparison chat by default", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockChatStream(page, "Guest preview answer");
  await page.goto("/chat?lang=en&entry=guest-preview");

  await expect(page.getByTestId("guest-quick-start")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1024) < 768) {
    await page.getByTestId("mobile-sidebar-open").click();
  }
  await expect(page.getByTestId("sidebar-organizer-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  if ((page.viewportSize()?.width ?? 1024) < 768) {
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("button", { name: "Summarize this document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare these models" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review this code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft an email" })).toHaveCount(0);

  // Guests now default to a 3-model comparison (Gemini/GPT/Claude) instead of
  // a single model, so Tomverse's core value is visible on the first question.
  // A single shared welcome screen covers all panels until the first message
  // is sent; the mobile tab switcher only appears once it's gone.
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  if ((page.viewportSize()?.width ?? 1024) >= 768) {
    await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
  }

  await page.getByTestId("chat-textarea").fill("Show me how Tomverse works");
  await page.getByTestId("chat-textarea").press("Enter");
  await expect(
    page.locator(":visible", { hasText: "Guest preview answer" }).first()
  ).toBeVisible();
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1024) < 768) {
    await expect(page.getByTestId("mobile-model-tab")).toHaveCount(3);
  }
});

test("pricing page supports Chinese copy", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByLabel("Language").selectOption("zh");
  await expect(
    page.getByRole("heading", { name: "选择适合你的 AI 能力等级。" })
  ).toBeVisible();
  await expect(page.getByTestId("pricing-credit-packs")).toBeVisible();
  await expect(page.locator('[data-pack-id="starter_500"]')).toContainText("500");
  await expect(page.locator('[data-pack-id="project_1500"]')).toContainText("1,500");
});
