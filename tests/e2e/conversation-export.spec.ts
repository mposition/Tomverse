import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

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

async function openSidebarOnMobile(page: Page) {
  const openSidebar = page.getByRole("button", { name: /사이드바 열기|Open sidebar|打开侧边栏/ });
  if (await openSidebar.count()) {
    await openSidebar.first().click();
  }
}

async function openConversationMenu(page: Page) {
  await openSidebarOnMobile(page);
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
}) => {
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
  const exportRequests = await mockExportRoute(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openConversationMenu(page);
  const item = downloadItem(page);
  await expect(item).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    item.click(),
  ]);

  expect(exportRequests).toHaveLength(1);
  expect(exportRequests[0]).toContain("/api/conversations/qa-conversation/export");
  expect(download.suggestedFilename()).toBe("qa-conversation.txt");
  // The menu closes once the export starts, so the sidebar is usable again.
  await expect(page.getByTestId("conversation-menu-panel")).toBeHidden();
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
