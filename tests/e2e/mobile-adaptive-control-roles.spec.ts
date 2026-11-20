import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

test.use({ hasTouch: true });
for (const lang of ["ko", "en"] as const) for (const appearance of ["classic", "studio"] as const) for (const theme of ["light", "dark"] as const) {
  test(`guest ${lang} mobile ${appearance} distinguishes picker and Auto switch in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang, appearance, appearance);
    await setDeterministicTheme(page, theme);
    await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: {
      autoSelection: { offered: true }, guestAutoCapability: "qa-mobile-auto-label-only", guestAuto: { attachmentSupport: "manual_only" },
    } }));
    let sends = 0;
    await page.route("**/api/chat", route => { sends++; return route.fulfill({ body: "Unexpected fixture send" }); });
    await page.goto(`/chat?lang=${lang}`);
    const toggle = page.getByTestId("composer-auto-routing-toggle");
    const header = page.getByTestId("mobile-header-model-summary");
    const label = page.getByTestId("mobile-header-auto-mode");
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await expect(toggle).toHaveAccessibleName(lang === "ko" ? "스마트 자동" : "Smart Adaptive");
    await expect(label).toHaveText(lang === "ko" ? "모델 선택기 열기" : "Choose model");
    expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await header.click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(label).toHaveText(lang === "ko" ? "모델 선택기 열기" : "Choose model");
    expect(sends).toBe(0);
    await expectNoHorizontalOverflow(page);
  });
}
