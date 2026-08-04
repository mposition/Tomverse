import { test, expect, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * The settings information architecture: how "Import from another AI service"
 * and "Account memory" are presented in the settings list, and how their
 * detail pages navigate back up.
 *
 * Two claims are under test and neither is shell-specific, so every assertion
 * runs on the desktop and mobile projects alike:
 *
 *   1. the two features sit under ONE group with one row each -- separate
 *      destinations, separate state, but not two headline cards competing on
 *      a tab that has five other sections;
 *   2. their detail pages go back to *settings*, by name, and get there from a
 *      cold URL with no history at all. Settings is a closable panel rather
 *      than a route, so leaving it entirely stays the panel's close action:
 *      the detail pages must not grow a second, chat-bound link.
 *
 * Nothing here depends on the browser Back button, which is deliberately
 * untouched by this navigation.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const isMobileViewport = (page: Page) =>
  (page.viewportSize()?.width ?? 1920) < 768;

const settingsDialog = (page: Page) =>
  page.getByRole("dialog", { name: /User Settings|사용자 설정/ });

async function mockSettingsEntryApis(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/imports/external/capacity",
    (route) =>
      route.fulfill(
        json({
          limits: {
            maxNormalizedTextBytes: 50 * 1024 * 1024,
            maxExternalConversations: 2000,
            maxExternalMessages: 100000,
            maxStoredMessageCodePoints: 100000,
            maxInboundMessageCodePoints: 1000000,
          },
          usage: {
            normalizedTextBytes: 2 * 1024 * 1024,
            externalConversations: 3,
            externalMessages: 40,
          },
          remaining: {
            normalizedTextBytes: 48 * 1024 * 1024,
            externalConversations: 1997,
            externalMessages: 99960,
          },
          generatedAt: "2026-08-03T00:00:00.000Z",
        })
      )
  );
  await page.route(
    (url) => url.pathname === "/api/imports/external",
    (route) => route.fulfill(json({ imports: [] }))
  );
  await page.route(
    (url) => url.pathname === "/api/external-conversations",
    (route) =>
      route.fulfill(json({ total: 0, offset: 0, limit: 50, conversations: [] }))
  );
  await page.route(
    (url) => url.pathname === "/api/memories/settings",
    (route) =>
      route.fulfill(
        json({
          masterEnabled: true,
          styleEnabled: true,
          defaultConversationMode: "on",
        })
      )
  );
  await page.route(
    (url) => url.pathname === "/api/memories",
    (route) =>
      route.fulfill(json({ total: 0, offset: 0, limit: 100, memories: [] }))
  );
}

async function openSettingsDataTab(page: Page) {
  // The panel lives in the sidebar, which on mobile is the drawer.
  if (isMobileViewport(page)) {
    await page
      .getByRole("button", { name: /Open chat menu|대화 메뉴 열기/ })
      .click();
  }
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("tomverse:account-settings-open", { detail: "data" })
    );
  });
  await expect(settingsDialog(page)).toBeVisible();
}

