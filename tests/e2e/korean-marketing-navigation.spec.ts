import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("Korean pricing navigation translates product actions and preserves destinations", async ({ page }, testInfo) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/pricing");
  const mobile = testInfo.project.name.startsWith("mobile");
  if (mobile) await page.getByTestId("marketing-menu-button").click();
  const prefix = mobile ? "mobile" : "header";
  const chat = page.getByTestId(`${prefix}-chat-link`);
  await expect(chat).toHaveText("채팅");
  await expect(chat).toHaveAttribute("href", /(?:\/ko#chat|\/chat\?lang=ko)/);
  await expect(page.getByTestId(`${prefix}-review-link`)).toHaveText("리뷰");
  await expect(page.getByTestId(`${prefix}-review-link`)).toHaveAttribute("href", "/ko/products/review");
  await expectNoHorizontalOverflow(page);
  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("marketing-menu-button")).toBeFocused();
  }
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.route("**/api/marketing/chat-entry", (route) => route.fulfill({ json: { offered: true } }));
  await page.reload();
  if (mobile) await page.getByTestId("marketing-menu-button").click();
  await expect(page.getByTestId(mobile ? "marketing-mobile-app-cta" : "marketing-header-app-cta")).toHaveText(/채팅으로 돌아가기/);
});
