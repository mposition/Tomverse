import { expect, test, type Locator, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// UI-P1-02: the analytics consent notice used to render as a viewport-fixed
// bar spanning the bottom of the screen (components/analytics/AnalyticsProvider.tsx),
// which could cross over the sign-in card's OAuth buttons, email input, or
// terms/privacy links on short viewports. The sign-in page now registers its
// own in-flow slot right after the card
// (app/(application)/auth/signin/page.tsx), so the notice portals there
// instead of floating fixed -- it can only ever push page content, never
// cover it, and a tall page simply scrolls.

const enableAnalyticsCookie = (page: Page) =>
  page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);

const signinControls = (page: Page) => ({
  google: page.locator("button", { hasText: "Continue with Google" }),
  microsoft: page.locator("button", { hasText: "Continue with Microsoft" }),
  email: page.getByPlaceholder("you@example.com"),
  sendCode: page.locator("button", { hasText: "Get login code" }),
});

const boundingBoxesOverlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

const assertNoOverlapWithNotice = async (
  name: string,
  locator: Locator,
  noticeBox: { x: number; y: number; width: number; height: number }
) => {
  await expect(locator, `${name} visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} bounding box`).not.toBeNull();
  if (!box) return;
  expect(
    boundingBoxesOverlap(box, noticeBox),
    `${name} must not overlap the consent notice`
  ).toBe(false);
};

const SIGNIN_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

for (const viewport of SIGNIN_VIEWPORTS) {
  test(`UI-P1-02: analytics consent notice never overlaps the sign-in card at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Layout-overlap regression is viewport-driven via explicit setViewportSize, covered once."
    );

    await enableAnalyticsCookie(page);
    await prepareGuestPage(page, "en");
    await page.setViewportSize(viewport);
    await page.goto("/auth/signin?lang=en");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(
      dimensions.viewport + 1
    );

    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    // On short viewports the notice can sit below the fold; scroll to it so
    // its bounding box (and any control it might overlap) reflects what a
    // real user would see together on screen, not an off-screen guess.
    await notice.scrollIntoViewIfNeeded();
    const noticeBox = await notice.boundingBox();
    expect(noticeBox).not.toBeNull();
    if (!noticeBox) return;

    const controls = signinControls(page);
    for (const [name, locator] of Object.entries(controls)) {
      await assertNoOverlapWithNotice(name, locator, noticeBox);
    }

    // exact: true keeps these scoped to the sign-in card's own "Terms and
    // Conditions" / "Privacy Policy" links -- Playwright's default
    // case-insensitive substring match would otherwise also pick up the
    // consent notice's own "Privacy policy" link, which trivially "overlaps"
    // itself and isn't the thing under test here.
    const termsLinks = await page
      .getByRole("link", { name: "Terms and Conditions", exact: true })
      .all();
    const privacyLinks = await page
      .getByRole("link", { name: "Privacy Policy", exact: true })
      .all();
    expect(termsLinks.length).toBeGreaterThan(0);
    expect(privacyLinks.length).toBeGreaterThan(0);
    for (const [index, link] of termsLinks.entries()) {
      await assertNoOverlapWithNotice(`terms link #${index}`, link, noticeBox);
    }
    for (const [index, link] of privacyLinks.entries()) {
      await assertNoOverlapWithNotice(`privacy link #${index}`, link, noticeBox);
    }

    const declineButton = notice.getByTestId("analytics-consent-decline");
    const acceptButton = notice.getByTestId("analytics-consent-accept");
    await expect(declineButton).toBeVisible();
    await expect(acceptButton).toBeVisible();
    const [declineBox, acceptBox] = await Promise.all([
      declineButton.boundingBox(),
      acceptButton.boundingBox(),
    ]);
    expect(declineBox, "decline button bounding box").not.toBeNull();
    expect(acceptBox, "accept button bounding box").not.toBeNull();
    if (declineBox) expect(declineBox.height).toBeGreaterThanOrEqual(44);
    if (acceptBox) expect(acceptBox.height).toBeGreaterThanOrEqual(44);

    await expect(notice.getByRole("link", { name: "Privacy policy" })).toBeVisible();
  });
}

test("UI-P1-02: declining analytics from the sign-in notice hides it and persists the choice", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout-overlap regression is viewport-driven, covered once."
  );

  await enableAnalyticsCookie(page);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/auth/signin?lang=en");

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  await notice.getByTestId("analytics-consent-decline").click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("declined");

  // Declining must not affect the sign-in card itself.
  const controls = signinControls(page);
  for (const locator of Object.values(controls)) {
    await expect(locator).toBeVisible();
  }
});

test("UI-P1-02: accepting analytics from the sign-in notice hides it and persists the choice", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout-overlap regression is viewport-driven, covered once."
  );

  await enableAnalyticsCookie(page);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/auth/signin?lang=en");

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
