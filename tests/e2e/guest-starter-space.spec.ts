import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";

import { expectTappableInVisibleViewport } from "./support/ui-audit";

test.use({ hasTouch: true });
test.setTimeout(90_000);
for (const appearance of ["classic", "studio"] as const) for (const theme of ["light", "dark"] as const) {
  test(`guest starters keep usable space in ${appearance} ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await prepareGuestPage(page, "en", "classic", appearance);
    await setDeterministicTheme(page, theme);
    await suppressTransientUi(page);
    // The readable (stacked) consent notice occupies the dock on /chat; this test
    // measures starter space, not the notice, so settle the choice up front.
    await page.addInitScript(() => window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted"));
    await page.context().addCookies([
      { name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! },
      { name: "__tomverse_e2e_chat_starter", value: "1", url: baseURL! },
    ]);
    await page.goto("/chat?lang=en");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const cards = page.getByTestId("chat-starter-card");
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    const metrics = await page.evaluate(() => {
      const rect = (id: string) => { const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      return { input: rect("chat-input"), textarea: rect("chat-textarea"), surface: rect("mobile-conversation-surface"), first: rect("chat-starter-card"), dock: rect("mobile-bottom-dock") };
    });
    expect(metrics.textarea.height).toBeGreaterThanOrEqual(44);
    expect(metrics.input.height).toBeLessThanOrEqual(164);
    expect(metrics.surface.height).toBeGreaterThanOrEqual(240);
    expect(metrics.first.top).toBeGreaterThanOrEqual(metrics.surface.top);
    expect(metrics.first.bottom).toBeLessThanOrEqual(metrics.surface.bottom);
    expect(metrics.surface.bottom).toBeLessThanOrEqual(metrics.dock.top);
    await page.getByTestId("guest-quick-start-help").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expectTappableInVisibleViewport(page, cards.last(), "Last guest suggestion");
    expect(await cards.last().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom <= document.querySelector('[data-testid="mobile-bottom-dock"]')!.getBoundingClientRect().top;
    })).toBe(true);
    const available = page.locator('[data-testid="chat-starter-card"][data-starter-state="available"]').first();
    let executions = 0;
    page.on("request", request => { if (request.method() === "POST" && /\/api\/chat\/(?:model|preflight)(?:\?|$)/.test(request.url())) executions++; });
    await available.click();
    await expect(page.getByTestId("chat-textarea")).not.toHaveValue("");
    expect(executions).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
