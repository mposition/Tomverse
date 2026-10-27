import { expect, test } from "@playwright/test";
import { mobileCopy } from "../../locales/mobile";

for (const theme of ["light", "dark"]) {
  test(`Android's shared workspace, controls and settings fit iOS in ${theme}`, async ({ page }, info) => {
    const copy = mobileCopy.ko;
    await page.addInitScript(theme => {
      localStorage.setItem("tomverse-language", "ko");
      localStorage.setItem("tomverse-theme", theme);
    }, theme);
    await page.route("https://tomverse.app/**", route => route.abort());
    await page.goto("/");
    await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
    const start = page.getByTestId("workspace-start");
    await expect(start).toHaveAttribute("data-product", "chat");
    await page.evaluate(() => document.fonts.ready);
    const capture = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: document overflow`).toBe(true);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`) });
    };
    const brand = await page.locator(".brand-lockup").boundingBox();
    const header = await page.locator(".app-header").boundingBox();
    expect(Math.abs(brand!.x + brand!.width / 2 - header!.x - header!.width / 2)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("textbox")).toBeInViewport();
    await capture("chat");
    await page.locator(".workspace-navigation").getByRole("button", { name: "Review", exact: true }).click();
    await expect(start).toHaveAttribute("data-product", "review");
    await capture("review");
    await page.locator(".review-setup-trigger").click();
    const selection = page.getByRole("dialog");
    await expect(selection.locator(".selection-body")).toBeVisible();
    await selection.getByRole("button", { name: "Professional", exact: true }).click();
    await expect(selection.getByRole("button", { name: "완료", exact: true })).toBeInViewport();
    await capture("review-models");
    await selection.getByRole("button", { name: copy.close, exact: true }).click();
    await page.locator(".workspace-navigation").getByRole("button", { name: "Chat", exact: true }).click();
    await page.locator(".model-trigger").click();
    await expect(page.getByRole("dialog").locator(".selection-body")).toBeVisible();
    await capture("chat-models");
    await page.getByRole("dialog").getByRole("button", { name: copy.close, exact: true }).click();
    await page.locator(".composer-add").click();
    await expect(page.getByRole("dialog", { name: "메시지 도구", exact: true })).toBeVisible();
    await capture("tools");
    await page.getByRole("dialog").getByRole("button", { name: copy.close, exact: true }).click();
    await page.getByRole("button", { name: copy.chats, exact: true }).click();
    await page.getByTestId("sidebar-account").getByRole("button", { name: copy.settings, exact: true }).click();
    const settings = page.getByRole("dialog");
    for (const tab of ["account", "preferences", "assistants", "ai", "data", "plan"]) {
      await page.getByTestId(`native-settings-tab-${tab}`).click();
      expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${tab}: sheet overflow`).toBe(true);
      await expect(settings.getByRole("button", { name: copy.close, exact: true })).toBeInViewport();
      await capture(`settings-${tab}`);
    }
    await settings.locator(".settings-workspace-return").click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByRole("textbox")).toBeInViewport();
    await expect(page.locator("article.user")).toHaveCount(0);
  });
}
