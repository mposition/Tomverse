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
    (url) => url.pathname === "/api/assistant-profiles",
    (route) =>
      route.fulfill(
        json({ profiles: [], limits: { maxProfilesPerAccount: 20 } })
      )
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

async function openSettingsTab(page: Page, tab: "data" | "ai" | "assistants") {
  // The panel lives in the sidebar, which on mobile is the drawer -- but only
  // when it is not already mounted. Reaching for the drawer button with the
  // modal open waits forever on mobile: the modal is a full-screen overlay
  // and intercepts the click. An open modal takes the tab switch from the
  // event alone, which is what the event is for.
  const alreadyOpen = await settingsDialog(page).isVisible();
  if (!alreadyOpen && isMobileViewport(page)) {
    await page
      .getByRole("button", { name: /Open chat menu|대화 메뉴 열기/ })
      .click();
  }
  await page.evaluate((detail) => {
    window.dispatchEvent(
      new CustomEvent("tomverse:account-settings-open", { detail })
    );
  }, tab);
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
  test("each feature sits in the group its tab owns, as a row @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "data");

    // Data keeps the features that move conversations in and out of the
    // account; personalisation moved to its own tab, and the assertion below
    // is that it is *not* here any more.
    const group = page.getByTestId("settings-data-personalization");
    await expect(group).toBeVisible();
    await expect(group).toContainText("데이터 관리");
    await expect(group.getByTestId("external-import-entry")).toHaveCount(1);
    await expect(group.getByTestId("account-data-entry")).toHaveCount(1);
    await expect(page.getByTestId("memory-entry")).toHaveCount(0);
    await expect(page.getByTestId("assistants-entry")).toHaveCount(0);

    await openSettingsTab(page, "ai");
    const aiGroup = page.getByTestId("settings-ai-personalization");
    await expect(aiGroup).toBeVisible();
    // The group inside the tab is named for what it holds; the tab itself is
    // "AI 개인화", and a group repeating that would say nothing.
    await expect(aiGroup).toContainText("계정 기억");
    await expect(aiGroup.getByTestId("memory-entry")).toHaveCount(1);
    // Assistants moved to a tab of their own, so they must not also appear
    // here: two doors to one collection is how the two drift.
    await expect(page.getByTestId("assistants-entry")).toHaveCount(0);
    // The new-conversation model combination moved with them: it is the third
    // decision about what a model is told, and it was on a tab about theme
    // and language.
    await expect(
      page.getByTestId("settings-new-conversation-models")
    ).toBeVisible();

    // Asserted while each row's own tab is open. A locator resolves when it
    // is awaited, not when it is written, so capturing one on the data tab
    // and checking it after switching to the AI tab looks past a row that is
    // no longer rendered.
    await openSettingsTab(page, "data");
    const importLink = page.getByTestId("external-import-entry-link");
    await expect(importLink).toHaveAttribute("href", "/settings/imports");
    await expect(importLink).toHaveAccessibleName(
      /다른 AI 서비스에서 가져오기[\s\S]*가져오기 관리/
    );
    await expect(importLink).toHaveAccessibleDescription(/가져온 대화 3개/);
    await expect(page.getByTestId("external-import-entry-status")).toBeVisible();

    await openSettingsTab(page, "ai");
    const memoryLink = page.getByTestId("memory-entry-link");
    await expect(memoryLink).toHaveAttribute("href", "/settings/memory");

    // Each row names its own title and its own purpose. A repeated generic
    // CTA ("Open settings") would make these names identical.
    await expect(memoryLink).toHaveAccessibleName(
      /계정 장기 기억[\s\S]*기억 관리/
    );
    await expect(page.getByTestId("memory-entry-status")).toContainText(
      "새 대화에서 사용 중"
    );
  });

  test("the whole row is one keyboard-reachable link with a focus ring", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

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
      tab: "ai" as const,
      linkTestId: "memory-entry-link",
      urlPattern: /\/settings\/memory$/,
      readyTestId: "memory-settings-card",
    },
    {
      name: "external import",
      tab: "data" as const,
      linkTestId: "external-import-entry-link",
      urlPattern: /\/settings\/imports$/,
      readyTestId: "external-import-capacity",
    },
  ]) {
    test(`the ${entry.name} row opens its own detail page`, async ({ page }) => {
      await gotoChatWithSettings(page);
      await openSettingsTab(page, entry.tab);
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
      href: "/chat?settings=ai&settingsSection=memory",
      group: "AI 개인화",
      crumb: "계정 장기 기억",
    },
    {
      name: "assistant profiles",
      path: "/settings/assistants",
      backTestId: "assistants-back-to-settings",
      // There is no row to restore: the assistants tab renders the collection
      // itself, so coming back lands on the content rather than on a link to
      // it. The deep link still names the section, which is what selects the
      // tab.
      entryTestId: "assistants-content",
      entryLinkTestId: null,
      href: "/chat?settings=assistants&settingsSection=assistants",
      group: "AI 어시스턴트",
      crumb: "나의 AI 어시스턴트",
    },
    {
      name: "external import",
      path: "/settings/imports",
      backTestId: "external-import-back",
      entryTestId: "external-import-entry",
      entryLinkTestId: "external-import-entry-link",
      href: "/chat?settings=data&settingsSection=external-import",
      group: "데이터",
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

      // No chat-bound link competing with it at the top of the page. Counting
      // links was the old proxy for this and stopped meaning it once
      // breadcrumb crumbs became navigable: what has to hold is that nothing
      // here offers the chat, not that there is exactly one control.
      const nav = page.getByTestId("settings-detail-nav");
      await expect(nav.getByRole("link", { name: /채팅/ })).toHaveCount(0);
      for (const href of await nav.getByRole("link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? "")
      )) {
        // `/chat?settings=...` is the settings panel, which is where this page
        // goes up to; a bare `/chat` would be the chat itself.
        expect(href === "/chat").toBe(false);
      }
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
      if (detail.entryLinkTestId) {
        await expect(page.getByTestId(detail.entryLinkTestId)).toBeFocused();
      }
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
        // The category, from the section rather than hard-coded. It used to
        // read "데이터 및 개인화" on every detail page, which stopped being
        // true for two of them the moment personalisation got its own tab.
        await expect(breadcrumb).toContainText(detail.group);
        await expect(breadcrumb).toContainText(detail.crumb);
      }
    });
  }

  /* ------------------------------------------- the model finder CTA ----- */

  /**
   * The CTA is another way to decide the new-conversation combination, not a
   * setting of its own. It used to stand between the combination card and the
   * profiles card as a full-width primary button, which read as a third
   * top-level entry.
   */

  test("the recommendation CTA lives inside the combination card @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    const card = page.getByTestId("settings-new-conversation-models");
    const cta = page.getByTestId("settings-model-finder-cta");
    await expect(cta).toBeVisible();
    // DOM ownership, not proximity: the assertion is that it is *inside*.
    await expect(card.getByTestId("settings-model-finder-cta")).toHaveCount(1);

    // And not a sibling of the profiles group.
    const profilesGroup = page.getByTestId("settings-ai-personalization");
    await expect(
      profilesGroup.getByTestId("settings-model-finder-cta")
    ).toHaveCount(0);
  });

  test("the CTA does not assume the visitor has used the finder before", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    const cta = page.getByTestId("settings-model-finder-cta");
    // "다시" would be wrong for everyone who has never opened it, and the
    // settings screen cannot know which kind of visitor this is.
    await expect(cta).not.toContainText("다시");
    await expect(cta).toContainText("내게 맞는 조합 추천받기");
    // The name alone says what it does; the hint is attached, not required.
    await expect(cta).toHaveAttribute("aria-describedby", /model-finder-hint/);
  });

  test("the CTA opens the finder once and moves focus into it", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    const cta = page.getByTestId("settings-model-finder-cta");
    // Two fast clicks: the open is an event broadcast, so an unguarded second
    // click would be a second open.
    await cta.click({ clickCount: 2, delay: 10 });

    await expect(page.getByTestId("model-finder")).toHaveCount(1);
    await expect(settingsDialog(page)).toBeHidden();
    // Focus lands inside the finder rather than falling to the document when
    // the panel behind it closes. Asserted on the element the finder's own
    // focus trap targets, so the check retries while that effect runs -- a
    // one-shot read of `document.activeElement` races it.
    await expect(page.getByTestId("model-finder-close")).toBeFocused();
  });

  test("unsaved combination changes are named before they are lost @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    // Edit the combination and do not save.
    await page.getByTestId("settings-combination-add").click();

    await page.getByTestId("settings-model-finder-cta").click();

    // The finder has not opened, and the loss is stated rather than silent.
    await expect(page.getByTestId("model-finder")).toHaveCount(0);
    const warning = page.getByTestId("settings-model-finder-unsaved");
    await expect(warning).toBeVisible();

    // Cancelling leaves the edit in place.
    await page.getByTestId("settings-model-finder-unsaved-cancel").click();
    await expect(warning).toBeHidden();
    await expect(settingsDialog(page)).toBeVisible();

    // Continuing is a deliberate second click.
    await page.getByTestId("settings-model-finder-cta").click();
    await page.getByTestId("settings-model-finder-unsaved-continue").click();
    await expect(page.getByTestId("model-finder")).toHaveCount(1);
  });

  test("the CTA is reachable and activatable from the keyboard", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    const cta = page.getByTestId("settings-model-finder-cta");
    await cta.focus();
    await expect(cta).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("model-finder")).toHaveCount(1);
  });

  test("the AI tab is named for personalization, not settings @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "ai");

    const dialog = settingsDialog(page);
    await expect(
      dialog.getByRole("button", { name: "AI 개인화" })
    ).toBeVisible();
    // The previous name must not survive anywhere in the panel.
    await expect(dialog.getByText("AI 설정", { exact: true })).toHaveCount(0);
  });

  test("the assistants tab is the management home, not a signpost @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "assistants");

    const tab = page.getByTestId("settings-assistants-tab");
    await expect(tab).toBeVisible();
    // The collection itself, with its create action -- not one row that
    // leaves for a page.
    await expect(tab.getByTestId("assistants-content")).toBeVisible();
    await expect(tab.getByTestId("assistants-create")).toBeVisible();
  });

  test("the user-facing word is assistant, not profile @ui-risk", async ({
    page,
  }) => {
    await gotoChatWithSettings(page);
    await openSettingsTab(page, "assistants");

    const dialog = settingsDialog(page);
    await expect(
      dialog.getByRole("button", { name: "AI 어시스턴트" })
    ).toBeVisible();
    // "프로필" still means the *account* profile elsewhere, so this is scoped
    // to the tab that renders the collection.
    await expect(
      page.getByTestId("settings-assistants-tab").getByText("프로필")
    ).toHaveCount(0);
  });
});
