import { expect, test, type Page } from "@playwright/test";
import { mockPublicProofMetrics, prepareGuestPage } from "./support/app-fixtures";

/**
 * UI-005 (Revise) / VAL-002. `/pricing` overflowed horizontally at narrow
 * widths under zoom. The audit attributed it to an active promotion; measuring
 * the same combination with the banner and without it showed the promotion
 * contributes exactly 0px, so the diagnosis was wrong while the defect was
 * real. The cause was the plan card's intrinsic width:
 *
 * - the card is a grid item, so `min-width: auto` kept it at its 287px
 *   min-content inside a 224px track;
 * - its eyebrow/badge row could not wrap, so the pair set that min-content;
 * - the price and its period label shared one inline line;
 * - each feature bullet was an icon plus a bare text node, so the row's
 *   minimum was the icon plus the longest word;
 * - and the display headings had no overflow escape hatch in English.
 *
 * All five are fixed at the source rather than clipped. This suite asserts two
 * separate things, both able to fail:
 *
 * 1. **Absolute**: every one of the 16 viewport x zoom x language combinations
 *    stays within 1px of its own client width, with the promotion active and
 *    with it inactive -- 32 measurements.
 * 2. **Attribution**: the promotion never widens the page relative to the same
 *    combination without it, so a future promotion layout cannot reintroduce
 *    UI-005 unnoticed.
 *
 * Browser zoom is emulated by shrinking the viewport, matching
 * ui-zoom-reflow.spec.ts: that is what zoom does -- it changes how many CSS
 * pixels the viewport holds, not how big a CSS pixel is.
 */

const BASE_VIEWPORTS = [
  { name: "320", width: 320, height: 568 },
  { name: "390", width: 390, height: 844 },
] as const;

const ZOOM_LEVELS = [1, 1.25, 1.5, 2] as const;

const PROMOTION_CODE = "TOMVERSE-LAUNCH-50";

async function mockBilling(page: Page, promotion: boolean) {
  await page.context().route("**/api/billing/config**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plans: [
          { id: "free", name: "Free", monthlyCredits: 300, priceCents: 0, currency: "USD", interval: "month" },
          { id: "pro", name: "Pro", monthlyCredits: 6000, priceCents: 1900, currency: "USD", interval: "month" },
          { id: "max", name: "Max", monthlyCredits: 20000, priceCents: 4900, currency: "USD", interval: "month" },
        ],
        creditPacks: [],
        featuredPromotion: promotion
          ? {
              code: PROMOTION_CODE,
              discountPercent: 50,
              discountAmountCents: null,
              durationMonths: 1,
              appliesToPlanIds: ["pro", "max"],
              billingIntervals: ["month"],
              endsAt: "2099-03-01T00:00:00.000Z",
            }
          : null,
        promotionPolicy: {
          codesListed: true,
          validation: "server_only",
          annualDiscountStacking: "promotion_specific_default_denied",
        },
      }),
    })
  );
}

type OverflowReading = {
  overflowPx: number;
  offender: { selector: string; right: number } | null;
};

async function measurePricingOverflow(
  page: Page,
  options: { promotion: boolean; lang: "ko" | "en"; width: number; height: number }
): Promise<OverflowReading> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await prepareGuestPage(page, options.lang);
  // Registered after prepareGuestPage so it wins: Playwright routes are
  // last-registered-first, and the guest fixture installs a promotion-free
  // config of its own.
  await mockBilling(page, options.promotion);
  await mockPublicProofMetrics(page);
  await page.goto(`/pricing?lang=${options.lang}`);

  // Fail here rather than measuring a page that quietly rendered the other
  // layout -- the promotion state is the independent variable.
  const banner = page.getByText(PROMOTION_CODE);
  if (options.promotion) {
    await expect(banner).toBeVisible();
  } else {
    await expect(banner).toHaveCount(0);
  }

  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflowPx = Math.max(0, doc.scrollWidth - doc.clientWidth);
    if (overflowPx <= 1) return { overflowPx: 0, offender: null };

    // A wide element inside its own horizontal scroller (the plan comparison
    // table) is a design choice, not page overflow -- it cannot push the
    // document, so naming it would send a reader after the wrong element.
    const isInsideOwnScroller = (element: Element) => {
      for (
        let node: Element | null = element.parentElement;
        node && node !== doc;
        node = node.parentElement
      ) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
          return true;
        }
      }
      return false;
    };

    let offender: { selector: string; right: number } | null = null;
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= doc.clientWidth + 1) continue;
      if (isInsideOwnScroller(element)) continue;
      if (!offender || rect.right > offender.right) {
        const testId = element.getAttribute("data-testid");
        offender = {
          selector:
            testId ??
            `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "")
              .split(/\s+/)
              .slice(0, 3)
              .join(".")}`,
          right: Math.round(rect.right),
        };
      }
    }
    return { overflowPx, offender };
  });
}

for (const base of BASE_VIEWPORTS) {
  for (const zoom of ZOOM_LEVELS) {
    for (const lang of ["ko", "en"] as const) {
      const label = `${base.name} @${zoom * 100}% (${lang})`;
      test(`pricing reflows without overflow at ${label}`, { tag: "@ui-risk" }, async ({ page }) => {
        const viewport = {
          width: Math.round(base.width / zoom),
          height: Math.round(base.height / zoom),
        };

        const withPromotion = await measurePricingOverflow(page, {
          promotion: true,
          lang,
          ...viewport,
        });
        const withoutPromotion = await measurePricingOverflow(page, {
          promotion: false,
          lang,
          ...viewport,
        });

        console.log(
          `VAL-002 ${label} promotion=${withPromotion.overflowPx}px baseline=${
            withoutPromotion.overflowPx
          }px offender=${JSON.stringify(
            withPromotion.offender ?? withoutPromotion.offender
          )}`
        );

        // 1. Absolute: the page fits, in both promotion states.
        expect(
          withoutPromotion.overflowPx,
          `horizontal overflow with no promotion: ${JSON.stringify(withoutPromotion)}`
        ).toBeLessThanOrEqual(1);
        expect(
          withPromotion.overflowPx,
          `horizontal overflow with an active promotion: ${JSON.stringify(withPromotion)}`
        ).toBeLessThanOrEqual(1);

        // 2. Attribution: the banner is not what widens it, whatever happens
        //    to the absolute number later.
        expect(
          withPromotion.overflowPx,
          `the promotion banner widened the page: ${JSON.stringify(
            withPromotion
          )} vs ${JSON.stringify(withoutPromotion)}`
        ).toBeLessThanOrEqual(withoutPromotion.overflowPx + 1);
      });
    }
  }
}
