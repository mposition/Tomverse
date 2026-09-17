import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * HELP-NAV-01 guided help: pick a task from the registered intents and see
 * where it is done.
 *
 * Under test, on desktop and mobile alike:
 *   - the guide is reached from the sidebar help menu and lists the intents,
 *     with no text box;
 *   - each destination states its own availability (a guest meets sign-in for
 *     an account destination; a flag that is off is "not available");
 *   - nothing the guide does navigates the chat page, so an unsent draft
 *     survives: settings open in-page, reading pages open in a new tab, a
 *     report opens the feedback dialog and sends nothing;
 *   - it is a modal dialog: focus moves in, Escape closes it, focus returns,
 *     and every control keeps a 44px target.
 */

const DRAFT = "보내지 않은 초안 문장";

const isMobile = (testInfo: TestInfo) => testInfo.project.name.startsWith("mobile");

async function openGuide(page: Page, testInfo: TestInfo) {
  if (isMobile(testInfo)) {
    await page.getByTestId("mobile-sidebar-open").click();
  }
  await page.getByTestId("sidebar-help-button").click();
  await page.getByTestId("sidebar-help-guide").click();
  const dialog = page.getByTestId("help-guide-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDrawerIfMobile(page: Page, testInfo: TestInfo) {
  if (!isMobile(testInfo)) return;
  const close = page.getByTestId("mobile-sidebar-close");
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function typeDraft(page: Page) {
  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill(DRAFT);
  await expect(textarea).toHaveValue(DRAFT);
}

async function expectDraftKept(page: Page, testInfo: TestInfo) {
  await closeDrawerIfMobile(page, testInfo);
  await expect(page.getByTestId("chat-textarea")).toHaveValue(DRAFT);
}

test.describe("guided help", { tag: "@ui-risk" }, () => {
  test("a guest sees every task, sign-in for account destinations, and keeps the draft", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "ko");
    const feedbackPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/feedback")) feedbackPosts.push(request.url());
    });
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await typeDraft(page);

    const dialog = await openGuide(page, testInfo);
    await expect(dialog.getByRole("heading", { name: "무엇을 하고 싶으세요?" })).toBeVisible();
    await expect(dialog.locator("[data-help-intent]")).toHaveCount(12);
    await expect(dialog.locator("input, textarea, [contenteditable]")).toHaveCount(0);
    // Focus moved into the dialog.
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="help-guide-dialog"]'))))
      .toBe(true);

    // An account destination: sign-in is stated, and it opens in a new tab.
    await dialog.getByTestId("help-guide-intent-manage-memory").click();
    const answer = dialog.getByTestId("help-guide-answer");
    await expect(answer).toHaveAttribute("data-intent", "manage-memory");
    await expect(answer.getByRole("heading", { name: "기억한 내용 보기·삭제" })).toBeFocused();
    const memoryOffer = answer.getByTestId("help-guide-offer");
    await expect(memoryOffer).toHaveAttribute("data-availability", "sign-in");
    const signIn = memoryOffer.getByRole("link", { name: /로그인/ });
    await expect(signIn).toHaveAttribute("target", "_blank");
    await expect(signIn).toHaveAttribute("href", /^\/auth\/signin\?callbackUrl=/);

    // A flag that is off (no provider value in this fixture): not available, not sign-in.
    await dialog.getByTestId("help-guide-back").click();
    await expect(dialog.getByTestId("help-guide-intent-manage-memory")).toBeFocused();
    await dialog.getByTestId("help-guide-intent-imported-conversations").click();
    await expect(answer.getByTestId("help-guide-offer")).toHaveAttribute("data-availability", "unavailable");
    await expect(answer.locator('[data-step][data-available="false"]')).toHaveCount(2);

    // A reading page opens in a new tab through the registry's URL.
    await dialog.getByTestId("help-guide-back").click();
    await dialog.getByTestId("help-guide-intent-attach-files").click();
    const guideLink = answer.getByTestId("help-guide-offer").getByRole("link");
    await expect(guideLink).toHaveAttribute("target", "_blank");
    await expect(guideLink).toHaveAttribute("href", /#files-and-drive$/);

    // Every control keeps a 44px touch target and nothing scrolls sideways.
    const small = await dialog.locator("button, a").evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).tabIndex >= 0)
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height < 43.5)
        .map((rect) => Math.round(rect.height))
    );
    expect(small).toEqual([]);
    await expectNoHorizontalOverflow(page);

    // Report: the feedback dialog opens for the user to write; nothing is sent.
    await dialog.getByTestId("help-guide-back").click();
    await dialog.getByTestId("help-guide-intent-report-a-problem").click();
    await answer.locator('[data-kind="feedback"]').getByRole("button").click();
    await expect(page.getByTestId("help-guide-dialog")).toHaveCount(0);
    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
    expect(feedbackPosts).toEqual([]);
    await page.getByTestId("feedback-close").click();

    await expectDraftKept(page, testInfo);
  });

  test("opened from the mobile drawer, the guide covers the page and nothing is painted over it", async ({
    page,
  }, testInfo) => {
    // Staging H7: inside the drawer panel the fixed dialog was laid out and
    // stacked in that panel, drawer-wide, with the conversation list painted
    // over its rows. Measured the way the drawer contract measures reach: the
    // element actually hit at each control's centre.
    test.skip(!isMobile(testInfo), "The drawer only exists on the mobile shell.");
    await prepareGuestPage(page, "ko");
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    const dialog = await openGuide(page, testInfo);

    const placement = await dialog.evaluate((element) => ({
      insideDrawer: Boolean(element.closest('[data-testid="mobile-sidebar-drawer"]')),
      width: element.getBoundingClientRect().width,
      viewport: window.innerWidth,
    }));
    expect(placement.insideDrawer).toBe(false);
    expect(Math.abs(placement.width - placement.viewport)).toBeLessThanOrEqual(1);

    const misses = await dialog.locator("button, a").evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).tabIndex >= 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit && (hit === element || element.contains(hit)) ? null : (element.textContent ?? "").trim() || element.getAttribute("aria-label");
        })
        .filter(Boolean)
    );
    expect(misses).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("Escape closes the guide and returns focus", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await openGuide(page, testInfo);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-guide-dialog")).toHaveCount(0);
    // The menu item that opened the guide is gone, so focus returns to the
    // help button that opened the menu.
    await expect(page.getByTestId("sidebar-help-button")).toBeFocused();
  });

  test("a member opens settings in-page at the right section and keeps the draft", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await typeDraft(page);
    const urlBefore = page.url();

    const dialog = await openGuide(page, testInfo);
    await dialog.getByTestId("help-guide-intent-email-notifications").click();
    const offer = dialog.getByTestId("help-guide-answer").getByTestId("help-guide-offer");
    await expect(offer).toHaveAttribute("data-availability", "open");
    await offer.getByRole("button").click();

    await expect(page.getByTestId("help-guide-dialog")).toHaveCount(0);
    const settings = page.getByRole("dialog", { name: /사용자 설정|User Settings/ });
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId("email-notifications-entry")).toBeVisible();
    // The page itself did not navigate.
    expect(page.url()).toBe(urlBefore);

    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expectDraftKept(page, testInfo);
  });
});
