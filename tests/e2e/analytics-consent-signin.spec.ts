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

// Overlap alone can pass while the element is still practically unusable
// (e.g. a transparent or lower-z-index notice sitting on top). Center-point
// hit-testing confirms the control is what a real tap would actually land
// on -- the exact check STG-F001 already uses for the chat composer.
const assertNoOverlapWithNotice = async (
  name: string,
  locator: Locator,
  noticeBox: { x: number; y: number; width: number; height: number }
) => {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${name} visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} bounding box`).not.toBeNull();
  if (!box) return;
  expect(
    boundingBoxesOverlap(box, noticeBox),
    `${name} must not overlap the consent notice`
  ).toBe(false);

  // Hit-test the center of the element's own first line fragment rather than
  // the overall bounding box: an inline link that wraps across two lines
  // (e.g. "Terms and Conditions" breaking mid-phrase in the narrow card) has
  // a bounding box whose geometric center can fall in the gap between the
  // lines, which is not a real overlap -- it's just how union rects work for
  // wrapped inline content.
  const hitsItself = await locator.evaluate((el) => {
    const rect = el.getClientRects()[0] || el.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return hit !== null && el.contains(hit);
  });
  expect(hitsItself, `${name} center hit-tests to itself, not the notice`).toBe(true);
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
    if (declineBox) {
      expect(declineBox.height, "decline button height >= 44px").toBeGreaterThanOrEqual(44);
      expect(declineBox.width, "decline button width >= 44px").toBeGreaterThanOrEqual(44);
    }
    if (acceptBox) {
      expect(acceptBox.height, "accept button height >= 44px").toBeGreaterThanOrEqual(44);
      expect(acceptBox.width, "accept button width >= 44px").toBeGreaterThanOrEqual(44);
    }

    await expect(notice.getByRole("link", { name: "Privacy policy" })).toBeVisible();
  });
}

test("UI-P1-02: sign-in inputs and primary CTA stay reachable while the email field is focused (virtual-keyboard proxy)", async ({
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

  // A real mobile OS keyboard shrinks the visual viewport; headless Chromium
  // can't emulate that, but the notice being non-fixed (plain document flow)
  // means there is nothing that could newly slide over the input or the
  // send-code button once focused -- this proves that invariant holds.
  const email = page.getByPlaceholder("you@example.com");
  await email.click();
  await email.fill("keyboard-check@example.com");
  await expect(email).toBeFocused();

  const sendCode = page.locator("button", { hasText: "Get login code" });
  await expect(sendCode).toBeVisible();
  await expect(sendCode).toBeEnabled();
  const noticeBox = await notice.boundingBox();
  const sendCodeBox = await sendCode.boundingBox();
  expect(noticeBox, "notice bounding box").not.toBeNull();
  expect(sendCodeBox, "send-code bounding box").not.toBeNull();
  if (noticeBox && sendCodeBox) {
    expect(
      boundingBoxesOverlap(sendCodeBox, noticeBox),
      "send-code button must not be covered while the email field is focused"
    ).toBe(false);
  }
});

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
  const cardBefore = await page.getByTestId("signin-card").boundingBox();
  await notice.getByTestId("analytics-consent-accept").click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("tomverse_analytics_consent_v1"))
    )
    .toBe("accepted");

  // UI-P2-01: answering must leave no reserved gap behind. The slot is
  // `empty:hidden`, so once the notice unmounts it costs no box and no flex
  // gap -- the card is the last thing on the page again.
  const layout = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="signin-card"]')
      ?.parentElement?.lastElementChild as HTMLElement | null;
    const card = document.querySelector('[data-testid="signin-card"]')!;
    const cardRect = card.getBoundingClientRect();
    return {
      slotDisplay: slot ? getComputedStyle(slot).display : null,
      slotHeight: slot ? slot.getBoundingClientRect().height : null,
      cardBottom: cardRect.bottom,
      pageBottomGap:
        document.documentElement.scrollHeight - (cardRect.bottom + window.scrollY),
    };
  });
  expect(layout.slotDisplay, "resolved consent slot is display:none").toBe("none");
  expect(layout.slotHeight, "resolved consent slot has no height").toBe(0);
  // Only the page's own bottom padding may remain under the card
  // (pb-[max(2rem,safe-area)] = 32px), never a notice-sized hole.
  expect(layout.pageBottomGap, "no empty spacer under the card").toBeLessThanOrEqual(40);
  const cardAfter = await page.getByTestId("signin-card").boundingBox();
  expect(cardBefore, "card box before").not.toBeNull();
  expect(cardAfter, "card box after").not.toBeNull();
  if (cardBefore && cardAfter) {
    expect(cardAfter.height, "card itself is unchanged").toBeCloseTo(
      cardBefore.height,
      0
    );
  }
});

// ---------------------------------------------------------------------------
// UI-P2-01: containment inside the login card.
//
// UI-P1-02 moved the notice into the sign-in card's own in-flow slot, but the
// notice kept sizing itself off the *viewport*: `sm:flex-nowrap` plus
// `shrink-0` actions applied at >=640px of viewport even though the slot there
// is a max-w-sm card with 360px of content box. At 1440x900 in English, with
// the notice-and-opt-out copy ("Turn off analytics" / "Keep analytics on"),
// the action pair was laid out at full length on one unwrappable row and ran
// 45.4px past the card's right edge (75.9px measured against the notice's
// padding box in the audit). The notice now keys every layout decision off its
// container (@container/notice), so the same markup is correct in a 360px card
// and in the full-width marketing header alike.
// ---------------------------------------------------------------------------

/** Longest action labels ship with notice_opt_out, which needs a country header. */
const CONSENT_MODES = [
  { mode: "opt_in", country: "GB" },
  { mode: "notice_opt_out", country: "AU" },
] as const;

const CONTAINMENT_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

/** Phones may not spend more than this much height on the notice. */
const PHONE_NOTICE_MAX_HEIGHT = 80;

const measureNotice = (notice: Locator) =>
  notice.evaluate((element) => {
    const noticeRect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inner = {
      left: noticeRect.left + Number.parseFloat(style.paddingLeft || "0"),
      right: noticeRect.right - Number.parseFloat(style.paddingRight || "0"),
    };
    let worstOverflow = 0;
    let worstSelector = "";
    for (const child of Array.from(element.querySelectorAll("*"))) {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const overflow = Math.max(rect.right - inner.right, inner.left - rect.left);
      if (overflow > worstOverflow) {
        worstOverflow = overflow;
        worstSelector = `${child.tagName.toLowerCase()}${
          child.getAttribute("data-testid")
            ? `[${child.getAttribute("data-testid")}]`
            : ""
        }`;
      }
    }
    return {
      height: noticeRect.height,
      width: noticeRect.width,
      scrollOverflow: element.scrollWidth - element.clientWidth,
      worstOverflow: Number(worstOverflow.toFixed(2)),
      worstSelector,
    };
  });

for (const { mode, country } of CONSENT_MODES) {
  for (const lang of ["en", "ko"] as const) {
    for (const viewport of CONTAINMENT_VIEWPORTS) {
      test(`UI-P2-01: consent notice stays inside the login card (${mode}, ${lang}, ${viewport.width}x${viewport.height})`, async ({
        page,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop-chromium",
          "Containment is viewport-driven via explicit setViewportSize, covered once."
        );

        await enableAnalyticsCookie(page);
        await prepareGuestPage(page, lang);
        // The sign-in page resolves the consent mode on the server from the
        // edge country header (app/(application)/layout.tsx), so the
        // long-label notice_opt_out copy is reached by asking as that region
        // rather than by mocking the client-side policy endpoint.
        await page.setExtraHTTPHeaders({ "cf-ipcountry": country });
        await page.setViewportSize(viewport);
        await page.goto(`/auth/signin?lang=${lang}`);

        const notice = page.getByTestId("chat-consent-notice");
        await expect(notice).toBeVisible();
        await notice.scrollIntoViewIfNeeded();

        const metrics = await measureNotice(notice);
        expect(
          metrics.worstOverflow,
          `nothing may spill out of the notice (worst: ${metrics.worstSelector})`
        ).toBeLessThanOrEqual(0.5);
        expect(metrics.scrollOverflow, "notice never scrolls sideways").toBeLessThanOrEqual(1);

        // The card is the max-w-sm login container: 384px, and the notice may
        // not exceed it at any viewport.
        expect(metrics.width, "notice fits the login container").toBeLessThanOrEqual(384);

        const dimensions = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
        }));
        expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(
          dimensions.viewport + 1
        );

        if (viewport.width < 768) {
          expect(
            metrics.height,
            "phone notice stays within its height contract"
          ).toBeLessThanOrEqual(PHONE_NOTICE_MAX_HEIGHT);
        }

        for (const testId of [
          "analytics-consent-decline",
          "analytics-consent-accept",
        ] as const) {
          const box = await notice.getByTestId(testId).boundingBox();
          expect(box, `${testId} bounding box`).not.toBeNull();
          if (!box) continue;
          expect(box.width, `${testId} width >= 44px`).toBeGreaterThanOrEqual(44);
          expect(box.height, `${testId} height >= 44px`).toBeGreaterThanOrEqual(44);
        }

        // The visible labels shorten in a narrow container; the accessible
        // names must not, or a voice-control user loses the command they were
        // told to say (and every role/name query in this suite would drift).
        const expectedNames =
          mode === "opt_in"
            ? lang === "en"
              ? ["Decline", "Allow analytics"]
              : ["거부", "분석 허용"]
            : lang === "en"
              ? ["Turn off analytics", "Keep analytics on"]
              : ["분석 끄기", "분석 유지"];
        for (const [index, testId] of [
          "analytics-consent-decline",
          "analytics-consent-accept",
        ].entries()) {
          await expect(notice.getByTestId(testId)).toHaveAccessibleName(
            expectedNames[index]
          );
          // WCAG 2.5.3: whatever is painted on the control has to be part of
          // that accessible name.
          const visibleLabel = (
            await notice.getByTestId(testId).innerText()
          ).trim();
          expect(
            expectedNames[index].toLowerCase(),
            `visible "${visibleLabel}" is contained in the accessible name`
          ).toContain(visibleLabel.toLowerCase());
        }

        await expect(notice.getByRole("link")).toBeVisible();
      });
    }
  }
}
