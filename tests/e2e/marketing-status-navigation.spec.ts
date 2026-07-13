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
