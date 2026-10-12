import { expect, test, type Page } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { GUEST_DAILY_CREDIT_LIMIT, mockGuestUsage, restoreActiveConversation } from "./support/chat-state-fixtures";

async function openProductSwitcher(page: Page) {
  const mobileMenu = page.getByTestId("mobile-sidebar-open");
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    return page
      .getByTestId("mobile-sidebar-drawer")
      .getByTestId("chat-product-switcher");
  }
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
    await expect(
      composer
        .getByTestId("composer-primary-tools")
        .getByTestId("composer-model-select")
    ).toBeVisible();
    await expect(composer.getByTestId("chat-send-button")).toHaveClass(
      /bg-zinc-900/
    );
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
    // Open the fixture's saved selection instead of relying on the new-chat catalogue default.
    await restoreActiveConversation(page);
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
    await expect(composer.getByTestId("chat-send-button")).toHaveClass(
      /bg-blue-600/
    );

    const selectedModel = composer.getByTestId("composer-review-selected-model");
    await expect(selectedModel).toHaveCount(1);
    await expect(selectedModel).toHaveAttribute("data-model-id", "gpt-5-6-luna");
    await expect(selectedModel).toContainText(/GPT-5\.6 Luna/i);

    const conversationWrites: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== "GET" &&
        pathname.startsWith("/api/conversations")
      ) {
        conversationWrites.push(`${request.method()} ${pathname}`);
      }
    });
    await composer.getByTestId("composer-model-select").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    expect(conversationWrites).toEqual([]);
    // The existing full-screen picker closes through Escape/Done, then returns focus.
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toHaveCount(0);
    await composer.getByTestId("composer-model-select").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toHaveCount(0);
    await expect(composer.getByTestId("composer-model-select")).toBeFocused();
    expect(conversationWrites).toEqual([]);
  });

  test("desktop full-support search sits in the footer beside a dedicated input row", async ({ page }) => {
    await mockAuthenticatedApi(page, { webSearchMode: "always" });
    await restoreActiveConversation(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/review?lang=en");
    const composer = page.getByTestId("chat-input");
    await expect(composer.getByTestId("composer-product-context")).toContainText("Model Compare");
    const chip = composer.getByTestId("composer-primary-tools").getByTestId("web-search-mode-chip");
    await expect(chip).toBeVisible();
    await expect(composer.getByTestId("tool-status-chip-row")).toHaveCount(0);
    const textarea = composer.getByTestId("chat-textarea");
    const inputBox = (await textarea.boundingBox())!;
    const chipBox = (await chip.boundingBox())!;
    expect(inputBox.height).toBeGreaterThanOrEqual(112);
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(chipBox.y + 0.5);
    expect(await textarea.evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
    await expectNoHorizontalOverflow(page);
  });

  test(
    "mobile keeps the canonical switch in the composer and drawer without narrowing input",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.goto("/chat?lang=en");

      const composer = page.locator('[data-testid="chat-input"]:visible');
      await expect(composer).toHaveCount(1);
      const composerSwitcher = composer.getByTestId("chat-product-switcher");
      await expect(composerSwitcher).toHaveCount(1);
      await expect(composerSwitcher.getByTestId("chat-product-chat")).toHaveAttribute(
        "href",
        "/chat?lang=en"
      );
      await expect(composerSwitcher.getByTestId("chat-product-review")).toHaveAttribute(
        "href",
        "/review?lang=en"
      );
      for (const target of [
        composerSwitcher.getByTestId("chat-product-chat"),
        composerSwitcher.getByTestId("chat-product-review"),
      ]) {
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
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

test.describe("Guest Chat and Review product entry", () => {
  test("a guest switches directly between products and retains each idle draft", async ({ page }) => {
    await prepareGuestPage(page, "en");
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")) {
        writes.push(new URL(request.url()).pathname);
      }
    });
    await page.goto("/review?lang=en&entry=guest-preview");
    const textarea = page.getByTestId("chat-textarea");
    const reviewDraft = "This draft belongs to the guest Review trial.";
    const chatDraft = "This draft belongs to the guest Chat trial.";
    await textarea.fill(reviewDraft);

    let switcher = await openProductSwitcher(page);
    await expect(switcher.getByTestId("chat-product-chat")).toHaveAttribute("href", "/chat?lang=en");
    await switcher.getByTestId("chat-product-chat").click();
    await expect(page).toHaveURL(/\/chat\?lang=en$/);
    await expect(textarea).toHaveValue("");
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await textarea.fill(chatDraft);

    switcher = await openProductSwitcher(page);
    await switcher.getByTestId("chat-product-review").click();
    await expect(page).toHaveURL(/\/review\?lang=en$/);
    await expect(textarea).toHaveValue(reviewDraft);

    switcher = await openProductSwitcher(page);
    await switcher.getByTestId("chat-product-chat").click();
    await expect(page).toHaveURL(/\/chat\?lang=en$/);
    await expect(textarea).toHaveValue(chatDraft);
    expect(writes).toEqual([]);
  });

  test("the guest Chat limit offers sign-in without a Review import intent", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockGuestUsage(page, GUEST_DAILY_CREDIT_LIMIT, GUEST_DAILY_CREDIT_LIMIT);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    // The exhausted server snapshot opens the Guest limit dialog on entry.
    const modal = page.getByTestId("usage-limit-modal");
    await expect(modal).toBeVisible();
    const signIn = modal.getByTestId("usage-limit-guest-signin");
    await expect(signIn).toHaveText("Login / Sign Up");
    await expect(signIn).toHaveAttribute("href", "/auth/signin?callbackUrl=%2Fchat%3Flang%3Den");
    await expect(modal).toContainText("Your guest Chat stays in this browser.");
    // Keep the document open while exercising the real click handler so the
    // assertion can inspect its local import-intent side effect.
    await signIn.evaluate((element) => {
      element.addEventListener("click", (event) => event.preventDefault());
    });
    await signIn.click();
    expect(await page.evaluate(() => localStorage.getItem("tomverse_pending_guest_import"))).toBeNull();
  });
});
