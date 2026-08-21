import { test, expect, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * The settings information architecture: how "Import from another AI service"
 * and "Account memory" are presented in the settings list, how their detail
 * pages navigate back up, and how a visitor leaves settings altogether.
 *
 * Three claims are under test and none is shell-specific, so every assertion
 * runs on the desktop and mobile projects alike:
 *
 *   1. the two features sit under ONE group with one row each -- separate
 *      destinations, separate state, but not two headline cards competing on
 *      a tab that has five other sections;
 *   2. their detail pages go back to *settings*, by name, and get there from a
 *      cold URL with no history at all;
 *   3. every settings screen, at every depth, also offers one click out to the
 *      chat. That is a second control, not a replacement: the hierarchical
 *      link still goes one level up, and the exit still goes all the way out,
 *      and neither ever answers for the other.
 *
 * Nothing here depends on the browser Back button, which is deliberately
 * untouched by this navigation.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Mirrors SETTINGS_RETURN_TO_CHAT_TEST_ID in lib/settingsNavigation.ts. */
const RETURN_TO_CHAT = "settings-return-to-chat";

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

      // Nothing inside this nav offers the chat. Counting links was the old
      // proxy for that and stopped meaning it once breadcrumb crumbs became
      // navigable: what has to hold is that every link *here* goes up inside
      // settings, not that there is exactly one control.
      const nav = page.getByTestId("settings-detail-nav");
      await expect(nav.getByRole("link", { name: /채팅/ })).toHaveCount(0);
      await expect(nav.getByTestId(RETURN_TO_CHAT)).toHaveCount(0);
      for (const href of await nav.getByRole("link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? "")
      )) {
        // `/chat?settings=...` is the settings panel, which is where this page
        // goes up to; a bare `/chat` would be the chat itself.
        expect(href === "/chat").toBe(false);
      }

      // Leaving settings entirely is a separate control, rendered by the route
      // shell beside this nav rather than inside it.
      await expect(page.getByTestId(RETURN_TO_CHAT)).toHaveAttribute(
        "href",
        "/chat"
      );
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

/**
 * Every settings depth, and the one control that leaves them all.
 *
 * The exit is route-shell furniture rather than page content, so these cases
 * deliberately do not depend on what each page's own API answers: a 404'd
 * import is still a visitor standing three segments deep in settings, and the
 * way out has to be there for them too. What each case does check is that the
 * page's *own* upward link is still present and still points one level up --
 * the exit was added beside the hierarchy, not on top of it.
 */

/** Nothing here has a body worth seeding; what matters is the depth. */
async function mockDepthApis(page: Page) {
  await mockSettingsEntryApis(page);
  await page.route(
    (url) => url.pathname === "/api/assistant-profiles",
    (route) =>
      route.fulfill(
        json({ profiles: [], limits: { maxProfilesPerAccount: 20 } })
      )
  );
  for (const missing of [
    /^\/api\/assistant-profiles\/[^/]+$/,
    /^\/api\/imports\/external\/[^/]+$/,
    /^\/api\/external-conversations\/[^/]+$/,
    /^\/api\/memories\/extraction-runs\/[^/]+$/,
    /^\/api\/user\/email-preferences$/,
  ]) {
    await page.route(
      (url) => missing.test(url.pathname),
      (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ code: "NOT_FOUND" }),
        })
    );
  }
}

async function gotoSettingsDepth(page: Page, path: string) {
  // Cold, directly opened URL every time: no referrer, no prior page, no
  // history entry to fall back on.
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page);
  await mockDepthApis(page);
  await page.goto(path);
}

const SETTINGS_DEPTHS = [
  {
    name: "import list",
    path: "/settings/imports",
    upTestId: "external-import-back",
  },
  {
    name: "import wizard",
    path: "/settings/imports/new",
    upTestId: "external-import-back",
  },
  {
    name: "one import",
    path: "/settings/imports/imp-qa",
    upTestId: "external-import-detail-back",
  },
  {
    name: "an imported conversation",
    path: "/settings/imports/conversations/conv-qa",
    upTestId: "external-viewer-back",
  },
  {
    name: "memory settings",
    path: "/settings/memory",
    upTestId: "memory-back",
  },
  {
    name: "one extraction run",
    path: "/settings/memory/runs/run-qa",
    upTestId: "memory-extraction-run-back",
  },
  {
    name: "assistant profiles",
    path: "/settings/assistants",
    upTestId: "assistants-back-to-settings",
  },
  {
    name: "a new assistant profile",
    path: "/settings/assistants/new",
    upTestId: "assistant-create-back",
  },
  {
    name: "one assistant profile",
    path: "/settings/assistants/p-qa",
    upTestId: "assistant-back-to-list",
  },
  {
    name: "account data",
    path: "/settings/data",
    upTestId: "account-data-back",
  },
  {
    name: "email notifications",
    path: "/settings/notifications",
    upTestId: "email-notifications-back",
  },
] as const;

