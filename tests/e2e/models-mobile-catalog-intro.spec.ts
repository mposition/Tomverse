import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`Korean mobile model cards start promptly with expandable guidance in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/models?lang=ko");
    await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
    const entry = page.getByTestId("marketing-header-app-cta");
    await expect(entry).toHaveAttribute("data-session-state", "unauthenticated");
    await expect(entry).toHaveAccessibleName(/채팅 시작하기/);
    await expect(entry).toHaveAttribute("href", "/chat?lang=ko");
    await expect(entry).toBeVisible();
    const menu = page.getByTestId("marketing-menu-button");
    const entryBox = (await entry.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(Math.abs(entryBox.y - menuBox.y)).toBeLessThan(2);
    expect(entryBox.x + entryBox.width).toBeLessThan(menuBox.x);
    expect(entryBox.height).toBeGreaterThanOrEqual(44);
    const details = page.getByTestId("models-mobile-usage-details");
    await expect(details).not.toHaveAttribute("open");
    const firstCard = page.getByRole("article").first();
    await expect(firstCard).toBeVisible();
    // The analytics notice above the page is shown once and its copy is explicit by design (#3571, #3592); measure the catalogue's own intro.
    const consentHeight = await page.getByTestId("marketing-consent-slot").evaluate(node => node.getBoundingClientRect().height);
    expect(await firstCard.evaluate((node) => node.getBoundingClientRect().top + scrollY) - consentHeight).toBeLessThan(800);
    const filters = page.locator("#models-catalog-filters");
    await expect(filters).toBeHidden();
    await page.getByTestId("models-mobile-filters-toggle").click();
    await expect(filters.getByRole("searchbox")).toBeVisible();
    await page.getByTestId("models-mobile-filters-toggle").click();
    await expect(filters).toBeHidden();
    await details.locator("summary").focus();
    await details.locator("summary").press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText(/1.5배, 2배 또는 3배/)).toBeVisible();
    await details.locator("summary").press("Enter");
    await expect(details).not.toHaveAttribute("open");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const brand = (await page.getByTestId("marketing-brand-name").boundingBox())!;
    const language = (await page.getByRole("combobox", { name: "언어" }).boundingBox())!;
    expect(brand.x + brand.width <= language.x || brand.y + brand.height <= language.y || brand.y >= language.y + language.height).toBe(true);
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
  });
}

test("desktop keeps the complete model usage guidance visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/models?lang=ko");
  await expect(page.getByTestId("models-mobile-usage-details")).toBeHidden();
  await expect(page.getByText(/긴 대화와 파일은 입력 크기에 따라 기본 크레딧의 1.5배/).filter({ visible: true })).toBeVisible();
});
