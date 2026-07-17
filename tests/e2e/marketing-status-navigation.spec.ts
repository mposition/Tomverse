import { expect, test, type Locator } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

const expectSafeNewTabLink = async (locator: Locator) => {
  await expect(locator).toHaveAttribute("href", "/status");
  await expect(locator).toHaveAttribute("target", "_blank");
  await expect(locator).toHaveAttribute("rel", /noopener/);
  await expect(locator).toHaveAttribute("rel", /noreferrer/);
};

test("public status remains discoverable from the marketing footer", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/");

  await expectSafeNewTabLink(page.getByTestId("footer-status-link"));

});

test("the model catalogue links to live service status", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/models");

  await expectSafeNewTabLink(page.getByTestId("models-status-link"));
});

test("mobile marketing menu stays focused on the four primary destinations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "Menu" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.locator("header nav").filter({ hasText: "Features" });
  await expect(menu.getByRole("link", { name: "Features" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Models" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "FAQ" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Status" })).toHaveCount(0);
});

test("ChatGPT vs Claude guide serves every comparison image", async ({ page }) => {
  await prepareGuestPage(page, "en");
  for (const path of [
    "/model-icons/chatgpt.png",
    "/model-icons/claude.png",
  ]) {
    const directImage = await page.request.get(path);
    expect(directImage.ok()).toBe(true);
    expect(directImage.headers()["content-type"]).toContain("image/png");
  }
  const failedImages: string[] = [];
  page.on("response", (response) => {
    if (
      response.request().resourceType() === "image" &&
      response.status() >= 400
    ) {
      failedImages.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/chatgpt-vs-claude");
  const images = page.locator("img");
  await expect(images.first()).toBeVisible();
  const imageCount = await images.count();
  for (let index = 0; index < imageCount; index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0);
  }
  const imageState = await images.evaluateAll((elements) =>
    elements.map((element) => {
      const image = element as HTMLImageElement;
      return {
        src: image.currentSrc || image.src,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
      };
    })
  );

  expect(failedImages).toEqual([]);
  expect(imageState.length).toBeGreaterThanOrEqual(7);
  expect(imageState.every((image) => image.complete && image.naturalWidth > 0)).toBe(true);
});
