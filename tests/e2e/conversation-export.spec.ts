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
}) => {
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
  const exportRequests = await mockExportRoute(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openConversationMenu(page);
  const item = downloadItem(page);
  await expect(item).toBeEnabled();

  // The page fetches the export and saves the blob itself, so every engine
  // raises the download -- the reason this assertion is no longer gated by
  // project. Before, mobile WebKit rendered the attachment response and left
  // /chat entirely.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    item.click(),
  ]);

  expect(exportRequests).toHaveLength(1);
  expect(exportRequests[0]).toContain("/api/conversations/qa-conversation/export");
  expect(download.suggestedFilename()).toBe("qa-conversation.txt");
  // Saved rather than navigated to: the chat is still the page on screen.
  expect(new URL(page.url()).pathname).toBe("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  // The menu closes once the export starts, so the sidebar is usable again.
  await expect(page.getByTestId("conversation-menu-panel")).toBeHidden();
});

test("an export the server refuses says so and keeps the workspace", async ({ page }) => {
  // The half a navigation could not do. `location.href` handed a refusal to
  // the browser as a document to render, so the visitor lost the chat and got
  // a JSON error page; now it is a toast on the page they were already on.
  await mockAuthenticatedApi(page);
  await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
  await page.route("**/api/conversations/*/export**", (route) =>
    route.fulfill({
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to export conversation." }),
    })
  );
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openConversationMenu(page);
  await downloadItem(page).click();

  // An error-tone toast is `role="alert"`, not `status` -- the tone is the
  // point, so it is asserted rather than assumed.
  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "error");
  expect(new URL(page.url()).pathname).toBe("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();
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

/**
 * CONT-EXPORT-01B (docs/policy/external-conversation-continuation.md §9.1):
 * a continuation offers two files, and the one that carries the imported
 * original is saved only when it arrived whole.
 */
test.describe("downloading a continuation with its original @ui-risk", () => {
  const CONTINUATION_ID = "qa-continuation-export";
  const SOURCE_BODY = "Tomverse Review Export\nConversation: A continued conversation\n\n";

  const digestOf = async (body: string) => {
    const bytes = new TextEncoder().encode(body);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes,
      hex: Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  };

  /** A conversation list with one continuation row, as the server answers it. */
  const mockContinuationList = (
    page: Page,
    sourceState: "available" | "deleted" = "available"
  ) =>
    page.route("**/api/conversations", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: CONTINUATION_ID,
            title: "A continued conversation",
            kind: "chat",
            projectId: null,
            selectedModels: ["gpt-5-6-luna"],
            disabledPanels: [],
            webSearchMode: "off",
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
            messageCount: 2,
            surface: "continuation",
            sourceState,
            sourceProvider: "chatgpt",
            sourceTitle: "Imported original",
            fallbackTitleDate: "2026-07-02",
          },
        ]),
      });
    });

  /*
    The mobile shell keeps the list in a drawer, and which control opens it
    depends on whether a conversation is open: the welcome screen has the
    disclosure, an open conversation has the header button. This list holds one
    continuation the fixture cannot open, so the screen is the welcome one.
  */
  const openMenuForContinuation = async (page: Page) => {
    const disclosure = page.getByTestId("recent-conversations-disclosure");
    const headerButton = page.getByTestId("mobile-sidebar-open");
    const menu = page.getByTestId("conversation-menu").first();
    await expect(disclosure.or(headerButton).or(menu).first()).toBeVisible();
    if ((await menu.count()) === 0) {
      if ((await disclosure.count()) > 0) await disclosure.click();
      else await headerButton.click();
    }
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
  };

  /*
    The menu holds translated labels, and the panel used to be a fixed 224px
    with `whitespace-nowrap` on every row, so the overflow arrived as a
    horizontal scrollbar with the labels cut mid-word. A string assertion
    cannot see that -- the text is all present in the DOM, just not on screen --
    so what is asserted here is geometry.

    Both source states, because they put different copy in the same row, and
    two text scales, because a wrapping fix that only holds at 100% is a fix
    that holds until somebody enlarges their text.
  */
  for (const sourceState of ["available", "deleted"] as const) {
    for (const textScale of [100, 200]) {
      test(`the menu never scrolls sideways (${sourceState} original, ${textScale}% text)`, async ({
        page,
      }) => {
        await mockAuthenticatedApi(page);
        await mockUserUsage(page, {
          plan: "Pro",
          limits: { allowDownloads: true },
        });
        await mockContinuationList(page, sourceState);
        if (textScale !== 100) {
          await page.addInitScript((scale) => {
            document.documentElement.style.fontSize = `${scale}%`;
          }, textScale);
        }

        await page.goto("/chat");
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await openMenuForContinuation(page);

        const panel = page.getByTestId("conversation-menu-panel");
        const viewport = page.viewportSize();
        expect(viewport).not.toBeNull();

        const measured = await panel.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          scrollLeft: element.scrollLeft,
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
          // Every row, not just the panel: a row can overflow its own box
          // while the panel reports itself clean.
          rowOverflow: Array.from(element.querySelectorAll("button")).filter(
            (row) => row.scrollWidth > row.clientWidth + 1
          ).length,
        }));

        expect(measured.scrollWidth).toBeLessThanOrEqual(
          measured.clientWidth + 1
        );
        expect(measured.scrollLeft).toBe(0);
        expect(measured.rowOverflow).toBe(0);
        // And it is inside the viewport rather than merely not scrolling.
        expect(measured.left).toBeGreaterThanOrEqual(0);
        expect(measured.right).toBeLessThanOrEqual(viewport!.width);

        // The last action is still reachable: a panel that grew taller while
        // its labels wrapped must still let the bottom item be clicked, and
        // `toBeVisible` would pass on something another layer covers.
        const lastItem = panel.locator("button").last();
        await lastItem.scrollIntoViewIfNeeded();
        const reachable = await lastItem.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2
          );
          return element.contains(hit) || element === hit;
        });
        expect(reachable).toBe(true);
      });
    }
  }

  test("both files are offered, and the one with the original is verified before it is saved", async ({
    page,
  }) => {
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
    await mockContinuationList(page);
    const { bytes, hex } = await digestOf(SOURCE_BODY);
    const requests: string[] = [];
    await page.route("**/api/conversations/*/export**", (route) => {
      const url = route.request().url();
      requests.push(url);
      const withSource = url.includes("include=source");
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="qa-continuation.txt"',
          ...(withSource
            ? { "X-Export-Bytes": String(bytes.byteLength), "X-Export-SHA256": hex }
            : {}),
        },
        body: withSource ? SOURCE_BODY : "Tomverse only\n",
      });
    });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openMenuForContinuation(page);

    const withSource = page
      .getByTestId("conversation-menu-panel")
      .getByTestId("conversation-download-with-source");
    // Said before the click, because a downloaded file cannot be recalled.
    await expect(withSource).toContainText("회수할 수 없습니다");
    const download = page.waitForEvent("download");
    await withSource.click();
    expect((await download).suggestedFilename()).toBe("qa-continuation.txt");
    expect(requests.at(-1)).toContain("include=source");

    // And the other item is still the ordinary export, with no query.
    await openMenuForContinuation(page);
    const ordinary = page
      .getByTestId("conversation-menu-panel")
      .getByTestId("conversation-download");
    const second = page.waitForEvent("download");
    await ordinary.click();
    await second;
    expect(requests.at(-1)).not.toContain("include=source");
  });

  test("a file that did not arrive whole is not saved", async ({ page }) => {
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
    await mockContinuationList(page);
    const { bytes, hex } = await digestOf(SOURCE_BODY);
    await page.route("**/api/conversations/*/export**", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="qa-continuation.txt"',
          // Says it is the whole file, and is not.
          "X-Export-Bytes": String(bytes.byteLength),
          "X-Export-SHA256": hex,
        },
        body: SOURCE_BODY.slice(0, 20),
      })
    );

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openMenuForContinuation(page);
    let saved = false;
    page.on("download", () => {
      saved = true;
    });
    await page
      .getByTestId("conversation-menu-panel")
      .getByTestId("conversation-download-with-source")
      .click();

    await expect(page.getByTestId("app-toast").first()).toContainText("끝까지 받지 못해");
    expect(saved).toBe(false);
  });

  test("a locked original is refused with the way out, not a generic failure", async ({
    page,
  }) => {
    await mockAuthenticatedApi(page);
    await mockUserUsage(page, { plan: "Pro", limits: { allowDownloads: true } });
    await mockContinuationList(page);
    await page.route("**/api/conversations/*/export**", (route) =>
      route.fulfill({
        status: 423,
        contentType: "application/json",
        body: JSON.stringify({
          error: "locked",
          code: "EXPORT_SOURCE_LOCKED",
        }),
      })
    );

    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await openMenuForContinuation(page);
    await page
      .getByTestId("conversation-menu-panel")
      .getByTestId("conversation-download-with-source")
      .click();

    await expect(page.getByTestId("app-toast").first()).toContainText("잠금을 해제");
  });
});
