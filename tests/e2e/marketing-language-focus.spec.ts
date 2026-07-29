import { expect, test, type Page } from "@playwright/test";
import { mockPublicProofMetrics, prepareGuestPage } from "./support/app-fixtures";
import {
  expectThemeApplied,
  setDeterministicTheme,
  type Theme,
} from "./support/chat-state-fixtures";

/**
 * REAUDIT-F005. The marketing language `<select>` carries `outline-none` so
 * its native focus ring cannot clash with the pill around it, but nothing
 * replaced it: focused and unfocused screenshots of the control were
 * identical (WCAG 2.4.7 Focus Visible). Every other control in the same
 * header -- the brand link, the CTA, the consent actions -- draws one.
 *
 * The assertion compares the *rendered* indicator before and after focus
 * rather than looking for a class name, so a ring that is drawn but clipped
 * by the pill's `overflow-hidden` still fails.
 */

const THEMES: Theme[] = ["light", "dark"];

async function openMarketingPage(
  page: Page,
  route: string,
  theme: Theme,
  viewport: { width: number; height: number }
) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  await prepareGuestPage(page, "en");
  await setDeterministicTheme(page, theme);
  await mockPublicProofMetrics(page);
  await page.goto(`${route}?lang=en`);
  await expectThemeApplied(page, theme);
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  test(`the marketing language selector shows a visible focus state (${theme})`, {
    tag: "@ui-risk",
  }, async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Viewport is set explicitly; covered once."
    );
    await openMarketingPage(page, "/pricing", theme, { width: 1440, height: 900 });

    const select = page.locator('select[aria-label="Language"]').first();
    await expect(select).toBeVisible();
    const readIndicator = () =>
      select.evaluate((element) => {
        const shell = element.closest("label") ?? element;
        const style = getComputedStyle(shell);
        const own = getComputedStyle(element);
        return {
          shellShadow: style.boxShadow,
          shellOutline: `${style.outlineStyle} ${style.outlineWidth}`,
          ownShadow: own.boxShadow,
          ownOutline: `${own.outlineStyle} ${own.outlineWidth}`,
        };
      });

    const before = await readIndicator();
    await select.focus();
    await expect(select).toBeFocused();
    const after = await readIndicator();

    expect(
      JSON.stringify(after),
      `focused and unfocused render identically: ${JSON.stringify(before)}`
    ).not.toBe(JSON.stringify(before));
    const hasRing =
      (after.shellShadow !== "none" && after.shellShadow !== before.shellShadow) ||
      (after.shellOutline !== before.shellOutline && !after.shellOutline.startsWith("none")) ||
      (after.ownShadow !== "none" && after.ownShadow !== before.ownShadow) ||
      (after.ownOutline !== before.ownOutline && !after.ownOutline.startsWith("none"));
    expect(hasRing, `no focus ring drawn: ${JSON.stringify(after)}`).toBe(true);
  });
}
