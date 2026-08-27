import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The landing page's product evidence.
 *
 * This file used to test a demonstration built from styled divs: it played a
 * four-stage animation, held a complete state under reduced motion, and had
 * its own stage counter. That component is gone. It was the page's most
 * recognisable machine-generated tell, and it was the weaker argument anyway,
 * because a drawing of a product proves nothing about the product.
 *
 * What replaced it is two screenshots of the real interface, generated from
 * the deterministic chat fixtures by `tests/e2e/marketing-capture.spec.ts`.
 * So what needs guarding changed shape entirely: not "does the animation
 * reach stage 3" but "is the evidence actually on the page, does it describe
 * itself to a screen reader, does it reserve its own space, and does it still
 * disclose what it is".
 */

const openLanding = async (page: Page) => {
  await prepareGuestPage(page, "en");
  await page.goto("/");
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();
};

test.describe("landing product evidence", () => {
  test("shows the real comparison in the hero, with a described alt text", async ({
    page,
  }) => {
    await openLanding(page);

    const hero = page.locator(
      "section[aria-labelledby='landing-hero-title'] img"
    );
    await expect(hero).toHaveCount(1);
    await expect(hero).toBeVisible();

    const alt = await hero.getAttribute("alt");
    expect(alt, "the capture describes what it shows").toBeTruthy();
    // An alt that names the file, or says "screenshot", tells a screen-reader
    // user nothing about the product.
    expect(alt!.toLowerCase()).not.toContain("screenshot");
    expect(alt!.toLowerCase()).not.toContain(".webp");
    expect(alt!.length).toBeGreaterThan(30);

    // The old div mock-up is not allowed back.
    await expect(page.getByTestId("landing-hero-product-demo")).toHaveCount(0);
  });

  test("both captures reserve their space before they load", async ({ page }) => {
    // CLS: an intrinsic width/height pair on every capture is what stops the
    // sections below jumping when the bytes land. Without it the page would
    // reflow twice on a cold load, once per image.
    await openLanding(page);

    // `picture img` scopes this to the two ProductCapture elements. Plain
    // `main img` also caught the footer wordmark, which is a small decorative
    // logo rather than a capture and is not what this contract is about.
    const images = page.locator("main picture img");
    const count = await images.count();
    expect(count).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const image = images.nth(index);
      await expect(image).toHaveAttribute("width", /^\d+$/);
      await expect(image).toHaveAttribute("height", /^\d+$/);
    }
  });

  test("keeps the evidence disclosed as a product capture", async ({ page }) => {
    await openLanding(page);

    const disclosure = await page
      .getByTestId("landing-workflow-disclosure")
      .innerText();
    // It is a real capture now, so the old "illustrative diagram, not a
    // product recording" wording would be a false disclosure rather than a
    // cautious one.
    expect(disclosure).not.toMatch(/illustrative/i);
    expect(disclosure).toMatch(/no customer content/i);
    expect(disclosure).toMatch(/endorsement/i);
  });

  test("keeps the product evidence inside a 320px mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openLanding(page);

    const box = await page
      .locator("section[aria-labelledby='landing-hero-title'] img")
      .boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(scrollWidth).toBeLessThanOrEqual(320);
  });

  test("tells the comparison story once, not four times", async ({ page }) => {
    // The defect this redesign exists to remove: V1 played the sequence in
    // the hero, then repeated it as a three-column model row, then again as a
    // workflow diagram, then again as a numbered step list.
    await openLanding(page);

    await expect(page.getByTestId("landing-loop-section")).toBeVisible();
    await expect(page.getByTestId("landing-review-anatomy")).toBeVisible();
    await expect(page.getByTestId("landing-quick-summary-card")).toBeVisible();

    for (const model of ["gpt", "claude", "gemini"]) {
      await expect(
        page.getByTestId(`landing-editorial-model-${model}`)
      ).toHaveCount(0);
      await expect(
        page.getByTestId(`landing-hero-demo-model-${model}`)
      ).toHaveCount(0);
    }
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
