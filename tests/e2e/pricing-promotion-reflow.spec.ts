import { expect, test, type Page } from "@playwright/test";
import { mockPublicProofMetrics, prepareGuestPage } from "./support/app-fixtures";

/**
 * VAL-002. The audit reported that `/pricing` overflows horizontally at small
 * widths under zoom *while a promotion is active*, and both re-audits recorded
 * "could not reproduce" -- because no promotion was active in the runtime they
 * measured. "The state did not exist" is not an answer, so this pins the state
 * down: `featuredPromotion` comes only from `/api/billing/config`, which is
 * mockable, and each case measures the same page twice with only that field
 * changed.
 *
 * What this suite asserts is the attribution, because that is the open
 * question: **the promotion must not make the page any wider than it already
 * is.** The absolute overflow is logged alongside it.
 *
 * Result at the time of writing (see .github/audits/ui-insight-followup.md):
 *
 * - The promotion never adds a single pixel of overflow. Every combination
 *   measures identically with the banner and without it.
 * - `/pricing` *does* overflow at 320px from 125% zoom (en) and 200% (ko), and
 *   at 390px from 150% (en) / 200% (ko) -- with or without a promotion. The
 *   offending element is a plan `<article>` whose minimum width exceeds the
 *   column. That is a real finding, but a different one from UI-005 and
 *   outside this work order's approved scope, so it is reported rather than
 *   fixed here.
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
      test(`an active promotion adds no pricing overflow at ${label}`, async ({ page }) => {
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
