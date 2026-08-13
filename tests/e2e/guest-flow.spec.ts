import { expect, type Page, test } from "@playwright/test";
import {
  mockChatStream,
  openModelPickerCatalogue,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

const languageSelect = (page: Page) =>
  page
    .locator("select")
    .filter({ has: page.locator('option[value="ko"]') })
    .last();

async function openMobileDrawerIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? 1024) >= 768) return;

  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await page.getByTestId("mobile-chat-shell").locator("header button").first().click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");
});

test("guest can change and persist language", async ({ page }) => {
  await page.goto("/chat");
  await openMobileDrawerIfNeeded(page);

  await languageSelect(page).selectOption("en");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_language")))
    .toBe("en");

  await page.reload();
  await openMobileDrawerIfNeeded(page);
  await expect(languageSelect(page)).toHaveValue("en");

  await languageSelect(page).selectOption("zh");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tomverse_language")))
    .toBe("zh");

  await page.reload();
  await openMobileDrawerIfNeeded(page);
  await expect(languageSelect(page)).toHaveValue("zh");
});

test("a guest-usage read that fails still finishes its request", { tag: "@smoke" }, async ({ page }) => {
  // `/api/*` answers `private, no-store` (lib/apiCacheControlPolicy.ts), so the
  // browser writes no cache entry -- and writing that entry is what used to
  // drain a response body the page never read. A `fetch()` whose Response is
  // dropped unread therefore stays in flight for the life of the page, which is
  // not a test artefact: it holds a connection open, and every wait for network
  // idle on /chat runs to its timeout instead.
  //
  // The E2E server is configured with an unreachable database on purpose, so
  // this endpoint really does answer 500 here and this really is the error
  // path. Armed before the navigation, because the request is issued during
  // the guest bootstrap.
  const finished = page.waitForEvent("requestfinished", {
    predicate: (request) => request.url().includes("/api/user/guest-usage"),
    timeout: 20_000,
  });

  await page.goto("/chat");

  const request = await finished;
  const response = await request.response();
  // The precondition, asserted rather than assumed: without `no-store` nothing
  // above applies and this test would pass for the wrong reason.
  expect(response?.headers()["cache-control"]).toBe("private, no-store");
});

test("guest message appears immediately with mocked response", { tag: ["@smoke", "@review-parity"] }, async ({ page }, testInfo) => {
  await page.goto("/chat");

  await sendChatMessage(page, testInfo, "First QA message");

  // The guest default is 3 comparison panels, so the same user message and
  // mocked response each legitimately appear once per panel.
  await expect(
    page.locator('[data-message-role="user"]').filter({ hasText: "First QA message" }).first()
  ).toBeVisible();
  await expect(page.getByText("QA mock response", { exact: true }).first()).toBeVisible();
});

test("guest cannot activate a paid model", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/chat");

  await openModelPickerCatalogue(page);
  const selectedModels = page.locator('[data-testid="model-option"][aria-pressed="true"]');
  const selectedCountBefore = await selectedModels.count();
  const paidModel = page
    .locator(
      '[data-testid="model-option"][data-model-plan-locked="true"]:not([disabled])'
    )
    .first();

  await expect(paidModel).toBeVisible();
  await paidModel.click();
  await expect(page.getByRole("dialog").last()).toBeVisible();
  // Clicking a plan-locked model must not change the current selection --
  // whatever the guest default was (currently 3 models) stays as it was.
  await expect(selectedModels).toHaveCount(selectedCountBefore);
});
