import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

// Regression cover for the send/render race behind UX-F001.
//
// Sending the first message of a new conversation starts two overlapping
// server round-trips against the same conversation:
//
//   1. the panel's history load, kicked off the moment the new conversation
//      id lands, and
//   2. the send itself (pre-save + /api/chat).
//
// The history response describes the conversation as it was *before* the
// send. When it arrived last, the panel replaced the freshly rendered user
// message and reply with that pre-send history -- so a send that had fully
// succeeded (201 pre-save, 200 /api/chat) rendered an empty panel, while the
// composer had cleared and the sidebar showed the new conversation. It
// reproduced only when the two responses interleaved a certain way, which is
// why it presented as an intermittent ~35% failure under load rather than a
// consistent one.
//
// These tests remove the timing dependency by pinning the interleaving: the
// history load is held open until after the send has completed, which is
// exactly the ordering that used to lose the message.

const userMessages = (page: Page, text: string) =>
  page.locator('[data-message-role="user"]').filter({ hasText: text });

/**
 * Holds GET /api/conversations/:id open for `delayMs` and answers with empty
 * history -- i.e. the conversation as it looked before this send. Registered
 * after the base fixture so it wins the route match.
 */
async function delayConversationHistory(page: Page, delayMs: number) {
  await page.route(
    /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "qa-conversation",
          title: "QA conversation",
          selectedModels: ["gpt-5-4-mini"],
          disabledPanels: [],
          messages: [],
          nextCursor: null,
        }),
      });
    }
  );
}

async function prepareSingleModelChat(page: Page) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
}

test.describe("chat send survives a late conversation-history response", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Enter-to-send drives this flow on desktop projects."
    );
  });

  test("a history response that lands after the send does not erase the message", async ({
    page,
  }) => {
    await prepareSingleModelChat(page);
    await mockChatStream(page, "history race QA response");
    await delayConversationHistory(page, 1500);

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("survives the late history load");
    await textarea.press("Enter");

    await expect(userMessages(page, "survives the late history load")).toHaveCount(1);
    await expect(page.getByText("history race QA response").first()).toBeVisible();

    // The pre-send history lands here. Nothing it carries is newer than what
    // the panel already shows, so it must not be applied.
    await page.waitForTimeout(2500);

    await expect(userMessages(page, "survives the late history load")).toHaveCount(1);
    await expect(page.getByText("history race QA response").first()).toBeVisible();
  });

  test("the same race in the narrowed (mobile-layout) window keeps the message", async ({
    page,
  }) => {
    await prepareSingleModelChat(page);
    await mockChatStream(page, "narrow history race response");
    await delayConversationHistory(page, 1500);

    // A narrow PC window renders the mobile shell but keeps Enter-to-send,
    // because useIsMobileShell() also requires a coarse pointer.
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("narrow window survives");
    await textarea.press("Enter");

    await expect(userMessages(page, "narrow window survives")).toHaveCount(1);

    await page.waitForTimeout(2500);

    await expect(userMessages(page, "narrow window survives")).toHaveCount(1);
  });
});