test.describe("returning to the chat from settings", () => {
  for (const depth of SETTINGS_DEPTHS) {
    test(`${depth.name} offers the exit without losing its own back link @ui-risk`, async ({
      page,
    }) => {
      await gotoSettingsDepth(page, depth.path);

      const exit = page.getByTestId(RETURN_TO_CHAT);
      await expect(exit).toBeVisible();
      // Exactly /chat. A settings deep link here would reopen the panel
      // the visitor just asked to leave.
      await expect(exit).toHaveAttribute("href", "/chat");
      // The visible label shortens on a narrow viewport; the name does
      // not, so a screen reader hears the same control at every width.
      await expect(exit).toHaveAccessibleName("대화로 돌아가기");

      // The hierarchy is untouched: this page's own link still goes one level
      // up, and up is somewhere inside settings. Where exactly is each page's
      // own business and is pinned by its own spec -- restating it here would
      // make this file fail for a reason it is not about.
      const up = page.getByTestId(depth.upTestId);
      await expect(up).toBeVisible();
      const upHref = await up.getAttribute("href");
      expect(upHref).not.toBe("/chat");
      expect(upHref).toMatch(/^(\/settings\/|\/chat\?settings=)/);

      // Two different controls, and they never occupy the same space.
      const exitBox = await exit.boundingBox();
      const upBox = await up.boundingBox();
      expect(exitBox).not.toBeNull();
      expect(upBox).not.toBeNull();
      const overlaps =
        exitBox!.x < upBox!.x + upBox!.width &&
        upBox!.x < exitBox!.x + exitBox!.width &&
        exitBox!.y < upBox!.y + upBox!.height &&
        upBox!.y < exitBox!.y + exitBox!.height;
      expect(overlaps).toBe(false);
    });

    test(`${depth.name} reaches the chat in one click`, async ({ page }) => {
      await gotoSettingsDepth(page, depth.path);

      await page.getByTestId(RETURN_TO_CHAT).click();

      await expect(page).toHaveURL(/\/chat$/);
      await expect(page.getByTestId("chat-input")).toBeVisible();
      // Out of settings, not back into it: the panel stays closed.
      await expect(settingsDialog(page)).toHaveCount(0);
    });
  }

  test("the exit is reachable from the keyboard @ui-risk", async ({ page }) => {
    await gotoSettingsDepth(page, "/settings/imports/conversations/conv-qa");

    const exit = page.getByTestId(RETURN_TO_CHAT);
    await exit.focus();
    await expect(exit).toBeFocused();
    // A visible ring, not just a focused element -- `focus-visible` is
    // what a keyboard user actually sees.
    const outline = await exit.evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.outlineStyle} ${style.boxShadow}`;
    });
    expect(outline).not.toBe("none none");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("the exit stays reachable without scrolling back up", async ({
    page,
  }) => {
    // The memory page is long enough to bury a top-of-page control, which
    // is exactly the case the sticky strip exists for.
    await gotoSettingsDepth(page, "/settings/memory");
    await expect(page.getByTestId("memory-settings-card")).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 2000));
    const exit = page.getByTestId(RETURN_TO_CHAT);
    await expect(exit).toBeInViewport();

    const box = await exit.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test("a long label at 320px wraps instead of clipping or overlapping @ui-risk", async ({
    page,
  }) => {
    await gotoSettingsDepth(page, "/settings/memory");
    await page.setViewportSize({ width: 320, height: 640 });

    // The widest phrasing any shipped locale gives this control, forced on
    // at the narrowest supported width and at 200% text scaling. The
    // rendering has to survive both without the label being cut off or
    // pushed over the page's own back link.
    await page.getByTestId(RETURN_TO_CHAT).evaluate((node) => {
      for (const span of node.querySelectorAll("span")) {
        span.classList.remove("sm:hidden", "hidden", "sm:inline");
        span.textContent = "Zurück zum Chat";
      }
      document.documentElement.style.fontSize = "32px";
    });

    await expectNoHorizontalOverflow(page);

    const exit = page.getByTestId(RETURN_TO_CHAT);
    const clipped = await exit.evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1
    );
    expect(clipped).toBe(false);

    const exitBox = await exit.boundingBox();
    const upBox = await page.getByTestId("memory-back").boundingBox();
    expect(exitBox).not.toBeNull();
    expect(upBox).not.toBeNull();
    expect(exitBox!.x).toBeGreaterThanOrEqual(0);
    expect(exitBox!.x + exitBox!.width).toBeLessThanOrEqual(321);
    // Still two separate rows, so the wrap cannot have run one control
    // into the other.
    expect(exitBox!.y + exitBox!.height).toBeLessThanOrEqual(upBox!.y + 1);
  });

  test("returning restores this tab's active conversation", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini"],
      messages: [
        { id: "seed-user", role: "user", content: "복귀 확인용 질문" },
        {
          id: "seed-answer",
          role: "assistant",
          content: "복귀 확인용 답변",
          modelId: "gpt-5-4-mini",
        },
      ],
    });
    await mockDepthApis(page);
    // The tab was already on a conversation when settings was opened.
    await page.addInitScript(() => {
      window.sessionStorage.setItem(
        "tomverse_active_chat_id",
        "qa-conversation"
      );
    });

    await page.goto("/settings/memory");
    await page.getByTestId(RETURN_TO_CHAT).click();
    await expect(page).toHaveURL(/\/chat$/);

    // The existing restore path runs untouched: the same conversation is
    // reopened rather than a new one created or the selection cleared.
    await expect(
      page.getByTestId("chat-message-list").first()
    ).toContainText("복귀 확인용 답변");
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
    await expect(
      page.evaluate(() =>
        window.sessionStorage.getItem("tomverse_active_chat_id")
      )
    ).resolves.toBe("qa-conversation");
  });
});
