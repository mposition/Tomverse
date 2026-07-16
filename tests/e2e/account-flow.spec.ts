import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

async function installClipboardMock(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard = value;
        },
        readText: async () =>
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard || "",
      },
    });
  });
}

async function openSidebarOnMobile(page: Page) {
  if (await page.getByTestId("mobile-chat-shell").isVisible()) {
    if (await page.getByRole("dialog", { name: "Tomverse AI" }).isVisible()) {
      return;
    }

    await page
      .getByTestId("mobile-chat-shell")
      .locator("header")
      .getByRole("button")
      .first()
      .click();
  }
}

async function openAccountMenu(page: Page) {
  await openSidebarOnMobile(page);
  await page.getByTestId("account-menu-trigger").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
}

async function openConversationMenu(page: Page) {
  await openSidebarOnMobile(page);
  await page.getByTestId("conversation-menu").first().click();
  await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
}

async function openModelSelector(page: Page) {
  const trigger = page.locator('button[aria-controls="chat-input-popover"]').nth(1);
  await trigger.click();
}

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await installClipboardMock(page);
  await mockAuthenticatedApi(page);
  await page.goto("/chat");
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("billing success modal respects the explicit return language", async ({ page }) => {
  await page.goto("/chat?billing=success&plan=max&interval=monthly&lang=ko");

  const successDialog = page.getByRole("dialog", { name: "결제 완료" });
  await expect(successDialog).toBeVisible();
  await expect(successDialog).toContainText("결제가 성공적으로 완료되었습니다.");
  await expect(successDialog).toContainText("월간");
  await expect(successDialog.getByRole("button", { name: "닫기" })).toBeVisible();
});

test("authenticated user opens settings and starts Private Mode", async ({ page }) => {
  await openAccountMenu(page);
  await page
    .getByTestId("account-menu")
    .getByRole("button", { name: /설정|Settings|设置/ })
    .click();
  const settingsDialog = page.getByRole("dialog", {
    name: /사용자 설정|User Settings|用户设置/,
  });
  await expect(settingsDialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(settingsDialog).toBeHidden();

  await openSidebarOnMobile(page);
  await page.getByRole("button", { name: /Private Mode/ }).first().click();
  const privateModeDialog = page.getByRole("dialog").filter({ hasText: /Private Mode/ }).last();
  await expect(privateModeDialog).toBeVisible();
  await privateModeDialog.getByRole("button").last().click();

  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByText(/Private Mode/).first()).toBeVisible();
});

test("theme preference changes immediately and follows the system setting", async ({ page }) => {
  await expect(page.locator("html")).toHaveClass(/dark/);
  await openAccountMenu(page);
  await page
    .getByTestId("account-menu")
    .getByRole("button", { name: /설정|Settings|设置/ })
    .click();
  let settingsDialog = page.getByRole("dialog", {
    name: /사용자 설정|User Settings|用户设置/,
  });
  await settingsDialog.getByRole("button", { name: /환경설정|Preferences/ }).click();
  await settingsDialog.getByLabel(/테마|Theme/).selectOption("light");
  await settingsDialog.getByRole("button", { name: /확인|OK/, exact: true }).click();

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect
    .poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(255, 255, 255)");

  await page.emulateMedia({ colorScheme: "dark" });
  await openAccountMenu(page);
  await page
    .getByTestId("account-menu")
    .getByRole("button", { name: /설정|Settings|设置/ })
    .click();
  settingsDialog = page.getByRole("dialog", {
    name: /사용자 설정|User Settings|用户设置/,
  });
  await settingsDialog.getByRole("button", { name: /환경설정|Preferences/ }).click();
  await settingsDialog.getByLabel(/테마|Theme/).selectOption("system");
  await settingsDialog.getByRole("button", { name: /확인|OK/, exact: true }).click();

  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("authenticated selector blocks a fourth model", async ({ page }) => {
  await openModelSelector(page);

  const selectedModels = page.locator('[data-testid="model-option"][aria-pressed="true"]');
  const unselectedModels = page.locator(
    '[data-testid="model-option"][data-model-plan-locked="false"][aria-pressed="false"]:not([disabled])'
  );

  await unselectedModels.first().click();
  await unselectedModels.first().click();
  await expect(selectedModels).toHaveCount(3);

  await unselectedModels.first().click();
  await expect(page.getByRole("status")).toContainText(/최대 3개|up to 3|最多 3/);
  await expect(selectedModels).toHaveCount(3);
});

test("share uses product toast and copies the canonical URL", async ({ page }) => {
  await openConversationMenu(page);
  await page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /공유|Share|分享/ })
    .first()
    .click();

  await expect(page.getByTestId("share-confirmation-dialog")).toBeVisible();
  await page.getByTestId("share-confirmation-submit").click();

  await expect(page.getByRole("status")).toContainText(/복사|copied|复制/);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://tomverse.app/share/qa-share-token-1234567890"
  );
});

test("lock and delete actions use product dialogs", async ({ page }) => {
  await openConversationMenu(page);
  await page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /잠금|Lock|锁定/ })
    .first()
    .click();

  const lockDialog = page.getByRole("dialog").filter({
    has: page.locator("#conversation-lock-password"),
  }).last();
  await expect(lockDialog).toBeVisible();
  await lockDialog.locator("#conversation-lock-password").fill("qa-password-123");
  await lockDialog.locator("#conversation-lock-password").press("Enter");
  await expect(lockDialog).toBeHidden();

  await openConversationMenu(page);
  await page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /삭제|Delete|删除/ })
    .first()
    .click();

  await expect(
    page.getByRole("dialog").filter({ hasText: /삭제|Delete|删除/ }).last()
  ).toBeVisible();
});
