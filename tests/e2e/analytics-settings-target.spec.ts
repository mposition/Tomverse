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

for (const route of ROUTES) {
  test(`analytics settings never covers ${route.name} content`, { tag: "@ui-risk" }, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = await openWithConsentSettled(page, route.path, "ko");
    const box = (await settings.boundingBox())!;

    // Intersection against every interactive element and every heading the
    // page is currently showing -- the things a covered pixel would actually
    // cost the user -- rather than against `main`, which the pill sits over by
    // construction.
    const collisions = await page.evaluate((pill) => {
      const targets = Array.from(
        document.querySelectorAll<HTMLElement>(
          "main a[href], main button, main input, main select, main h1, main h2, main h3, [data-testid='chat-consent-notice']"
        )
      );
      const overlaps: Array<{ label: string; area: number }> = [];
      for (const target of targets) {
        if (target.closest("[data-testid='analytics-settings-button']")) continue;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(target);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const width = Math.max(
          0,
          Math.min(rect.right, pill.x + pill.width) - Math.max(rect.left, pill.x)
        );
        const height = Math.max(
          0,
          Math.min(rect.bottom, pill.y + pill.height) - Math.max(rect.top, pill.y)
        );
        const area = width * height;
        if (area > 0) {
          overlaps.push({
            label: `${target.tagName.toLowerCase()} "${(target.textContent ?? "")
              .trim()
              .slice(0, 40)}"`,
            area: Math.round(area),
          });
        }
      }
      return overlaps;
    }, box);

    expect(
      collisions,
      `Analytics settings covers page content:\n${collisions
        .map((c) => `${c.label} ${c.area}px²`)
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
