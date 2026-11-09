import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";

test.use({ hasTouch: true });
test.setTimeout(90_000);
for (const appearance of ["classic", "studio"] as const) for (const theme of ["light", "dark"] as const) {
  test(`last Korean guest starter is reachable in ${appearance} ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await prepareGuestPage(page, "ko", "classic", appearance);
    await setDeterministicTheme(page, theme);
    await suppressTransientUi(page);
    await page.context().addCookies([
      { name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! },
      { name: "__tomverse_e2e_chat_starter", value: "1", url: baseURL! },
    ]);
    await page.goto("/chat?lang=ko");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const more = page.getByTestId("starter-scroll-more");
    await expect(more).toBeVisible({ timeout: 60_000 });
    await more.click();
    await expect(more).toBeDisabled();
    await expect(more).toBeFocused();
    const last = page.getByTestId("chat-starter-card").last();
    expect(await last.evaluate(element => {
      const r = element.getBoundingClientRect();
      const surface = document.querySelector('[data-testid="mobile-conversation-surface"]')!.getBoundingClientRect();
      const dock = document.querySelector('[data-testid="mobile-bottom-dock"]')!.getBoundingClientRect();
      return r.top >= surface.top && r.bottom <= surface.bottom && r.bottom <= dock.top && element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })).toBe(true);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    const available = page.locator('[data-testid="chat-starter-card"][data-starter-state="available"]').last();
    await available.click();
    await expect(page.getByTestId("chat-textarea")).not.toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
