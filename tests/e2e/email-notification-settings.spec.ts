import { expect, test } from "@playwright/test";

import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

const preferences = (productUpdates: boolean) => [
  { purpose: "security", enabled: true, locked: true },
  { purpose: "billing", enabled: true, locked: true },
  { purpose: "service_status", enabled: true, locked: false },
  { purpose: "product_updates", enabled: productUpdates, locked: false },
  { purpose: "newsletter", enabled: false, locked: false },
  { purpose: "promotions", enabled: false, locked: false },
];

test("marketing opt-in confirms a country in the same action @ui-risk", async ({
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
  await expect(page.getByTestId("email-product-updates-opt-in")).toHaveCount(0);
  await expect(
    page.getByTestId("email-preference-product_updates-toggle")
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("email-withdraw-all")).toBeVisible();
});
