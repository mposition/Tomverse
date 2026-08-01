import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

const openLanding = async (page: Page) => {
  await prepareGuestPage(page, "en");
  await page.goto("/");
  await expect(page.getByTestId("landing-hero-product-demo")).toBeVisible();
};

test.describe("landing hero product demonstration", () => {
  test("plays the comparison once and rests on the next-action state", async ({
    page,
  }) => {
    await openLanding(page);

    const demo = page.getByTestId("landing-hero-product-demo");
    await expect(demo).toHaveAttribute("data-active-stage", "0", {
      timeout: 1_500,
    });
    await expect(demo).toHaveAttribute("data-active-stage", "3", {
      timeout: 5_000,
    });

    await expect(page.getByTestId("landing-hero-demo-review")).toBeVisible();
    await expect(
      page.getByTestId("landing-hero-demo-next-action")
    ).toBeVisible();
  });

  test("shows the complete state without playback when reduced motion is requested", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLanding(page);

    const demo = page.getByTestId("landing-hero-product-demo");
    await expect(demo).toHaveAttribute("data-active-stage", "3");
    await page.waitForTimeout(1_000);
    await expect(demo).toHaveAttribute("data-active-stage", "3");
  });

  test("keeps the product demonstration inside a 320px mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openLanding(page);

    const box = await page
      .getByTestId("landing-hero-product-demo")
      .boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(scrollWidth).toBeLessThanOrEqual(320);
  });

  test("continues the product story in the editorial comparison section", async ({
    page,
  }) => {
    await openLanding(page);

    for (const model of ["gpt", "claude", "gemini"]) {
      await expect(
        page.getByTestId(`landing-editorial-model-${model}`)
      ).toBeVisible();
    }

    await expect(
      page.getByTestId("landing-editorial-review-items").locator("span")
    ).toHaveCount(4);
    await expect(page.getByTestId("landing-quick-summary-card")).toBeVisible();
  });

  test("renders the live provider catalogue as part of the homepage story", async ({
    page,
  }) => {
    await openLanding(page);

    const expectedCount = Number(
      await page
        .getByTestId("landing-evidence-section")
        .getAttribute("data-provider-count")
    );
    expect(expectedCount).toBeGreaterThan(0);
    await expect(
      page.getByTestId("landing-provider-list").locator("span")
    ).toHaveCount(expectedCount);
  });
});
