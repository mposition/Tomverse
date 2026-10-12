import { expect, test, type Locator } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

const expectSafeNewTabLink = async (locator: Locator, lang: "en" | "ko") => {
  await expect(locator).toHaveAttribute("href", `/status?lang=${lang}`);
  await expect(locator).toHaveAttribute("target", "_blank");
  await expect(locator).toHaveAttribute("rel", /noopener/);
  await expect(locator).toHaveAttribute("rel", /noreferrer/);
};

for (const lang of ["en", "ko"] as const) {
  test(`${lang} public status remains discoverable from the marketing footer`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    await page.goto(lang === "en" ? "/" : "/ko");
    await expectSafeNewTabLink(page.getByTestId("footer-status-link"), lang);
  });

  test(`${lang} model catalogue links to live service status`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    await page.goto(lang === "en" ? "/models" : "/ko/models");
    await expectSafeNewTabLink(page.getByTestId("models-status-link"), lang);
  });
}

test("mobile marketing menu stays focused on the four primary destinations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "Menu" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  // Product entry choices stay separate; FAQ and status remain in the footer.
  const menu = page.locator("header nav").filter({ has: page.getByTestId("mobile-chat-link") });
  for (const id of ["chat", "review", "models", "pricing"]) {
    await expect(menu.getByTestId(`mobile-${id}-link`)).toBeVisible();
  }
  await expect(menu.locator('[data-testid^="mobile-"][data-testid$="-link"]')).toHaveCount(4);
  await expect(menu.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Review", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Explore models", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Pricing", exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "FAQ" })).toHaveCount(0);
  await expect(menu.getByRole("link", { name: "Service status" })).toHaveCount(0);
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
