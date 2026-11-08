import { expect, test } from "@playwright/test";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

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

for (const theme of ["light", "dark"] as const) {
  test(`notification switch thumb stays inside its track and changes sides in ${theme}`, async ({ page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
    await prepareGuestPage(page, "ko");
    const account = await mockAuthenticatedApi(page);
    account.theme = theme;
    await setDeterministicTheme(page, theme);
    let serviceEnabled = true;
    const writes: unknown[] = [];
    await page.route("**/api/user/email-preferences", async route => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        writes.push(body);
        serviceEnabled = body.enabled;
      }
      await route.fulfill({ json: {
        preferences: preferences(false).map(row => row.purpose === "service_status" ? { ...row, enabled: serviceEnabled } : row),
        country: { selfDeclared: "DE", resolved: "DE", confidence: "high", conflicts: [], needsConfirmation: false, marketingSupported: true },
      } });
    });
    await page.goto("/settings/notifications?lang=ko");
    const service = page.getByTestId("email-preference-service_status-toggle");
    const newsletter = page.getByTestId("email-preference-newsletter-toggle");
    const expectSide = async (control: typeof service, on: boolean) => {
      await expect(control).toHaveAttribute("aria-checked", String(on));
      await expect.poll(() => control.evaluate((element, enabled) => {
        const track = element.getBoundingClientRect();
        const thumb = element.querySelector("span")!.getBoundingClientRect();
        const inset = enabled ? track.right - thumb.right : thumb.left - track.left;
        return thumb.top >= track.top && thumb.bottom <= track.bottom && inset >= 1 && inset <= 3;
      }, on)).toBe(true);
    };
    await expectSide(service, true);
    await expectSide(newsletter, false);
    expect(writes).toEqual([]);
    await service.click();
    await expectSide(service, false);
    await service.click();
    await expectSide(service, true);
    expect(writes).toEqual([{ purpose: "service_status", enabled: false }, { purpose: "service_status", enabled: true }]);
  });
}

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
