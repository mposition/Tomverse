import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// FINAL-F001 / FINAL-F004: two narrow-viewport defects on the marketing pages.
//
// F001 -- the analytics consent notice fell through to the viewport-fixed
// corner overlay on marketing routes (only /chat and /auth/signin had in-flow
// slots). At <=360px it landed on the landing hero's primary CTA:
// document.elementFromPoint() at the CTA's centre returned the notice's own
// body copy, so the CTA could not be tapped at all while consent was pending.
// A bottom overlay can't avoid that by shrinking -- at 360x640 the CTA ends
// 16px above the fold, so any bottom-anchored card taller than 16px covers
// it. MarketingChrome now renders MarketingConsentSlot under the sticky
// header and the notice portals there, in normal document flow.
//
// F004 -- the brand was the only shrinkable item in the header row, so the
// language switcher's 10.5rem cap squeezed it until `truncate` rendered
// "Tomverse Review" as "T." at 320px. The brand is now shrink-0 and drops
// the qualifier (never a partial word) below sm, and the switcher absorbs
// the shrink instead.

const MARKETING_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];

const enableAnalyticsCookie = (page: Page) =>
  page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);

const boundingBoxesOverlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

for (const viewport of MARKETING_VIEWPORTS) {
  test(`FINAL-F001: the marketing consent notice never covers the landing hero CTA at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Layout-overlap regression is viewport-driven via explicit setViewportSize, covered once."
    );

    await enableAnalyticsCookie(page);
    await prepareGuestPage(page, "en");
    await page.setViewportSize(viewport);
    await page.goto("/?lang=en");

    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();

    // The heart of the fix: on marketing routes the notice lives inside the
    // in-flow slot, so it reserves real layout space and cannot be painted
    // over page content the way the fixed corner fallback could.
    const placement = await notice.evaluate((el) => ({
      position: getComputedStyle(el).position,
      inMarketingSlot: Boolean(
        el.closest('[data-testid="marketing-consent-slot"]')
      ),
    }));
    expect(placement.inMarketingSlot, "notice renders in the marketing slot").toBe(true);
    expect(placement.position, "notice is not viewport-fixed").not.toBe("fixed");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(
      dimensions.viewport + 1
    );

    const cta = page.locator("#landing-hero-primary");
    await expect(cta).toBeVisible();

    const noticeBox = await notice.boundingBox();
    const ctaBox = await cta.boundingBox();
    expect(noticeBox, "notice bounding box").not.toBeNull();
    expect(ctaBox, "hero CTA bounding box").not.toBeNull();
    if (!noticeBox || !ctaBox) return;
    expect(
      boundingBoxesOverlap(noticeBox, ctaBox),
      "consent notice must not overlap the hero CTA"
    ).toBe(false);

    // The notice adds height above the hero, so on short viewports the CTA
    // starts below the fold. What matters is that scrolling to it makes it
    // genuinely tappable -- the check that failed before the fix.
    await cta.scrollIntoViewIfNeeded();
    const hitsItself = await cta.evaluate((el) => {
      const rect = el.getClientRects()[0] || el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2
      );
      return hit !== null && el.contains(hit);
    });
    expect(hitsItself, "hero CTA centre hit-tests to itself, not the notice").toBe(true);

    // Both consent actions still meet the 44px WCAG 2.2 target size once the
    // row wraps them onto their own line.
    for (const [name, testId] of [
      ["decline", "analytics-consent-decline"],
      ["accept", "analytics-consent-accept"],
    ] as const) {
      const box = await notice.getByTestId(testId).boundingBox();
      expect(box, `${name} button bounding box`).not.toBeNull();
      if (!box) continue;
      expect(box.height, `${name} button height >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${name} button width >= 44px`).toBeGreaterThanOrEqual(44);
    }

    // The copy keeps a readable measure instead of being crushed into the
    // sliver the action pair used to leave behind (the audit measured 34.6px
    // of body width at 320px).
    //
    // The floor is 130px rather than the earlier 160px, and deliberately so:
    // 160px at 320px was only reachable by wrapping the two actions onto a
    // row of their own, which costs ~44px and put the phone notice at 102px
    // against its 80px height contract. The notice now keeps copy and actions
    // on one row with compact action labels, which measures ~141px of copy at
    // 320px -- narrower, but set at 11px instead of 10px and inside a notice
    // that is 78px tall instead of 102px. Anything under 130px would mean the
    // actions had grown back into the sentence's space.
    const bodyWidth = await notice
      .locator("p")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(bodyWidth, "consent body copy keeps a readable measure").toBeGreaterThan(130);

    // The height contract the audit set for phones: a notice that eats more
    // than 80px of a 568px-tall screen is competing with the page it sits on.
    const heightBox = await notice.boundingBox();
    expect(heightBox, "notice bounding box").not.toBeNull();
    if (heightBox && viewport.width < 768) {
      expect(heightBox.height, "phone notice stays within 80px").toBeLessThanOrEqual(80);
    }
  });
}

test("FINAL-F001: resolving consent leaves the marketing slot with no layout cost", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Layout regression is viewport-driven via explicit setViewportSize, covered once."
  );

  await enableAnalyticsCookie(page);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/?lang=en");

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();

  await notice.getByTestId("analytics-consent-accept").click();
  await expect(notice).toBeHidden();

  // The slot is `empty:hidden`, so an accepted/declined state must cost no
  // layout box at all -- otherwise the fix would trade an overlap for a
  // permanent gap under the header.
  const slotHeight = await page
    .getByTestId("marketing-consent-slot")
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(slotHeight, "resolved consent leaves no reserved space").toBe(0);
});

for (const viewport of MARKETING_VIEWPORTS) {
  test(`FINAL-F004: the marketing header brand stays a whole word at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Layout regression is viewport-driven via explicit setViewportSize, covered once."
    );

    await enableAnalyticsCookie(page);
    await prepareGuestPage(page, "en");
    await page.setViewportSize(viewport);
    await page.goto("/?lang=en");

    const brand = page.getByTestId("marketing-brand-name");
    await expect(brand).toBeVisible();

    const measured = await brand.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      // innerText reflects what is actually rendered, so the display:none
      // sibling variant does not count.
      visibleText: (el as HTMLElement).innerText.trim(),
    }));

    expect(
      measured.scrollWidth,
      "brand text is not clipped by its own box"
    ).toBeLessThanOrEqual(measured.clientWidth + 1);
    expect(
      ["Tomverse", "Tomverse Review"],
      "brand renders a whole word, never a truncated fragment"
    ).toContain(measured.visibleText);

    // The header must absorb the shrink somewhere other than the brand.
    const header = await page.locator("header").first().evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      header.scrollWidth,
      "header row does not overflow horizontally"
    ).toBeLessThanOrEqual(header.clientWidth + 1);

    // The logo is decorative next to the visible wordmark, so the link's
    // accessible name should be exactly that word -- not doubled up.
    const accessibleName = await page
      .locator('header a[href="/"]')
      .first()
      .evaluate((el) => (el as HTMLElement).innerText.trim());
    expect(accessibleName).toBe(measured.visibleText);
  });
}
