import { expect, test, type Locator, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { intersectionArea, openOnScreenKeyboard } from "./support/ui-audit";

/**
 * UI-P1-04. On /auth/signin the analytics surface and the account CTAs were
 * competing for the same pixels once the consent choice was settled. The
 * consent *notice* had already been moved into normal document flow
 * (UI-P1-02), but the "Analytics settings" pill that replaces it afterwards
 * stayed a viewport-fixed overlay in the bottom-right corner -- which on a
 * phone is exactly where the centred login card's OAuth buttons and legal
 * links are. Re-audits measured 628px^2 over Google, 1142px^2 over Microsoft,
 * and 9-22% of the CTA hit-test grid going to the pill instead of the button
 * under it. The overlap moved between locales and browser builds, which is the
 * signature of an overlay that happens to land somewhere, not of a layout.
 *
 * The pill now portals into the same in-flow slot the notice uses, so this
 * suite asserts the property rather than a measurement: across the full
 * 3 widths x 2 languages x 3 consent states matrix, whatever analytics surface
 * is on screen shares no area with any account CTA or legal link, and every
 * point of every CTA belongs to that CTA.
 */

test.use({ hasTouch: true });

/**
 * Heights are part of the reproduction, not decoration. The pill was anchored
 * to the *viewport's* bottom-right, so whether it landed on a CTA depended on
 * how much of the centred login card was on screen. Probing this build with
 * the pill still fixed:
 *
 *   320x568 en  -> 3864px^2 over Google
 *   320x640 en  -> 4048px^2 over Microsoft
 *   320x568 ko  -> 1120px^2 over Microsoft
 *   360x568 en  -> 2208px^2 over Microsoft
 *   390x568 en  ->  368px^2 over Microsoft
 *   320x844 any ->    0     (which is why a tall-viewport-only matrix passed
 *                            against the defect, and why the earlier audits
 *                            disagreed with each other about the numbers)
 *
 * Each width below is therefore paired with a height that reproduced, so the
 * suite fails if the pill is ever put back on a viewport-fixed layer.
 */
const WIDTHS = [
  { width: 320, height: 568 },
  { width: 360, height: 568 },
  { width: 390, height: 568 },
] as const;
const LANGUAGES = ["ko", "en"] as const;
const CONSENT_STATES = ["unset", "accepted", "declined"] as const;

const MIN_TARGET = 44;
const TOLERANCE = 0.5;

type ConsentState = (typeof CONSENT_STATES)[number];

async function openSignIn(
  page: Page,
  options: { lang: "ko" | "en"; consent: ConsentState; width: number; height?: number }
) {
  await page.setViewportSize({ width: options.width, height: options.height ?? 844 });
  await page.context().addCookies([
    { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
  ]);
  await prepareGuestPage(page, options.lang);
  await page.addInitScript((value) => {
    if (value === "unset") {
      window.localStorage.removeItem("tomverse_analytics_consent_v1");
      return;
    }
    window.localStorage.setItem("tomverse_analytics_consent_v1", value as string);
  }, options.consent);
  await page.route("**/api/analytics/events", (route) =>
    route.fulfill({ status: 202, body: "" })
  );
  await page.goto(`/auth/signin?lang=${options.lang}`);
  await expect(page.getByTestId("signin-card")).toBeVisible();
}

/**
 * The analytics surface on screen for the current consent state: the notice
 * while the choice is open, the settings pill once it is settled. Returning
 * whichever is present is deliberate -- the property under test is "the
 * analytics UI never covers an account CTA", and a test that only knew about
 * one of the two would pass in the state it does not cover.
 */
async function analyticsSurface(page: Page): Promise<Locator> {
  const settings = page.getByTestId("analytics-settings-button");
  const notice = page.getByTestId("chat-consent-notice");
  await expect
    .poll(
      async () => (await settings.count()) + (await notice.count()),
      { message: "no analytics surface rendered in this consent state" }
    )
    .toBeGreaterThan(0);
  return (await settings.count()) > 0 ? settings : notice;
}

const accountTargets = (page: Page) => [
  { name: "google", locator: page.getByRole("button", { name: /google/i }) },
  { name: "microsoft", locator: page.getByRole("button", { name: /microsoft/i }) },
  { name: "terms", locator: page.locator('a[href="/terms"]') },
  { name: "privacy", locator: page.locator('a[href="/privacy"]').first() },
];

/**
 * A 9x5 grid over the target's own surface. A single centre probe cannot see
 * an overlay that covers a corner, which is exactly how the pill sat over the
 * OAuth buttons.
 */
async function expectGridHitTest(target: Locator, label: string) {
  // `document.elementFromPoint` only answers for the visible viewport, so a
  // control below the fold has to be scrolled to first -- otherwise every
  // probe returns null and the assertion fails for a reason that has nothing
  // to do with what is on top of what. Scrolling is also the honest way to
  // test a *fixed* overlay: the pill stays pinned to the viewport corner
  // while the button comes to meet it.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const misses = await target.evaluate(
    (element, rect: { x: number; y: number; width: number; height: number }) => {
      const failures: string[] = [];
      for (let column = 0; column < 9; column += 1) {
        for (let row = 0; row < 5; row += 1) {
          // Inset by half a cell so the probes sample the target's surface
          // rather than its border pixels.
          const x = rect.x + ((column + 0.5) * rect.width) / 9;
          const y = rect.y + ((row + 0.5) * rect.height) / 5;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(element === hit || element.contains(hit))) {
            failures.push(
              `(${column},${row}) -> ${
                hit
                  ? `${hit.tagName.toLowerCase()}${
                      hit.getAttribute("data-testid")
                        ? `[${hit.getAttribute("data-testid")}]`
                        : ""
                    }`
                  : "nothing"
              }`
            );
          }
        }
      }
      return failures;
    },
    box!
  );
  expect(misses, `${label}: ${misses.length}/45 grid points intercepted`).toEqual([]);
}

