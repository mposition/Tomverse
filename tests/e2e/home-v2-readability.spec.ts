import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";
import { homeV2Content } from "@/components/marketing/home/homeV2Content";

// Homepage V2 replaces the launch homepage's model stamps, mobile hero details and
// example caption. What those tests protected still holds: the primary action is
// reachable on a phone, the illustration notes and the motion control are
// readable, and nothing overflows the viewport.
test.setTimeout(90_000);

for (const lang of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) {
  test(`${lang} home keeps its primary action, notes and motion control readable at 320px in ${theme}`, async ({ page, baseURL }) => {
    const copy = homeV2Content[lang];
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto(lang === "en" ? "/?lang=en" : "/ko");
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();

    const action = page.getByTestId("landing-primary-cta");
    await expect(action).toHaveAccessibleName(copy.hero.primary);
    await expect(action).toHaveAttribute("href", `/review?lang=${lang}&entry=guest-preview`);
    const button = (await action.boundingBox())!;
    expect(button.y + button.height).toBeLessThan(900 * 1.6);

    await expectAccessibleContrast(page.getByTestId("landing-hero-signup-note"), "Home sign-up note");
    await expectAccessibleContrast(page.getByTestId("launch-motion-toggle"), "Home motion control");
    for (const id of ["adaptive", "continue", "plugins"]) {
      const note = page.locator(`#${id} .note`).first();
      await note.scrollIntoViewIfNeeded();
      expect(await note.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(11);
      await expectAccessibleContrast(note, `Home ${id} note`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
