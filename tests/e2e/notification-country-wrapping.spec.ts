import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const language of ["ko", "en"] as const) {
  test(`${language} country guidance wraps safely at 320px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, language);
    await mockAuthenticatedApi(page);
    await page.route("**/api/user/email-preferences", route => route.fulfill({
      json: { preferences: [], country: { selfDeclared: null, resolved: "ZZ", confidence: "unknown", conflicts: [], needsConfirmation: true, marketingSupported: false } },
    }));
    await page.goto("/settings/notifications");
    const description = page.locator("#email-country-description");
    await expect(description).toBeVisible({ timeout: 30_000 });
    await expect(description).toHaveCSS("word-break", language === "ko" ? "keep-all" : "normal");
    if (language === "ko") {
      for (const word of ["마케팅을", "거부", "국가별"]) expect(await renderedWordLineCount(description, word)).toBe(1);
    }
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    if (language === "ko") await description.evaluate(element => element.append(" https://example.com/" + "a".repeat(150)));
    const box = await description.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    expect(await description.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
}
