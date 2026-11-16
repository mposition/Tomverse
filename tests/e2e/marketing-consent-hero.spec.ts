import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// FINAL-F001 (revised 2026-11-16) / FINAL-F004: narrow-viewport contracts on
// the marketing pages.
//
// F001 -- the analytics consent notice is a slim bar fixed to the bottom of
// the viewport (owner decision 2026-11-16; it used to be a card under the
// header that pushed every first-visit hero ~180px down). A bottom bar can sit
// over the hero CTA on a short phone, so the page reserves the bar's height as
// bottom padding: scrolling always brings the CTA clear of the bar. On a phone
// it is at most two rows (sentence, then actions), about half the old card. The bar's
// X hides it for the rest of the session without recording a choice.
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
  { width: 1440, height: 900 },
];

const enableAnalyticsCookie = (page: Page) =>
  page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);

for (const viewport of MARKETING_VIEWPORTS) {
  test(`FINAL-F001: the consent bar is fixed to the bottom and never traps the hero CTA at ${viewport.width}x${viewport.height}`, async ({
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

    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    await expect(page.getByTestId("marketing-consent-slot")).toHaveCount(0);

    const placement = await notice.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        position: getComputedStyle(el).position,
        left: rect.left,
        width: rect.width,
        bottomGap: innerHeight - rect.bottom,
        height: rect.height,
        viewport: document.documentElement.clientWidth,
        bodyPadding: Number.parseFloat(getComputedStyle(document.body).paddingBottom),
      };
    });
    expect(placement.position).toBe("fixed");
    expect(placement.left).toBe(0);
    expect(Math.abs(placement.width - placement.viewport)).toBeLessThanOrEqual(1);
    expect(Math.abs(placement.bottomGap)).toBeLessThanOrEqual(1);
    expect(placement.height, "the bar stays small").toBeLessThanOrEqual(viewport.width < 768 ? 112 : 64);
    expect(Math.abs(placement.bodyPadding - placement.height), "page reserves the bar height").toBeLessThanOrEqual(1);

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, "no horizontal page overflow").toBeLessThanOrEqual(dimensions.viewport + 1);

    for (const testId of ["analytics-consent-decline", "analytics-consent-accept", "analytics-consent-dismiss"]) {
      const box = await notice.getByTestId(testId).boundingBox();
      expect(box, `${testId} bounding box`).not.toBeNull();
      if (!box) continue;
      expect(box.height, `${testId} height >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${testId} width >= 44px`).toBeGreaterThanOrEqual(44);
    }
    expect(
      await notice.getByRole("link").evaluate((el) => el.getClientRects().length),
      "privacy link stays on one line"
    ).toBe(1);

    const cta = page.locator("#landing-hero-primary");
    await cta.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    const hitsItself = await cta.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(hitsItself, "hero CTA centre hit-tests to itself, not the bar").toBe(true);
  });
}

test("FINAL-F001: the bar's X hides it for the session without recording a choice", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Behaviour check, covered once."
  );

  await enableAnalyticsCookie(page);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/?lang=en");

  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible();
  await notice.getByTestId("analytics-consent-dismiss").click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)).toBe("0px");
  expect(await page.evaluate(() => localStorage.getItem("tomverse_analytics_consent_v1"))).toBeNull();

  await page.reload();
  await expect(page.locator("#landing-hero-primary")).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(notice).toHaveCount(0);
});

test("FINAL-F001: resolving consent removes the bar and its reserved space", async ({
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
  expect(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)).toBe("0px");
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