for (const { width, height } of WIDTHS) {
  for (const lang of LANGUAGES) {
    for (const consent of CONSENT_STATES) {
      const label = `${width}x${height} ${lang} consent=${consent}`;
      test(`sign-in analytics surface never covers an account CTA at ${label}`, {
        tag: "@ui-risk",
      }, async ({ page }) => {
        await openSignIn(page, { lang, consent, width, height });
        const surface = await analyticsSurface(page);
        await expect(surface).toBeVisible();

        for (const target of accountTargets(page)) {
          await expect(target.locator, `${label}: ${target.name} missing`).toBeVisible();
          // Measured with the target on screen, because the pill's rect is
          // viewport-relative: comparing it against a target that is still
          // below the fold would report a 0 that means "not on screen
          // together", not "does not overlap".
          await target.locator.scrollIntoViewIfNeeded();
          const area = await intersectionArea(surface, target.locator);
          expect(
            area,
            `${label}: the analytics surface covered ${area}px^2 of ${target.name}`
          ).toBe(0);
        }

        // Hit-testing only the OAuth buttons: the legal links are inline text
        // whose own line boxes legitimately contain non-link pixels.
        for (const name of ["google", "microsoft"] as const) {
          const target = accountTargets(page).find((entry) => entry.name === name)!;
          await expectGridHitTest(target.locator, `${label}: ${name}`);
        }

        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(1);
      });
    }
  }
}

test("the sign-in analytics settings control is a real touch target in flow", {
  tag: "@ui-risk",
}, async ({ page }) => {
  for (const { width, height } of WIDTHS) {
    for (const lang of LANGUAGES) {
      await openSignIn(page, { lang, consent: "accepted", width, height });
      const settings = page.getByTestId("analytics-settings-button");
      await expect(settings).toBeVisible();
      await settings.scrollIntoViewIfNeeded();
      const box = await settings.boundingBox();
      expect(box, `${width}/${lang}: no box`).not.toBeNull();
      expect(box!.width, `${width}/${lang}: width`).toBeGreaterThanOrEqual(
        MIN_TARGET - TOLERANCE
      );
      expect(box!.height, `${width}/${lang}: height`).toBeGreaterThanOrEqual(
        MIN_TARGET - TOLERANCE
      );
      expect(box!.x, `${width}/${lang}: off the left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(
        box!.x + box!.width,
        `${width}/${lang}: off the right edge`
      ).toBeLessThanOrEqual(width + 0.5);
    }
  }
});

test("resolving the consent choice on sign-in leaves no gap behind", {
  tag: "@ui-risk",
}, async ({ page }) => {
  await openSignIn(page, { lang: "en", consent: "unset", width: 390 });
  const card = page.getByTestId("signin-card");
  const noticeBottom = await page.evaluate(() => {
    const notice = document.querySelector('[data-testid="chat-consent-notice"]');
    return notice ? notice.getBoundingClientRect().height : 0;
  });
  expect(noticeBottom, "the consent notice should occupy real space").toBeGreaterThan(0);

  await page.getByTestId("analytics-consent-accept").click();
  await expect(page.getByTestId("chat-consent-notice")).toHaveCount(0);
  const settings = page.getByTestId("analytics-settings-button");
  await expect(settings).toBeVisible();

  // The slot is `empty:hidden`, so the space the notice held is either taken
  // by the settings control or given back -- never left as a blank band.
  const gap = await page.evaluate(() => {
    const cardRect = document
      .querySelector('[data-testid="signin-card"]')!
      .getBoundingClientRect();
    const control = document
      .querySelector('[data-testid="analytics-settings-button"]')!
      .getBoundingClientRect();
    return Math.round(control.top - cardRect.bottom);
  });
  expect(await card.isVisible()).toBe(true);
  // One flex `gap-3` (12px) between the card and the slot, nothing more.
  expect(gap, `dead space between the card and the settings control: ${gap}px`).toBeLessThanOrEqual(
    16
  );
  expect(gap).toBeGreaterThanOrEqual(0);
});

test("the sign-in analytics control stays clear of the CTAs with a keyboard open", {
  tag: "@ui-risk",
}, async ({ page }) => {
  await openSignIn(page, { lang: "ko", consent: "accepted", width: 320, height: 568 });
  await openOnScreenKeyboard(page);
  const settings = page.getByTestId("analytics-settings-button");
  await expect(settings).toBeVisible();
  for (const target of accountTargets(page)) {
    await target.locator.scrollIntoViewIfNeeded();
    const area = await intersectionArea(settings, target.locator);
    expect(area, `keyboard open: covered ${area}px^2 of ${target.name}`).toBe(0);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const theme of ["light", "dark"] as const) {
  for (const zoom of [1, 2] as const) {
    test(`sign-in analytics placement holds in ${theme} at ${zoom * 100}% zoom`, {
      tag: "@ui-risk",
    }, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openSignIn(page, {
        lang: "ko",
        consent: "declined",
        width: Math.round(320 / zoom),
        height: Math.round(568 / zoom),
      });
      const settings = page.getByTestId("analytics-settings-button");
      await expect(settings).toBeVisible();
      for (const target of accountTargets(page)) {
        await target.locator.scrollIntoViewIfNeeded();
        const area = await intersectionArea(settings, target.locator);
        expect(
          area,
          `${theme}@${zoom * 100}%: covered ${area}px^2 of ${target.name}`
        ).toBe(0);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${theme}@${zoom * 100}%: horizontal overflow`).toBeLessThanOrEqual(1);
    });
  }
}
