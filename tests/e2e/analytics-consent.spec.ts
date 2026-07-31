import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("mobile analytics consent stays compact with one-row actions", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Mobile consent layout only runs in mobile projects."
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.route("**/api/analytics/events", (route) =>
    route.fulfill({ status: 202, body: "" })
  );
  await page.goto("/");

  const banner = page.getByRole("region", {
    name: "Privacy-safe product analytics",
  });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "Help improve Tomverse. Prompts and file contents are never collected."
  );

  const decline = banner.getByRole("button", { name: "Decline" });
  const accept = banner.getByRole("button", { name: "Allow analytics" });
  const [bannerBox, declineBox, acceptBox] = await Promise.all([
    banner.boundingBox(),
    decline.boundingBox(),
    accept.boundingBox(),
  ]);

  expect(bannerBox).not.toBeNull();
  expect(declineBox).not.toBeNull();
  expect(acceptBox).not.toBeNull();
  expect(bannerBox!.height).toBeLessThanOrEqual(80);
  expect(Math.abs(declineBox!.y - acceptBox!.y)).toBeLessThanOrEqual(1);
  expect(declineBox!.x + declineBox!.width).toBeLessThan(acceptBox!.x);

  await accept.click();
  await expect(banner).toBeHidden();
});

// The floating analytics-settings shortcut used to be the only path back to
// analytics preferences on mobile chat, so it had to duck out of the way of
// the keyboard. Since 2026-07-23 it is hidden on mobile chat unconditionally
// (components/analytics/AnalyticsProvider.tsx: "hidden ... md:inline-flex"),
// and guests reach preferences through the sidebar drawer instead
// (components/auth/AuthButton.tsx's guest-analytics-cookie-settings, wired
// up via ChatSidebar's showAnalyticsCookieButton={isMobileDrawer}). The
// three tests below replace the old single keyboard-overlap test with that
// current contract: the shortcut never reappears, the composer stays usable
// regardless, and the drawer is a working replacement entry point.
const initMobileGuestAnalyticsState = (page: Page) =>
  page.addInitScript(() => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
    window.sessionStorage.removeItem("tomverse_guest_quick_start_active_v2");
  });

test("mobile guest chat never shows the floating analytics settings shortcut", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Floating-shortcut visibility only applies to mobile chat."
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await initMobileGuestAnalyticsState(page);
  await page.goto("/chat");

  const settings = page.getByTestId("analytics-settings-button");
  // REAUDIT-P1-01: the floating pill is not rendered on /chat at all any
  // more, on either shell -- the sidebar account card and the collapsed
  // rail's account menu carry the control in normal document flow instead.
  // So this is "absent", not "present but CSS-hidden".
  await expect(settings).toHaveCount(0);

  const textarea = page.getByTestId("chat-textarea");
  await textarea.click();
  await expect(settings, "stays hidden on textarea focus").toBeHidden();
  await textarea.fill("Does the old shortcut leak back in?");
  await expect(settings, "stays hidden while typing").toBeHidden();
  await textarea.evaluate((element) => element.blur());
  await expect(settings, "stays hidden after blur").toBeHidden();

  await expect(page.getByTestId("chat-send-button")).toBeVisible();
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
});

test("mobile guest chat keeps the composer usable and overflow-free while the keyboard is active", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Chat keyboard overlap only runs in mobile projects."
  );

  await page.setViewportSize({ width: 390, height: 520 });
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await initMobileGuestAnalyticsState(page);
  await page.goto("/chat");

  const settings = page.getByTestId("analytics-settings-button");
  await expect(settings).toBeHidden();

  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill("Line one\nLine two\nKeyboard overlap regression check");
  await expect(settings, "stays hidden with a multi-line draft").toBeHidden();

  const sendButton = page.getByTestId("chat-send-button");
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeEnabled();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(
    dimensions.viewport + 1
  );

  // With the floating shortcut gone, the drawer is the only path back to
  // analytics preferences -- it must stay reachable even mid-draft.
  await expect(page.getByTestId("mobile-sidebar-open")).toBeVisible();
});

