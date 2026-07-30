import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { expectFivePointHitTest, measureContrast } from "./support/ui-audit";

/**
 * UI-002. Changing or withdrawing the analytics choice after the fact happens
 * through one control -- the floating "Analytics settings" pill -- on every
 * route that is not mobile chat. It was a 25px-tall pill: discoverable, but not
 * reliably tappable, on exactly the devices where the choice matters most.
 *
 * `hasTouch: true` is load-bearing here, not decoration. `useIsMobileShell` is
 * `(max-width: 767px) AND (pointer: coarse)`, so a project that only narrows
 * the viewport measures desktop density and a 44px assertion passes without
 * ever exercising the mobile branch.
 */
test.use({ hasTouch: true });

const MIN_TARGET = 44;
const TOLERANCE = 0.5;

const MOBILE_WIDTHS = [320, 360, 375, 390, 430];

const ROUTES = [
  { path: "/", name: "marketing" },
  { path: "/pricing", name: "pricing" },
  { path: "/auth/signin", name: "signin" },
] as const;

async function openWithConsentSettled(
  page: Page,
  path: string,
  lang: "ko" | "en",
  consent: "accepted" | "declined" = "accepted"
) {
  await page.context().addCookies([
    { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
  ]);
  await prepareGuestPage(page, lang);
  await page.addInitScript((value) => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", value as string);
  }, consent);
  await page.route("**/api/analytics/events", (route) => route.fulfill({ status: 202, body: "" }));
  await page.goto(path);
  const settings = page.getByTestId("analytics-settings-button");
  await expect(settings).toBeVisible();
  return settings;
}

