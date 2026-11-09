import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { GUEST_DAILY_CREDIT_LIMIT, mockGuestUsage, setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) for (const appearance of ["classic", "studio"] as const) {
  test(`guest placeholder meets AA at ${width}px in ${theme} ${appearance}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "en", appearance, appearance);
    await mockGuestUsage(page, 0, GUEST_DAILY_CREDIT_LIMIT);
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    await page.goto("/chat?lang=en");
    const input = page.getByTestId("chat-textarea");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const sample = await expectAccessibleContrast(input, "Guest input placeholder", "::placeholder");
    expect(sample.text).not.toBe("");
    expect(sample.ratio).toBeGreaterThanOrEqual(4.5);
    await input.fill("A guest draft remains editable.");
    await expect(input).toHaveValue("A guest draft remains editable.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
