import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { layoutBox } from "./support/engine-capabilities";
import { reviewPageContent } from "@/components/marketing/v2/review/reviewPageContent";

/**
 * The answer comparison page's product evidence (/products/review, V2).
 *
 * This file used to test the old landing's hero: two product screenshots built
 * by `marketing-capture.spec.ts`, with alt texts, intrinsic sizes and a
 * disclosure under them. V2 shows the real interface as one recorded demo in a
 * browser frame instead (public/marketing/v2/review-demo.mp4), so what needs
 * guarding is the same set of questions in the new shape: is the evidence on the
 * page, does it describe itself to a screen reader, does it reserve its own space,
 * does it stop when the visitor asks, and does it still disclose what it is.
 */

const openReview = async (page: Page) => {
  await prepareGuestPage(page, "en");
  await page.goto("/products/review");
  await expect(page.getByTestId("review-product-title")).toBeVisible();
};

const demo = (page: Page) => page.locator("figure.demo-frame video");

test.describe("answer comparison product evidence", () => {
  test("shows the real recording, with a described label and a poster", async ({ page }) => {
    await openReview(page);

    await expect(demo(page)).toHaveCount(1);
    await expect(demo(page)).toBeVisible();

    const label = await demo(page).getAttribute("aria-label");
    expect(label, "the recording describes what it shows").toBe(reviewPageContent.en.demo.videoLabel);
    // A label that names the file, or says "screenshot", tells a screen-reader
    // user nothing about the product.
    expect(label!.toLowerCase()).not.toContain("screenshot");
    expect(label!.toLowerCase()).not.toContain(".mp4");
    expect(label!.length).toBeGreaterThan(30);
    await expect(demo(page)).toHaveAttribute("poster", "/marketing/v2/review-demo.jpg");

    // The old div mock-up and the old hero captures are not allowed back.
    await expect(page.getByTestId("landing-hero-product-demo")).toHaveCount(0);
    await expect(page.locator("main picture")).toHaveCount(0);
  });

  test("the recording reserves its space before it loads", async ({ page }) => {
    // CLS: an intrinsic aspect ratio on the recording is what stops the sections
    // below jumping when the bytes land.
    await openReview(page);

    const box = await layoutBox(demo(page));
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(box.width / 2);
    const ratio = await demo(page).evaluate((video) => getComputedStyle(video).aspectRatio);
    expect(ratio.replace(/\s/g, "")).toBe("1440/900");
  });

  test("keeps the evidence disclosed as a recording with demonstration data", async ({ page }) => {
    await openReview(page);

    const disclosure = await page.getByTestId("review-demo-caption").innerText();
    // It is a real recording of the current interface, so the old "illustrative
    // diagram" wording would be a false disclosure rather than a cautious one.
    expect(disclosure).not.toMatch(/illustrative/i);
    expect(disclosure).toMatch(/demonstration data/i);
    expect(disclosure).toMatch(/no customer content/i);
    expect(disclosure).toMatch(/endorsement/i);
  });

  test("keeps the product evidence inside a 320px mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openReview(page);

    await expect(demo(page)).toBeVisible();
    const box = await layoutBox(demo(page));
    expect(box.width).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(321);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(320);
  });

  test("tells the comparison story once, not four times", async ({ page }) => {
    // The defect the redesign exists to remove: V1 played the sequence in the
    // hero, then repeated it as a model row, a workflow diagram and a step list.
    // V2 has the recording once and the three steps once, and the example screens
    // below them each show something the steps do not.
    await openReview(page);

    await expect(page.locator("figure.demo-frame")).toHaveCount(1);
    await expect(page.locator("#how .step")).toHaveCount(3);
    await expect(page.locator("#modes")).toBeVisible();
    await expect(page.locator("#lens")).toBeVisible();

    for (const model of ["gpt", "claude", "gemini"]) {
      await expect(page.getByTestId(`landing-editorial-model-${model}`)).toHaveCount(0);
      await expect(page.getByTestId(`landing-hero-demo-model-${model}`)).toHaveCount(0);
    }
  });

  test("stops the recording from the hero's pause button", async ({ page }) => {
    await openReview(page);

    await page.getByTestId("launch-motion-toggle").click();
    await expect.poll(() => demo(page).evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);
    await page.getByTestId("launch-motion-toggle").click();
    await expect(page.getByTestId("review-product-page")).toHaveAttribute("data-motion", "running");
  });

  test("renders the provider picker as part of the page's story", async ({ page }) => {
    await openReview(page);

    const cells = page.locator("#providers .prov-cell");
    await expect(cells).toHaveCount(12);
    // Each provider is named in text, so the picker does not depend on its logos.
    for (const name of ["OpenAI", "Anthropic", "Google", "xAI", "MiniMax"]) {
      await expect(page.locator("#providers").getByText(name, { exact: true })).toBeVisible();
    }
  });
});
