import { expect, test, type Page } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

async function openProductSwitcher(page: Page) {
  const mobileMenu = page.getByTestId("mobile-sidebar-open");
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  return page.getByTestId("chat-product-switcher");
}

test.describe("Tomverse Chat and Review product switcher", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, { autoSelectionOffered: true });
    await page.route("**/api/products/chat/capabilities", async (route) => {
      await route.fulfill({
        headers: { "Cache-Control": "private, no-store" },
        json: { autoSelection: { offered: true } },
      });
    });
    await page.context().addCookies([
      {
        name: "__tomverse_e2e_chat_workspace",
        value: "1",
        url: "http://127.0.0.1:3100",
      },
    ]);
  });

  test("Chat is current while Review is a navigation link", async ({ page }) => {
    await page.goto("/chat?lang=en");

    const composer = page.locator('[data-testid="chat-input"]:visible');
    await expect(composer).toHaveCount(1);
    await expect(page.getByTestId("composer-auto-routing-toggle")).toBeVisible();
    const switcher = await openProductSwitcher(page);
    await expect(switcher).toHaveCount(1);
    await expect(switcher).toBeVisible();
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute(
      "href",
      "/chat?lang=en"
    );
    await expect(switcher.getByTestId("chat-product-review")).toHaveAttribute(
      "href",
      "/review?lang=en"
    );
  });

  test("Review is current and does not present Smart Adaptive as a product", async ({
    page,
  }) => {
    await page.goto("/review?lang=en");

    const composer = page.locator('[data-testid="chat-input"]:visible');
    await expect(composer).toHaveCount(1);
    const switcher = await openProductSwitcher(page);
    await expect(switcher).toHaveCount(1);
    await expect(switcher.getByTestId("chat-product-review")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(switcher.getByTestId("chat-product-chat")).not.toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveCount(0);
  });

  test(
    "the mobile drawer switch keeps 44px targets without taking a composer row",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.goto("/chat?lang=en");

      const composer = page.locator('[data-testid="chat-input"]:visible');
      await expect(composer).toHaveCount(1);
      await expect(composer.getByTestId("chat-product-switcher")).toHaveCount(0);
      const textareaRow = composer.getByTestId("composer-textarea-row");
      const textareaBox = await textareaRow.boundingBox();
      expect(textareaBox).not.toBeNull();
      expect(textareaBox!.width).toBeGreaterThan(250);
      const switcher = await openProductSwitcher(page);
      await expect(switcher).toHaveCount(1);
      const chatTarget = switcher.getByTestId("chat-product-chat");
      const reviewTarget = switcher.getByTestId("chat-product-review");

      for (const target of [chatTarget, reviewTarget]) {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const switcherBox = await switcher.boundingBox();
      expect(switcherBox).not.toBeNull();
      await expect(page.getByTestId("mobile-sidebar-drawer").getByTestId("chat-product-switcher")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    }
  );
});