test("mobile guest chat opens analytics preferences from the sidebar drawer", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Guest drawer analytics entry point only applies to mobile chat."
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await initMobileGuestAnalyticsState(page);
  await page.goto("/chat");

  await expect(page.getByTestId("analytics-settings-button")).toBeHidden();

  await page.getByTestId("mobile-sidebar-open").click();
  const drawer = page.getByTestId("mobile-chat-shell").getByRole("dialog");
  await expect(drawer).toBeVisible();

  const analyticsButton = drawer.getByTestId("guest-analytics-cookie-settings");
  await expect(analyticsButton).toBeVisible();
  await expect(analyticsButton).toHaveAccessibleName(/analytics|cookie/i);

  // Real clickable hit area, not the inner icon/text glyph -- the button is
  // a plain labeled text control (no icon), so color/icon dependence isn't
  // a concern here. REAUDIT-P1-02: this used to accept the ~40px box the
  // control actually had; the product now meets the 44px floor, so the
  // assertion is the floor rather than a record of the gap.
  const box = await analyticsButton.boundingBox();
  expect(box, "guest analytics settings button bounding box").not.toBeNull();
  if (box) {
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44 - 0.5);
  }

  await analyticsButton.focus();
  await expect(analyticsButton, "keyboard-focusable").toBeFocused();

  await analyticsButton.click();

  // Opening preferences must close the drawer: the notice portals into a
  // slot in the main chat area, which sits below the drawer's fixed
  // overlay, so leaving the drawer open would render the notice invisible
  // and unclickable behind it (components/chat/MobileChatShell.tsx).
  await expect(drawer, "drawer closes so the notice isn't trapped behind it").toBeHidden();

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  const declineButton = notice.getByTestId("analytics-consent-decline");
  const acceptButton = notice.getByTestId("analytics-consent-accept");
  await expect(declineButton).toBeVisible();
  await expect(acceptButton).toBeVisible();
  await expect(notice.getByRole("link", { name: "Privacy policy" })).toBeVisible();

  // The notice must not block the composer underneath it.
  const sendButton = page.getByTestId("chat-send-button");
  await expect(sendButton).toBeVisible();
  const sendBox = await sendButton.boundingBox();
  const noticeBox = await notice.boundingBox();
  expect(sendBox, "send button bounding box").not.toBeNull();
  expect(noticeBox, "notice bounding box").not.toBeNull();
  if (sendBox && noticeBox) {
    const overlaps =
      sendBox.x < noticeBox.x + noticeBox.width &&
      sendBox.x + sendBox.width > noticeBox.x &&
      sendBox.y < noticeBox.y + noticeBox.height &&
      sendBox.y + sendBox.height > noticeBox.y;
    expect(overlaps, "send button must not sit under the notice").toBe(false);
  }

  await declineButton.click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("declined");

  // Chat stays usable once the settings UI is closed.
  await expect(sendButton).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
});

test("authenticated chat moves analytics settings into the account menu", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Authenticated account-menu analytics is covered once in desktop Chromium."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
  });
  await page.goto("/chat?lang=en");

  // The floating shortcut's JSX is skipped entirely on /chat, for guests and
  // signed-in users alike (REAUDIT-P1-01).
  await expect(page.getByTestId("analytics-settings-button")).toHaveCount(0);
  await page.getByTestId("account-menu-trigger").click();
  const accountMenu = page.getByTestId("account-menu");
  await expect(accountMenu).toBeVisible();
  const analyticsSettings = accountMenu.getByTestId("account-analytics-settings");
  await expect(analyticsSettings).toBeVisible();
  await analyticsSettings.click();

  // The account menu closes itself before opening preferences
  // (components/auth/AuthButton.tsx calls setIsAccountMenuOpen(false)
  // ahead of openAnalyticsPreferences()), so it shouldn't linger on top of
  // or behind the notice.
  await expect(accountMenu).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Privacy-safe product analytics" })
  ).toBeVisible();
});

