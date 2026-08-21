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

      // The hierarchical nav stays exactly one link, and it is the upward one.
      // The way out of settings is a separate control in the route shell, so
      // it must not have leaked into this nav or borrowed its wording.
      const nav = page.getByTestId("settings-detail-nav");
      await expect(nav.getByRole("link")).toHaveCount(1);
      await expect(nav.getByTestId(RETURN_TO_CHAT)).toHaveCount(0);
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
    upTestId: "assistants-back-to-settings",
  },
  {
    name: "one assistant profile",
    path: "/settings/assistants/p-qa",
    upTestId: "assistants-back-to-settings",
  },
  {
    name: "account data",
    path: "/settings/data",
    upTestId: "account-data-back",
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
