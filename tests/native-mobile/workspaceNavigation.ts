import { expect, type Page } from "@playwright/test";

export async function selectProduct(page: Page, product: "chat" | "review") {
  if (await page.locator(".conversation-list").isVisible()) {
    await page.locator(".app-header .menu-button").click();
  }
  const button = page.getByRole("navigation").getByRole("button", { name: product === "chat" ? "Chat" : "Review", exact: true });
  await expect(button.or(page.getByTestId("product-switcher")).first()).toBeVisible();
  if (await button.isVisible()) await button.click();
  else await page.getByTestId("product-switcher").selectOption(product);
}