// AUD-R003: the two banners are gated by the same coordination the guest
// quick-start guide and AnalyticsProvider already share (ChatInput.tsx's
// announceGuestQuickStart -> sessionStorage ACTIVE_KEY + the
// "tomverse:guest-quick-start" event AnalyticsProvider listens for) -- a
// fresh guest must see the quick-start guide first, with the consent notice
// deferred, and only get the notice once the guide is dismissed (here, by
// focusing the composer, which is the guide's own documented dismissal path).
test("a fresh guest sees the quick-start guide before the analytics consent notice, never both competing at once", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Ordering logic is timing-driven, not layout-driven -- covered once."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  // No quick-start-seen flag and no guest-preview mode: this is a genuinely
  // fresh guest, the only state the quick-start guide actually renders for.
  await page.goto("/chat?lang=en");

  const quickStart = page.getByTestId("guest-quick-start");
  const notice = page.getByTestId("chat-consent-notice");
  await expect(quickStart, "quick-start guide shows for a fresh guest").toBeVisible();
  await expect(notice, "consent notice stays deferred while the guide is up").toHaveCount(0);

  // The guide's documented dismissal path: focusing the composer.
  await page.getByTestId("chat-textarea").click();
  await expect(quickStart, "guide dismisses on composer focus").toBeHidden();
  await expect(notice, "consent notice appears once the guide clears").toBeVisible();
});

test("both consent controls are reachable and operable by keyboard alone", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Keyboard operability is input-method-driven, not layout-driven -- covered once."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
  });
  await page.goto("/chat?lang=en");

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  const decline = notice.getByTestId("analytics-consent-decline");
  const accept = notice.getByTestId("analytics-consent-accept");

  await decline.focus();
  await expect(decline, "decline is keyboard-focusable").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(accept, "accept is reachable by Tab from decline").toBeFocused();

  await page.keyboard.press("Enter");
  await expect(notice, "Enter on the focused accept control activates it").toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("accepted");
});

test("Australia starts privacy-minimized analytics with an immediate opt-out", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Regional consent behavior is covered once in desktop Chromium."
  );

  let analyticsEvents = 0;
  await prepareGuestPage(page, "en");
  await page.context().addCookies([
    {
      name: "_ga",
      value: "GA1.1.123.456",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.route("**/api/analytics/consent-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ country: "AU", mode: "notice_opt_out" }),
    })
  );
  await page.route("**/api/analytics/events", (route) => {
    analyticsEvents += 1;
    return route.fulfill({ status: 202, body: "" });
  });
  await page.goto("/?utm_source=regional-qa");

  const notice = page.getByRole("region", {
    name: "Privacy-safe analytics is on",
  });
  await expect(notice).toBeVisible();
  await expect.poll(() => analyticsEvents).toBeGreaterThan(0);

  await notice.getByRole("button", { name: "Turn off analytics" }).click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("tomverse_analytics_consent_v1")
      )
    )
    .toBe("declined");
  await expect
    .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "_ga"))
    .toBe(false);
});

test("UK visitors do not load GA4 before explicit consent", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Regional consent behavior is covered once in desktop Chromium."
  );

  let analyticsEvents = 0;
  await prepareGuestPage(page, "en");
  await page.route("**/api/analytics/consent-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ country: "GB", mode: "opt_in" }),
    })
  );
  await page.route("**/api/analytics/events", (route) => {
    analyticsEvents += 1;
    return route.fulfill({ status: 202, body: "" });
  });

  await page.goto("/");
  const banner = page.getByRole("region", {
    name: "Privacy-safe product analytics",
  });
  await expect(banner).toBeVisible();
  expect(analyticsEvents).toBe(0);

  await banner.getByRole("button", { name: "Allow analytics" }).click();
  await expect.poll(() => analyticsEvents).toBeGreaterThan(0);
});

