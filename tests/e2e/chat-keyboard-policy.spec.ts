import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

// Enter/Shift+Enter/Ctrl(Cmd)+Enter/IME-composition policy for the main chat
// composer, split by shell: PC keeps Enter-to-send, mobile only sends via
// the on-screen button or an external-keyboard Ctrl/Cmd+Enter.
//
// Tests that assert an exact send count use a single-model authenticated
// conversation (mockAuthenticatedApi's default) rather than the guest
// default, because a guest chat opens 3 comparison panels and a send fans
// out to all of them -- each panel renders its own copy of the user
// message, so "exactly one" would otherwise mean "exactly three".

const userMessages = (page: Page, text: string) =>
  page.locator('[data-message-role="user"]').filter({ hasText: text });

const dispatchComposingEnter = (page: Page) =>
  page.getByTestId("chat-textarea").evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        composed: true,
        isComposing: true,
      })
    );
  });

async function prepareSingleModelChat(page: Page) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
}

test.describe("desktop chat keyboard policy", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Desktop keyboard policy runs in desktop projects."
    );
    await prepareSingleModelChat(page);
    await mockChatStream(page, "PC keyboard QA response");
  });

  test("Enter sends the message exactly once", async ({ page }) => {
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("PC Enter send");
    await textarea.press("Enter");

    await expect(userMessages(page, "PC Enter send")).toHaveCount(1);
    await expect(textarea).toHaveValue("");
  });

  test("Shift+Enter inserts a newline and does not send", async ({ page }) => {
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("first line");
    await textarea.press("Shift+Enter");
    await textarea.type("second line");

    await expect(textarea).toHaveValue("first line\nsecond line");
    await expect(userMessages(page, "first line")).toHaveCount(0);
  });

  test("Enter during IME composition does not send", async ({ page }) => {
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("한글 조합 중");
    await dispatchComposingEnter(page);

    await expect(userMessages(page, "한글 조합 중")).toHaveCount(0);
    await expect(textarea).toHaveValue("한글 조합 중");
  });

  test("narrowing the PC browser window keeps Enter-to-send", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Narrow PC window still sends");
    await textarea.press("Enter");

    await expect(userMessages(page, "Narrow PC window still sends")).toHaveCount(1);
  });

  test("repeated Enter while sending does not duplicate the request", async ({ page }) => {
    let chatRequestCount = 0;
    await page.unroute("**/api/chat");
    await page.route("**/api/chat", async (route) => {
      chatRequestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: "Delayed PC response",
      });
    });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Only once please");
    await textarea.press("Enter");
    await textarea.press("Enter");
    await textarea.press("Enter");

    await expect(page.getByText("Delayed PC response", { exact: true })).toBeVisible();
    expect(chatRequestCount).toBe(1);
  });
});

test.describe("mobile chat keyboard policy", () => {
  test.beforeEach(async (_fixtures, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Mobile keyboard policy runs in mobile projects."
    );
  });

  test("Enter inserts a newline and never sends (guest)", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "Mobile keyboard QA response");
    await page.goto("/chat");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("mobile line one");
    await textarea.press("Enter");
    await textarea.type("mobile line two");

    await expect(textarea).toHaveValue("mobile line one\nmobile line two");
    await expect(userMessages(page, "mobile line one")).toHaveCount(0);
  });

  test("multiple Enter presses produce multiple newlines (guest)", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "Mobile keyboard QA response");
    await page.goto("/chat");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("a");
    await textarea.press("Enter");
    await textarea.press("Enter");
    await textarea.type("b");

    await expect(textarea).toHaveValue("a\n\nb");
  });

  test("Shift+Enter inserts a newline and does not send (guest)", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "Mobile keyboard QA response");
    await page.goto("/chat");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("shift line one");
    await textarea.press("Shift+Enter");
    await textarea.type("shift line two");

    await expect(textarea).toHaveValue("shift line one\nshift line two");
    await expect(userMessages(page, "shift line one")).toHaveCount(0);
  });

  test("Enter during IME composition never sends, even with Ctrl held (guest)", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "Mobile keyboard QA response");
    await page.goto("/chat");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("한글 모바일 조합 중");
    await dispatchComposingEnter(page);

    await expect(userMessages(page, "한글 모바일 조합 중")).toHaveCount(0);
    await expect(textarea).toHaveValue("한글 모바일 조합 중");
  });

  test("a whitespace/newline-only message is not sendable (guest)", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockChatStream(page, "Mobile keyboard QA response");
    await page.goto("/chat");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("   ");
    await textarea.press("Enter");
    await textarea.type("  ");

    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
  });

  test("the send button sends a multi-line message exactly once", async ({ page }) => {
    await prepareSingleModelChat(page);
    await mockChatStream(page, "Mobile keyboard QA response");

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("mobile line one");
    await textarea.press("Enter");
    await textarea.type("mobile line two");

    await page.getByTestId("chat-send-button").click();

    await expect(
      userMessages(page, "mobile line one").filter({ hasText: "mobile line two" })
    ).toHaveCount(1);
    await expect(textarea).toHaveValue("");
  });

  test("Ctrl+Enter sends from an external keyboard", async ({ page }) => {
    await prepareSingleModelChat(page);
    await mockChatStream(page, "Mobile keyboard QA response");

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("mobile ctrl-enter send");
    await textarea.press("Control+Enter");

    await expect(userMessages(page, "mobile ctrl-enter send")).toHaveCount(1);
    await expect(textarea).toHaveValue("");
  });

  test("Cmd+Enter sends from an external keyboard", async ({ page }) => {
    await prepareSingleModelChat(page);
    await mockChatStream(page, "Mobile keyboard QA response");

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("mobile cmd-enter send");
    await textarea.press("Meta+Enter");

    await expect(userMessages(page, "mobile cmd-enter send")).toHaveCount(1);
    await expect(textarea).toHaveValue("");
  });

  test("a failed send still clears the composer and surfaces a retryable error", async ({
    page,
  }) => {
    await prepareSingleModelChat(page);
    await page.unroute("**/api/chat");
    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 500, contentType: "text/plain", body: "server error" })
    );

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("line one");
    await textarea.press("Enter");
    await textarea.type("line two");

    await page.getByTestId("chat-send-button").click();

    // This app clears the composer optimistically on submit (matching PC
    // behavior) and surfaces the failure as a retryable message in history
    // rather than restoring the typed text to the input box.
    await expect(textarea).toHaveValue("");
    await expect(
      userMessages(page, "line one").filter({ hasText: "line two" })
    ).toBeVisible();
  });
});