async function gotoChatWithSettings(page: Page) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page);
  await mockSettingsEntryApis(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

test.describe("settings information architecture", () => {
  test("both features sit in one group as separate rows @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsDataTab(page);

    const group = page.getByTestId("settings-data-personalization");
    await expect(group).toBeVisible();
    await expect(group).toContainText("데이터 및 개인화");

    // One group, two rows -- and the rows are inside it, not beside it.
    await expect(group.getByTestId("external-import-entry")).toHaveCount(1);
    await expect(group.getByTestId("memory-entry")).toHaveCount(1);

    const importLink = page.getByTestId("external-import-entry-link");
    const memoryLink = page.getByTestId("memory-entry-link");
    await expect(importLink).toHaveAttribute("href", "/settings/imports");
    await expect(memoryLink).toHaveAttribute("href", "/settings/memory");

    // Each row names its own title and its own purpose. A repeated generic
    // CTA ("Open settings") would make these two names identical.
    await expect(importLink).toHaveAccessibleName(
      /다른 AI 서비스에서 가져오기[\s\S]*가져오기 관리/
    );
    await expect(memoryLink).toHaveAccessibleName(
      /계정 장기 기억[\s\S]*기억 관리/
    );

    // Title, description and status are all distinguishable, and the
    // description/status never run into the accessible name.
    await expect(importLink).toHaveAccessibleDescription(/가져온 대화 3개/);
    await expect(page.getByTestId("external-import-entry-status")).toBeVisible();
    await expect(page.getByTestId("memory-entry-status")).toContainText(
      "새 대화에서 사용 중"
    );
  });

  test("the whole row is one keyboard-reachable link with a focus ring", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsDataTab(page);

    const memoryLink = page.getByTestId("memory-entry-link");
    await memoryLink.focus();
    await expect(memoryLink).toBeFocused();
    // Whole-row activation, from the keyboard, without a nested button: the
    // row itself is the link, so Enter on it navigates.
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/memory$/);
    await expect(page.getByTestId("memory-settings-card")).toBeVisible();
  });

  for (const entry of [
    {
      name: "account memory",
      linkTestId: "memory-entry-link",
      urlPattern: /\/settings\/memory$/,
      readyTestId: "memory-settings-card",
    },
    {
      name: "external import",
      linkTestId: "external-import-entry-link",
      urlPattern: /\/settings\/imports$/,
      readyTestId: "external-import-capacity",
    },
  ]) {
    test(`the ${entry.name} row opens its own detail page`, async ({ page }) => {
      await gotoChatWithSettings(page);
      await openSettingsDataTab(page);
      await page.getByTestId(entry.linkTestId).click();
      await expect(page).toHaveURL(entry.urlPattern);
      await expect(page.getByTestId(entry.readyTestId)).toBeVisible();
    });
  }

  for (const detail of [
    {
      name: "account memory",
      path: "/settings/memory",
      backTestId: "memory-back",
      entryTestId: "memory-entry",
      entryLinkTestId: "memory-entry-link",
      href: "/chat?settings=data&settingsSection=memory",
      crumb: "계정 장기 기억",
    },
    {
      name: "external import",
      path: "/settings/imports",
      backTestId: "external-import-back",
      entryTestId: "external-import-entry",
      entryLinkTestId: "external-import-entry-link",
      href: "/chat?settings=data&settingsSection=external-import",
      crumb: "다른 AI 서비스에서 가져오기",
    },
  ]) {
    test(`${detail.name} goes back to settings, never to the chat @ui-risk`, async ({
      page,
    }) => {
      await prepareGuestPage(page, "ko");
      await mockAuthenticatedApi(page);
      await mockSettingsEntryApis(page);
      // A cold, directly opened URL: there is no history to go back to, so
      // the link has to name its destination.
      await page.goto(detail.path);

      const back = page.getByTestId(detail.backTestId);
      await expect(back).toBeVisible();
      await expect(back).toContainText("설정으로 돌아가기");
      await expect(back).toHaveAttribute("href", detail.href);

      // No second, chat-bound link competing with it at the top of the page.
      const nav = page.getByTestId("settings-detail-nav");
      await expect(nav.getByRole("link")).toHaveCount(1);
      await expect(nav.getByRole("link", { name: /채팅/ })).toHaveCount(0);
    });

    test(`${detail.name} restores the settings row it was opened from`, async ({
      page,
    }) => {
      await prepareGuestPage(page, "ko");
      await mockAuthenticatedApi(page);
      await mockSettingsEntryApis(page);
      await page.goto(detail.path);

      await page.getByTestId(detail.backTestId).click();

      // The settings panel, on the tab the entry belongs to, with the row the
      // visitor came from focused -- and the served request dropped from the
      // address bar rather than left to fire again on reload.
      await expect(settingsDialog(page)).toBeVisible();
      await expect(page.getByTestId(detail.entryTestId)).toBeVisible();
      await expect(page.getByTestId(detail.entryLinkTestId)).toBeFocused();
      await expect(page).toHaveURL(/\/chat$/);
    });

    test(`${detail.name} shows the same hierarchy on both shells`, async ({
      page,
    }) => {
      await prepareGuestPage(page, "ko");
      await mockAuthenticatedApi(page);
      await mockSettingsEntryApis(page);
      await page.goto(detail.path);

      // The wording is identical everywhere; only the desktop trail is extra.
      await expect(page.getByTestId(detail.backTestId)).toContainText(
        "설정으로 돌아가기"
      );
      const breadcrumb = page.getByTestId("settings-breadcrumb");
      if (isMobileViewport(page)) {
        await expect(breadcrumb).toBeHidden();
      } else {
        await expect(breadcrumb).toBeVisible();
        await expect(breadcrumb).toContainText("설정");
        await expect(breadcrumb).toContainText("데이터 및 개인화");
        await expect(breadcrumb).toContainText(detail.crumb);
      }
    });
  }
});
