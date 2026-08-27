import { expect, type Page, test } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

/**
 * Guest -> account identity transitions.
 *
 * The production report: after signing in, the tab kept the `guest_*`
 * conversation id it had been using and handed it to the account APIs --
 * conversation detail, model-settings sync and each comparison panel's history
 * -- which answered `CONVERSATION_FORBIDDEN` every time.
 *
 * The invariant these specs hold: **no account API is ever called with an id
 * from another identity.** The server's ownership check is untouched, and a
 * conversation that really belongs to someone else is still refused.
 */

const GUEST_CONVERSATIONS_KEY = "guest_conversations";
const ACTIVE_CHAT_KEY = "tomverse_active_chat_id";

type RequestLog = { guestConversationRequests: string[]; all: string[] };

const trackConversationRequests = (page: Page): RequestLog => {
  const log: RequestLog = { guestConversationRequests: [], all: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/conversations")) return;
    log.all.push(`${request.method()} ${url.pathname}`);
    if (/\/api\/conversations\/guest_/.test(url.pathname)) {
      log.guestConversationRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  return log;
};

const readGuestState = (page: Page) =>
  page.evaluate(
    ([conversationsKey, activeKey]) => ({
      conversations: window.localStorage.getItem(conversationsKey),
      activeChatId: window.sessionStorage.getItem(activeKey),
      messageKeys: Object.keys(window.localStorage).filter((key) =>
        key.startsWith("guest_messages_")
      ),
    }),
    [GUEST_CONVERSATIONS_KEY, ACTIVE_CHAT_KEY] as const
  );

/** Sends one guest turn, so this browser has a real guest conversation. */
const createGuestConversation = async (
  page: Page,
  testInfo: Parameters<typeof sendChatMessage>[1],
  text = "Guest question before signing in"
) => {
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, text);
  await expect(
    page.locator('[data-message-role="user"]').filter({ hasText: text }).first()
  ).toBeVisible();
  await expect
    .poll(async () => (await readGuestState(page)).activeChatId)
    .toMatch(/^guest_/);
};

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");
});

test("a guest reload returns to the same guest conversation", { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  await createGuestConversation(page, testInfo, "Guest keeps this on reload");
  const before = await readGuestState(page);

  await page.reload();

  const after = await readGuestState(page);
  expect(after.activeChatId).toBe(before.activeChatId);
  expect(
    page.locator('[data-message-role="user"]').filter({
      hasText: "Guest keeps this on reload",
    }).first()
  ).toBeVisible();
});

test("signing in with a guest conversation open never calls an account API with a guest id", { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  await createGuestConversation(page, testInfo);
  const guestState = await readGuestState(page);

  const log = trackConversationRequests(page);
  await mockAuthenticatedApi(page);
  await page.goto("/chat");

  await expect(page.getByTestId("guest-import-current")).toBeVisible();
  // Three comparison panels each load their own history; under the reported
  // defect that was three guest_* requests, plus the detail read and the
  // model-settings sync.
  expect(log.guestConversationRequests).toEqual([]);

  // The transcript itself is untouched -- the import modal has to be able to
  // offer it.
  const afterState = await readGuestState(page);
  expect(afterState.conversations).toBe(guestState.conversations);
  expect(afterState.messageKeys.length).toBeGreaterThan(0);
});

test("accepting the import selects the conversation id the server returned", { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  await createGuestConversation(page, testInfo);

  const log = trackConversationRequests(page);
  await mockAuthenticatedApi(page);
  await page.route("**/api/conversations/import-guest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        conversationId: "qa-conversation",
        alreadyImported: false,
      }),
    })
  );
  await page.goto("/chat");

  await page.getByTestId("guest-import-current").click();

  await expect
    .poll(async () => (await readGuestState(page)).activeChatId)
    .toBe("qa-conversation");
  expect(log.guestConversationRequests).toEqual([]);
  expect(log.all.some((entry) => entry.includes("/api/conversations/qa-conversation"))).toBe(
    true
  );
});

test("skipping the import lands on a usable account screen, with no guest id in flight", { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  await createGuestConversation(page, testInfo);

  const log = trackConversationRequests(page);
  await mockAuthenticatedApi(page);
  await page.goto("/chat");

  await page.getByTestId("guest-import-skip").click();

  await expect(page.getByTestId("guest-import-skip")).toHaveCount(0);
  // Readiness resolved: the composer is usable rather than stuck behind a
  // permanent skeleton.
  await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  await expect
    .poll(async () => (await readGuestState(page)).activeChatId)
    .toBe(null);
  expect(log.guestConversationRequests).toEqual([]);

  // Guest data survives a skip: the user declined to import, not to keep.
  const afterState = await readGuestState(page);
  expect(afterState.messageKeys.length).toBeGreaterThan(0);
});

test("dismissing the import modal never leaks the guest id either", { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  await createGuestConversation(page, testInfo);

  const log = trackConversationRequests(page);
  await mockAuthenticatedApi(page);
  await page.goto("/chat");

  await page.getByTestId("guest-import-close").click();

  await expect(page.getByTestId("guest-import-close")).toHaveCount(0);
  await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  expect(log.guestConversationRequests).toEqual([]);
});

test("a conversation this account cannot open is released once, without retrying", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);

  let forbiddenReads = 0;
  await page.route(/.*\/api\/conversations\/qa-conversation(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    forbiddenReads += 1;
    // The server's real contract, unchanged: a conversation this account does
    // not own is refused, and is never opened by the recovery path.
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Conversation access denied.",
        code: "CONVERSATION_FORBIDDEN",
      }),
    });
  });

  await page.goto("/chat");
  await page.evaluate(
    ([key]) => window.sessionStorage.setItem(key, "qa-conversation"),
    [ACTIVE_CHAT_KEY] as const
  );
  await page.reload();

  // Whatever the restore attempts, it must settle: the composer comes back and
  // the refused id stops being asked for. The assertion is that the count
  // *stops growing*, not that it lands on a particular number -- how many
  // reads the initial resolution legitimately makes is a timing detail, while
  // "it never stops" is the defect (three panels each retrying the same 403).
  await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  await page.waitForTimeout(1_500);
  const settledReads = forbiddenReads;
  expect(settledReads).toBeGreaterThan(0);
  await page.waitForTimeout(2_500);
  expect(forbiddenReads).toBe(settledReads);
  await expect
    .poll(async () => (await readGuestState(page)).activeChatId)
    .toBe(null);
});