// STG-F001: the analytics consent notice used to float as a viewport-fixed
// overlay, which could sit on top of the chat composer (a first-visit guest
// on a small viewport lands on the empty-conversation welcome screen, whose
// floating composer sits centered on screen -- exactly where the fixed
// banner also anchored). The notice now portals into a flex-flow slot next
// to whichever composer layout is active, so it can only ever push the
// composer aside, never cover it.
// The chat sidebar also has its own "More actions"-labeled hamburger
// button, so the composer's "+" and model-select triggers are targeted the
// same way chat-tools.spec.ts does: by position among the two
// chat-input-popover triggers, scoped to the chat-input container.
const chatComposerLocators = (page: Page) => {
  const popoverTriggers = page
    .getByTestId("chat-input")
    .locator('button[aria-controls="chat-input-popover"]');
  return {
    moreActions: popoverTriggers.nth(0),
    modelSelect: popoverTriggers.nth(1),
    estimatedCredits: page.getByRole("button", {
      name: /Estimated .* credits, view breakdown/,
    }),
    sendButton: page.getByTestId("chat-send-button"),
    textarea: page.getByTestId("chat-textarea"),
  };
};

const dismissOnboardingIfPresent = async (page: Page) => {
  const onboarding = page.getByRole("button", { name: "Start using Tomverse" });
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.click();
  }
};

const REGRESSION_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

for (const viewport of REGRESSION_VIEWPORTS) {
  test(`STG-F001: analytics consent notice never overlaps the guest chat composer at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Layout-overlap regression is viewport-driven via explicit setViewportSize, covered once."
    );

    await page.context().addCookies([
      {
        name: "__tomverse_e2e_analytics",
        value: "1",
        url: "http://127.0.0.1:3100",
      },
    ]);
    await prepareGuestPage(page, "en");
    await page.setViewportSize(viewport);
    await page.goto("/chat?lang=en&entry=guest-preview");
    await dismissOnboardingIfPresent(page);

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(
      dimensions.viewport + 1
    );

    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    const noticeBox = await notice.boundingBox();
    expect(noticeBox).not.toBeNull();
    if (!noticeBox) return;

    const controls = chatComposerLocators(page);
    for (const [name, locator] of Object.entries(controls)) {
      await expect(locator, `${name} visible`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${name} bounding box`).not.toBeNull();
      if (!box) continue;

      const overlapsHorizontally =
        box.x < noticeBox.x + noticeBox.width && box.x + box.width > noticeBox.x;
      const overlapsVertically =
        box.y < noticeBox.y + noticeBox.height && box.y + box.height > noticeBox.y;
      expect(
        overlapsHorizontally && overlapsVertically,
        `${name} must not overlap the consent notice`
      ).toBe(false);

      const hitsItself = await locator.evaluate((el, targetBox) => {
        const centerX = targetBox.x + targetBox.width / 2;
        const centerY = targetBox.y + targetBox.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return hit !== null && el.contains(hit);
      }, box);
      expect(hitsItself, `${name} center hit-tests to itself`).toBe(true);
    }

    // The notice's own controls stay reachable and clickable too.
    const declineButton = notice.getByTestId("analytics-consent-decline");
    const acceptButton = notice.getByTestId("analytics-consent-accept");
    await expect(declineButton).toBeVisible();
    await expect(acceptButton).toBeVisible();
    const privacyLink = notice.getByRole("link", { name: "Privacy policy" });
    await expect(privacyLink).toBeVisible();
  });
}

test("STG-F001: Choose AI models opens the model dialog with the consent notice open", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout-overlap regression is viewport-driven, covered once."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/chat?lang=en&entry=guest-preview");
  await dismissOnboardingIfPresent(page);

  await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
  await chatComposerLocators(page).modelSelect.click();
  await expect(page.getByRole("dialog", { name: "Choose AI models" })).toBeVisible();
});

test("STG-F001: declining analytics from the chat notice hides it and persists the choice", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout-overlap regression is viewport-driven, covered once."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/chat?lang=en&entry=guest-preview");
  await dismissOnboardingIfPresent(page);

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  await notice.getByTestId("analytics-consent-decline").click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("declined");
});

test("STG-F001: accepting analytics from the chat notice hides it and persists the choice", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout-overlap regression is viewport-driven, covered once."
  );

  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/chat?lang=en&entry=guest-preview");
  await dismissOnboardingIfPresent(page);

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  await notice.getByTestId("analytics-consent-accept").click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("accepted");
});
