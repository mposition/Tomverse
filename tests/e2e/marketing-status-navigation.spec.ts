import { expect, test, type Locator } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

const expectSafeNewTabLink = async (locator: Locator) => {
  await expect(locator).toHaveAttribute("href", "/status");
  await expect(locator).toHaveAttribute("target", "_blank");
  await expect(locator).toHaveAttribute("rel", /noopener/);
  await expect(locator).toHaveAttribute("rel", /noreferrer/);
};

test("public status is discoverable from marketing navigation and the model section", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  await page.goto("/");

  await expectSafeNewTabLink(page.getByTestId("header-status-link"));
  await expectSafeNewTabLink(page.getByTestId("home-model-status-link"));
  await expectSafeNewTabLink(page.getByTestId("footer-status-link"));

  await page.context().route("**/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Tomverse status</title>",
    })
  );
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("home-model-status-link").click();
  const statusPage = await popupPromise;
  await statusPage.waitForLoadState();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(statusPage.url()).pathname).toBe("/status");
  await statusPage.close();
});

test("the model catalogue links to live service status", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/models");

  await expectSafeNewTabLink(page.getByTestId("models-status-link"));
});

test("mobile marketing menu exposes public status", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "Menu" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await expect(page.getByTestId("mobile-status-link")).toBeVisible();
  await expectSafeNewTabLink(page.getByTestId("mobile-status-link"));
});
