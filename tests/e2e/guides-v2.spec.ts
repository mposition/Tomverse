import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { SEARCH_INTENT_SLUGS, searchIntentPages } from "@/components/marketing/searchIntentContent";
import { guidesUiCopy } from "@/components/marketing/v2/guides/guidesUiCopy";

// The four usage guides on the shared V2 template: they open with their live title,
// do not overflow a 320px phone, tab between each other, and the before/after demo of
// the answer review guide switches, rotates on its own and stops on request.
test.setTimeout(90_000);

const languages = [
  { lang: "en", prefix: "" },
  { lang: "ko", prefix: "/ko" },
] as const;

for (const slug of SEARCH_INTENT_SLUGS) {
  for (const { lang, prefix } of languages) {
    const path = `${prefix}/${slug}`;
    const copy = searchIntentPages[slug][lang];

    test(`${path} opens with its live title and the guide tabs`, async ({ page }) => {
      await prepareGuestPage(page, lang);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("guide-page")).toHaveAttribute("data-guide", slug);
      await expect(page.getByTestId("guide-page")).toHaveAttribute("lang", lang);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(copy.title);
      const tabs = page.getByRole("main").getByRole("navigation", { name: guidesUiCopy[lang].guides });
      await expect(tabs.getByRole("link")).toHaveCount(SEARCH_INTENT_SLUGS.length);
      await expect(tabs.locator('[aria-current="page"]')).toHaveText(guidesUiCopy[lang].tabs[slug]);
      // The start link of the introduction and of the closing band lead to the same place.
      await expect(page.getByTestId("marketing-info-intro-cta")).toBeVisible();
    });

    test(`${path} does not overflow a 320px phone`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      await prepareGuestPage(page, lang);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.locator("main > section:last-of-type").scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
    });
  }
}

test("the guide tabs lead to the other guides in the visitor's language", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/compare-ai-models");
  const tabs = page.getByRole("main").getByRole("navigation", { name: guidesUiCopy.ko.guides });
  await expect(tabs.getByRole("link", { name: guidesUiCopy.ko.tabs["ai-answer-review"] })).toHaveAttribute("href", "/ko/ai-answer-review");
  await tabs.getByRole("link", { name: guidesUiCopy.ko.tabs["ai-for-file-analysis"] }).click();
  await expect(page).toHaveURL(/\/ko\/ai-for-file-analysis$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(searchIntentPages["ai-for-file-analysis"].ko.title);
});

test("the answer review demo switches by hand, rotates every 6 seconds and stops on request", async ({ page }) => {
  await page.clock.install();
  await prepareGuestPage(page, "en");
  await page.goto("/ai-answer-review");
  const demo = page.getByTestId("guide-before-after");
  const before = demo.getByRole("button", { name: "Before", exact: true });
  const after = demo.getByRole("button", { name: "After", exact: true });
  await expect(demo).toHaveAttribute("data-view", "before");
  await expect(before).toHaveAttribute("aria-pressed", "true");
  await expect(demo.getByText("Common ground", { exact: true })).toBeHidden();

  // It rotates on its own after 6 seconds.
  await page.clock.fastForward(6100);
  await expect(demo).toHaveAttribute("data-view", "after");
  await expect(demo.getByText("Common ground", { exact: true })).toBeVisible();
  await expect(after).toHaveAttribute("aria-pressed", "true");

  // The pause button stops the rotation.
  const toggle = page.getByTestId("guide-motion-toggle");
  await toggle.click();
  await expect(page.getByTestId("guide-page")).toHaveAttribute("data-motion", "paused");
  await page.clock.fastForward(13_000);
  await expect(demo).toHaveAttribute("data-view", "after");

  // Both views stay reachable by hand, and a choice ends the rotation for good.
  await before.click();
  await expect(demo).toHaveAttribute("data-view", "before");
  await toggle.click();
  await expect(page.getByTestId("guide-page")).toHaveAttribute("data-motion", "running");
  await page.clock.fastForward(13_000);
  await expect(demo).toHaveAttribute("data-view", "before");
});

test("a visitor who prefers reduced motion gets no rotation and no pause button", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await prepareGuestPage(page, "en");
  await page.goto("/ai-answer-review");
  const demo = page.getByTestId("guide-before-after");
  await expect(page.getByTestId("guide-page")).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("guide-motion-toggle")).toHaveCount(0);
  await page.clock.fastForward(13_000);
  await expect(demo).toHaveAttribute("data-view", "before");
  await demo.getByRole("button", { name: "After", exact: true }).click();
  await expect(demo).toHaveAttribute("data-view", "after");
});

test("the model comparison keeps its prepared comparison and the model pair of the reference list", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/chatgpt-vs-claude");
  const prepared = page.locator('a[href*="source"][href*="chatgpt-vs-claude"]');
  await expect(prepared).toHaveCount(1);
  const href = decodeURIComponent((await prepared.getAttribute("href"))!);
  expect(href).toContain("models=");
  await expect(page.getByTestId("comparison-task-table").getByRole("columnheader")).toHaveCount(4);
  await expect(page.getByTestId("guide-fact-pair").locator(".fact").first()).toBeVisible();
});

test("the file analysis illustration lists the extracted items with their source sentence", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/ai-for-file-analysis");
  const illustration = page.getByTestId("guide-file-extraction");
  await illustration.scrollIntoViewIfNeeded();
  await expect(illustration.getByRole("term")).toHaveCount(4);
  await expect(illustration.getByRole("definition").first()).toContainText("7 November at 2 pm");
});
