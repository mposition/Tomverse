import { expect, test } from "@playwright/test";

import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

const preferences = (productUpdatesPending: boolean) => [
  { purpose: "security", enabled: true, locked: true, confirmation: null },
  { purpose: "billing", enabled: true, locked: true, confirmation: null },
  { purpose: "service_status", enabled: true, locked: false, confirmation: null },
  {
    purpose: "product_updates",
    enabled: false,
    locked: false,
    confirmation: productUpdatesPending ? "pending" : "off",
    confirmationExpiresAt: productUpdatesPending
      ? new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString()
      : null,
  },
  { purpose: "newsletter", enabled: false, locked: false, confirmation: "off" },
  { purpose: "promotions", enabled: false, locked: false, confirmation: "off" },
];

test("pending analytics consent leaves notification guidance and controls uncovered", async ({ page, baseURL, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
  await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page);
  await page.route("**/api/user/email-preferences", route => route.fulfill({ json: {
    preferences: preferences(false),
    country: { selfDeclared: "DE", resolved: "DE", confidence: "high", conflicts: [], needsConfirmation: false, marketingSupported: true },
  } }));
  await page.goto("/settings/notifications?lang=ko");
  const slot = page.getByTestId("settings-consent-slot");
  const notice = slot.getByTestId("chat-consent-notice");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  for (const locator of [page.getByTestId("email-product-updates-opt-in"), page.getByTestId("email-preference-promotions")]) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    expect(await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
      const notice = document.querySelector('[data-testid="chat-consent-notice"]')!.getBoundingClientRect();
      return element.contains(hit) && rect.bottom <= notice.top;
    })).toBe(true);
  }
  await notice.scrollIntoViewIfNeeded();
  await notice.getByTestId("analytics-consent-decline").click();
  await expect(notice).toHaveCount(0);
  await slot.getByTestId("analytics-settings-button").click();
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("marketing opt-in confirms a country and asks for an email confirmation @ui-risk", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page);

  const writes: Array<Record<string, unknown>> = [];
  let productUpdates = false;
  let country: string | null = null;

  await page.route(
    (url) => url.pathname === "/api/user/email-preferences",
    async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(body);
        if (
          body.purpose === "product_updates" &&
          body.enabled === true &&
          body.country === "DE"
        ) {
          productUpdates = true;
          country = "DE";
        }
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          preferences: preferences(productUpdates),
          country: {
            selfDeclared: country,
            resolved: country ?? "ZZ",
            confidence: country ? "high" : "unknown",
            conflicts: [],
            needsConfirmation: !country,
            marketingSupported: Boolean(country),
          },
        }),
      });
    }
  );

  await page.goto("/settings/notifications");

  const countrySelect = page.getByTestId("email-country-select");
  const optIn = page.getByTestId("email-product-updates-opt-in");
  await expect(countrySelect).toBeVisible();
  await expect(optIn).toBeVisible();
  await expect(page.getByTestId("email-withdraw-all")).toHaveCount(0);

  for (const theme of ["light", "dark"] as const) {
    await page.locator("html").evaluate((element, value) => {
      element.classList.toggle("dark", value === "dark");
    }, theme);
    const descriptions = [
      page.locator("#email-country-description"),
      page.getByTestId("email-preference-security").getByText("끌 수 없습니다", { exact: false }),
      page.getByTestId("email-preference-billing").getByText("끌 수 없습니다", { exact: false }),
    ];
    for (const description of descriptions) {
      await expect(description).toBeVisible();
      const sample = await expectAccessibleContrast(description, `${theme} notification guidance`);
      expect(sample.ratio).toBeGreaterThanOrEqual(4.5);
    }
  }

  // The value-focused CTA is prominent, but it cannot bypass the same country
  // requirement as the granular switch.
  await optIn.click();
  await expect(page.locator("#email-country-error")).toContainText(
    "거주 국가를 선택해 주세요"
  );
  expect(writes).toHaveLength(0);

  await countrySelect.selectOption("DE");
  await optIn.click();

  await expect.poll(() => writes).toEqual([
    { purpose: "product_updates", enabled: true, country: "DE" },
  ]);
  // docs/policy/email-double-opt-in.md §11 item 11: the request is not the
  // consent. The switch stays off, the row says a confirmation is waiting, and
  // it can be sent again.
  await expect(page.getByTestId("email-product-updates-opt-in")).toHaveCount(0);
  await expect(
    page.getByTestId("email-preference-product_updates-toggle")
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByTestId("email-preference-product_updates-confirmation")
  ).toBeVisible();
  await expect(
    page.getByTestId("email-preference-product_updates-resend")
  ).toBeVisible();
  await expect(page.getByTestId("email-withdraw-all")).toHaveCount(0);

  await page.getByTestId("email-preference-product_updates-resend").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ purpose: "product_updates", enabled: true, country: "DE" });
});
