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

test("mobile analytics settings shortcut hides while the chat keyboard is active", async ({
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
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
    window.sessionStorage.removeItem("tomverse_guest_quick_start_active_v2");
  });
  await page.goto("/chat");

  const settings = page.getByTestId("analytics-settings-button");
  await expect(settings).toBeVisible();

  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill("Keyboard overlap regression");
  await expect(settings).toBeHidden();
  await expect(page.getByTestId("chat-send-button")).toBeVisible();

  await textarea.evaluate((element) => element.blur());
  await expect(settings).toBeVisible();
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

  await expect(page.getByTestId("analytics-settings-button")).toHaveCount(0);
  await page.getByTestId("account-menu-trigger").click();
  const analyticsSettings = page.getByTestId("account-analytics-settings");
  await expect(analyticsSettings).toBeVisible();
  await analyticsSettings.click();
  await expect(
    page.getByRole("region", { name: "Privacy-safe product analytics" })
  ).toBeVisible();
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