for (const route of ROUTES) {
  test(`analytics settings is a real touch target on ${route.name}`, { tag: "@ui-risk" }, async ({ page }) => {
    for (const width of MOBILE_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      const settings = await openWithConsentSettled(page, route.path, "ko");

      const box = await settings.boundingBox();
      expect(box, `${route.name}@${width}: no box`).not.toBeNull();
      expect(box!.width, `${route.name}@${width}: width`).toBeGreaterThanOrEqual(
        MIN_TARGET - TOLERANCE
      );
      expect(box!.height, `${route.name}@${width}: height`).toBeGreaterThanOrEqual(
        MIN_TARGET - TOLERANCE
      );
      // Inside the viewport, both axes: a target half off the right edge is
      // not 44px of reachable area.
      expect(box!.x, `${route.name}@${width}: off the left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(
        box!.x + box!.width,
        `${route.name}@${width}: off the right edge`
      ).toBeLessThanOrEqual(width + 0.5);

      await expectFivePointHitTest(settings, `${route.name}@${width}`);
    }
  });
}

/**
 * The pill is a fixed overlay: scroll far enough and it is over *something* on
 * every page, so "it never intersects anything" is not a property the product
 * can hold -- an earlier version of this test asserted exactly that at scroll
 * 0, and passed on the accident of where the layout happened to land. A 2px
 * type change moved a CTA under the pill's corner and it failed, while the
 * button stayed entirely usable.
 *
 * What actually costs a user something is narrower, and does not move with the
 * layout:
 *
 *   1. A control has to stay tappable. After the pill's rectangle is taken out
 *      of it, what is left must still hold a 44x44 square -- or, for a control
 *      that was smaller than that to begin with, a square of its own size.
 *   2. A control has to stay readable. The pill must not sit on any of the
 *      target's own text, which is what names it.
 */
for (const route of ROUTES) {
  test(`analytics settings never obstructs ${route.name} content`, { tag: "@ui-risk" }, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = await openWithConsentSettled(page, route.path, "ko");
    const box = (await settings.boundingBox())!;

    const obstructions = await page.evaluate(
      ([pill, minTarget]: [{ x: number; y: number; width: number; height: number }, number]) => {
        const targets = Array.from(
          document.querySelectorAll<HTMLElement>(
            "main a[href], main button, main input, main select, main h1, main h2, main h3, [data-testid='chat-consent-notice']"
          )
        );
        const pillRect = {
          left: pill.x,
          top: pill.y,
          right: pill.x + pill.width,
          bottom: pill.y + pill.height,
        };
        const intersects = (rect: DOMRect | typeof pillRect) =>
          Math.max(0, Math.min(rect.right, pillRect.right) - Math.max(rect.left, pillRect.left)) > 0 &&
          Math.max(0, Math.min(rect.bottom, pillRect.bottom) - Math.max(rect.top, pillRect.top)) > 0;

        // The pill is one rectangle, so whatever is left of a target is covered
        // by four candidate strips -- above it, below it, and to either side.
        // The largest of those is the biggest uncovered box the target still
        // offers.
        const largestFreeBox = (rect: DOMRect) => {
          const strips = [
            { w: rect.width, h: Math.max(0, pillRect.top - rect.top) },
            { w: rect.width, h: Math.max(0, rect.bottom - pillRect.bottom) },
            { w: Math.max(0, pillRect.left - rect.left), h: rect.height },
            { w: Math.max(0, rect.right - pillRect.right), h: rect.height },
          ];
          return strips.reduce(
            (best, strip) =>
              Math.min(strip.w, strip.h) > Math.min(best.w, best.h) ? strip : best,
            { w: 0, h: 0 }
          );
        };

        const findings: Array<{ label: string; reason: string }> = [];
        for (const target of targets) {
          if (target.closest("[data-testid='analytics-settings-button']")) continue;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = getComputedStyle(target);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (!intersects(rect)) continue;

          const label = `${target.tagName.toLowerCase()} "${(target.textContent ?? "")
            .trim()
            .slice(0, 40)}"`;

          const needed = {
            w: Math.min(minTarget, rect.width),
            h: Math.min(minTarget, rect.height),
          };
          const free = largestFreeBox(rect);
          if (free.w + 0.5 < needed.w || free.h + 0.5 < needed.h) {
            findings.push({
              label,
              reason: `left ${Math.round(free.w)}x${Math.round(free.h)} free, needs ${Math.round(
                needed.w
              )}x${Math.round(needed.h)}`,
            });
            continue;
          }

          // Text rects rather than the element box: this is about the words
          // that name the control, not the padding around them.
          const range = document.createRange();
          range.selectNodeContents(target);
          for (const textRect of Array.from(range.getClientRects())) {
            if (textRect.width === 0 || textRect.height === 0) continue;
            if (intersects(textRect)) {
              findings.push({ label, reason: "covers the control's own text" });
              break;
            }
          }
        }
        return findings;
      },
      [box, MIN_TARGET] as [{ x: number; y: number; width: number; height: number }, number]
    );

    expect(
      obstructions,
      `Analytics settings obstructs page content:\n${obstructions
        .map((finding) => `${finding.label} -- ${finding.reason}`)
        .join("\n")}`
    ).toEqual([]);
  });
}

test("analytics settings is keyboard reachable and opens preferences once", { tag: "@ui-risk" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const settings = await openWithConsentSettled(page, "/pricing", "en");

  await settings.focus();
  await expect(settings).toBeFocused();
  const focusRing = await settings.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outline: style.outlineStyle,
      shadow: style.boxShadow,
    };
  });
  // Tailwind's focus-visible ring is a box-shadow; either a real outline or a
  // ring counts, an invisible focus does not.
  expect(
    focusRing.outline !== "none" || focusRing.shadow !== "none",
    `no visible focus indication: ${JSON.stringify(focusRing)}`
  ).toBe(true);

  await page.keyboard.press("Enter");
  const notice = page.getByTestId("chat-consent-notice");
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`analytics settings label meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = await openWithConsentSettled(page, "/pricing", "en");
    const sample = await measureContrast(settings, "analytics settings");
    expect(
      sample.passes,
      `analytics settings label ${sample.ratio}:1 (needs ${sample.required}) in ${theme}`
    ).toBe(true);
  });
}
