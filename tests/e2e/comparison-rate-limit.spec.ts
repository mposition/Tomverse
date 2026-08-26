import { expect, test, type Page } from "@playwright/test";
import {
  mockChatStream,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

/**
 * What a rate-limited comparison looks like to the person who sent it.
 *
 * The aggregate preflight now refuses a whole comparison that cannot fit in
 * the caller's remaining per-minute allowance, instead of letting some panels
 * run and the rest come back 429. That makes `CHAT_RATE_LIMITED` a verdict the
 * *preflight* can return, which the client had no branch for: it fell through
 * to the raw English server sentence with no wait in it, in every language.
 *
 * Pinned here:
 *
 *   * the current language's countdown sentence, with the server's seconds;
 *   * the Trace ID, so what is on screen matches what support can look up;
 *   * no automatic retry -- a refusal that resends itself is the traffic the
 *     limit exists to shed;
 *   * nothing sent to /api/chat, so no panel starts;
 *   * and the draft plus its attachments still in the composer.
 */

const RETRY_AFTER_SECONDS = 6;
const TRACE_ID = "c7216139-abb3-43c9-8735-f6a2206db9a7";
const DRAFT = "Compare these three answers for me";

type RateLimitWorld = {
  preflightCalls: number;
  chatCalls: number;
};

/**
 * Replaces the comparison preflight with the refusal the server now returns,
 * header and body both, and counts every call to it and to /api/chat.
 *
 * Registered after prepareGuestPage so it wins: Playwright matches routes
 * last-registered-first.
 */
async function mockRateLimitedPreflight(page: Page): Promise<RateLimitWorld> {
  const world: RateLimitWorld = { preflightCalls: 0, chatCalls: 0 };

  await page.route("**/api/chat/preflight", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    world.preflightCalls += 1;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: {
        "Retry-After": String(RETRY_AFTER_SECONDS),
        "X-Request-ID": TRACE_ID,
      },
      body: JSON.stringify({
        error: "Requests are being sent too quickly. Wait a moment and try again.",
        code: "CHAT_RATE_LIMITED",
        traceId: TRACE_ID,
        details: {
          scope: "guest_rate_minute",
          limitLayer: "rate_limit",
          retryAfterSeconds: RETRY_AFTER_SECONDS,
          requestedRequests: 3,
          availableRequests: 2,
          rateLimit: 5,
          resetAt: new Date(Date.now() + RETRY_AFTER_SECONDS * 1000).toISOString(),
        },
      }),
    });
  });

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "POST") world.chatCalls += 1;
    await route.fallback();
  });

  return world;
}

const toast = (page: Page) => page.getByTestId("app-toast");
const textarea = (page: Page) => page.getByTestId("chat-textarea");

test.describe("a rate-limited comparison", { tag: "@ui-risk" }, () => {
  test("tells a Korean guest how long to wait, with the Trace ID", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "QA mock response");
    const world = await mockRateLimitedPreflight(page);

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, DRAFT);

    await expect.poll(() => world.preflightCalls).toBe(1);
    // locales/ko.ts chat.tooManyRequestsRetry, with the server's own seconds
    // substituted -- not the raw English sentence the fallback used to show.
    await expect(toast(page)).toContainText(
      `요청이 너무 빠르게 전송되었습니다. ${RETRY_AFTER_SECONDS}초 후 다시 시도해 주세요.`
    );
    await expect(toast(page)).toContainText(TRACE_ID);

    // No panel started, and the question is still where the user typed it.
    expect(world.chatCalls).toBe(0);
    await expect(textarea(page)).toHaveValue(DRAFT);
    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: DRAFT })
    ).toHaveCount(0);
  });

  test("tells an English guest the same thing in their own language", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockChatStream(page, "QA mock response");
    const world = await mockRateLimitedPreflight(page);

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, DRAFT);

    await expect.poll(() => world.preflightCalls).toBe(1);
    await expect(toast(page)).toContainText(
      `Requests are being sent too quickly. Please try again in ${RETRY_AFTER_SECONDS} seconds.`
    );
    await expect(toast(page)).toContainText(TRACE_ID);
    expect(world.chatCalls).toBe(0);
    await expect(textarea(page)).toHaveValue(DRAFT);
  });

  test("does not resend itself", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "QA mock response");
    const world = await mockRateLimitedPreflight(page);

    await page.goto("/chat");
    await sendChatMessage(page, testInfo, DRAFT);

    await expect(toast(page)).toContainText(String(RETRY_AFTER_SECONDS));
    // A 429 is a real verdict, unlike the 500/503 the preflight retries once.
    // Waiting well past that retry window must still show exactly one attempt.
    await page.waitForTimeout(1_500);
    expect(world.preflightCalls).toBe(1);
    expect(world.chatCalls).toBe(0);
  });
});
