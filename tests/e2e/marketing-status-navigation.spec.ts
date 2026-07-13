import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("public status is discoverable from marketing navigation and the model section", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  await page.goto("/");

  await expect(page.getByTestId("header-status-link")).toHaveAttribute(
    "href",
    "/status"
  );
  await expect(page.getByTestId("home-model-status-link")).toHaveAttribute(
    "href",
    "/status"
  );
  await expect(page.getByTestId("footer-status-link")).toHaveAttribute(
    "href",
    "/status"
  );
});

test("the model catalogue links to live service status", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/models");

  await expect(page.getByTestId("models-status-link")).toHaveAttribute(
    "href",
    "/status"
  );
});

test("mobile marketing menu exposes public status", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "Menu" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await expect(page.getByTestId("mobile-status-link")).toBeVisible();
  await expect(page.getByTestId("mobile-status-link")).toHaveAttribute(
    "href",
    "/status"
  );
});
