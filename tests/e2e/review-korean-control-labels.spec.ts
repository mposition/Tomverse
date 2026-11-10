import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

for (const width of [1440, 320]) for (const appearance of ["classic", "studio"] as const) {
  test(`Korean Review controls explain their roles at ${width}px in ${appearance}`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko", appearance);
    await mockAuthenticatedApi(page, { productKey: "review", language: "ko" });
    await page.context().addCookies([{ name: "__tomverse_e2e_review_easy", value: "1", url: baseURL! }]);
    await page.goto("/review?lang=ko");
    const product = page.getByTestId("chat-product-switcher");
    await expect(product).toBeVisible({ timeout: 30_000 });
    await expect(product.getByTestId("chat-product-chat")).toContainText("채팅");
    await expect(product.getByTestId("chat-product-review")).toContainText("비교");
    await expect(product.getByTestId("chat-product-chat")).toHaveAccessibleName(/Tomverse Chat.*질문 다듬기/);
    await expect(product.getByTestId("chat-product-review")).toHaveAttribute("aria-current", "page");
    let mode = page.getByTestId("composer-review-mode");
    if (!(await mode.isVisible())) {
      await page.getByTestId("mobile-sidebar-open").click();
      mode = page.getByTestId("mobile-sidebar-drawer").getByRole("group", { name: "비교 모드", exact: true });
    }
    if (await mode.evaluate(element => element.tagName === "SELECT")) {
      await expect(mode.locator('option[value="easy"]')).toHaveText("간편");
      await expect(mode.locator('option[value="professional"]')).toHaveText("전문가");
    } else {
      await expect(mode.getByRole("button", { name: "간편", exact: true })).toBeVisible();
      await expect(mode.getByRole("button", { name: "전문가", exact: true })).toBeVisible();
    }
  });
}
