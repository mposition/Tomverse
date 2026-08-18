import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";
import { navigationDownloadsObservable } from "./support/engine-capabilities";

/**
 * Exporting a conversation, and the plan entitlement that gates it.
 *
 * "Download (.txt)" is the only way a customer gets their conversation out of
 * the product, and it is entitlement-gated (`limits.allowDownloads`) rather
 * than universally available. Neither half was covered: nothing opened the
 * conversation menu to check the control's state, and nothing followed the
 * export through to a file. A regression that silently disabled the item for
 * every plan, or that let a guest trigger the server route, would not have
 * been caught.
 */

const EXPORT_BODY = "You: hello\nAssistant: hi\n";

/**
 * Puts the conversation list on screen in whichever shell is running.
 *
 * The desktop sidebar is always mounted; the mobile one lives behind a drawer
 * that has to be opened first, and `mobile-sidebar-open` is the trigger every
 * other mobile spec uses. This looked the trigger up by an accessible name no
 * shell renders -- the real label is `chat.openChatMenu` ("대화 메뉴 열기") --
 * and skipped when it found none, so on mobile the drawer stayed shut and the
 * next line waited 30 seconds for a menu that was never going to mount.
 *
 * Waiting for the menu here rather than assuming it keeps the next rename loud:
 * a missing trigger fails on the trigger, not on something three lines away.
 */
async function showConversationList(page: Page) {
  const openDrawer = page.getByTestId("mobile-sidebar-open");
  if (await openDrawer.isVisible()) {
    await openDrawer.click();
  }
  await expect(page.getByTestId("conversation-menu").first()).toBeVisible();
}

async function openConversationMenu(page: Page) {
  await showConversationList(page);
  await page.getByTestId("conversation-menu").first().click();
  await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
}

const downloadItem = (page: Page) =>
  page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /다운로드|Download|下载/ })
    .first();

/**
 * Stands in for the real export route, which needs a database the E2E server
 * does not have. The response shape is what matters here: an attachment the
 * browser turns into a download.
 */
async function mockExportRoute(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/conversations/*/export**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="qa-conversation.txt"',
      },
      body: EXPORT_BODY,
    });
  });
  return requests;
}

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
});

test("an entitled account can export a conversation to a file", async ({
  page,
}, testInfo) => {
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
  const exportRequests = await mockExportRoute(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openConversationMenu(page);
  const item = downloadItem(page);
  await expect(item).toBeEnabled();

  // The export is a navigation to a route that answers with an attachment, and
  // whether the browser then hands the file to a test is the browser's business
  // -- on WebKit it does not (support/engine-capabilities.ts). What the product
  // decides is asserted below on every engine: the route is requested once, and
  // the page it was requested from is still the one on screen.
  const download = page
    .waitForEvent("download", { timeout: 5_000 })
    .catch(() => null);
  await item.click();
  await expect
    .poll(() => exportRequests.length, { message: "the export route was requested" })
    .toBe(1);
  expect(exportRequests[0]).toContain("/api/conversations/qa-conversation/export");

  // Not a page navigation: a router push would have rendered the response and
  // taken the chat with it.
  expect(new URL(page.url()).pathname).toBe("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  // The menu closes once the export starts, so the sidebar is usable again.
  await expect(page.getByTestId("conversation-menu-panel")).toBeHidden();

  const file = await download;
  if (navigationDownloadsObservable(testInfo)) {
    expect(file, "the attachment response was saved as a download").not.toBeNull();
    expect(file!.suggestedFilename()).toBe("qa-conversation.txt");
  }
});

test("a plan without the download entitlement disables the control and sends nothing", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Free", limits: { allowDownloads: false } });
  const exportRequests = await mockExportRoute(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openConversationMenu(page);
  const item = downloadItem(page);
  await expect(item).toBeDisabled();
  // The reason is on the control itself rather than only in a toast after the
  // fact, and it points at the upgrade.
  await expect(item).toHaveAttribute("title", /.+/);

  await item.click({ force: true });
  expect(exportRequests).toHaveLength(0);
  // A refused export leaves the workspace exactly as it was.
  await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
});
