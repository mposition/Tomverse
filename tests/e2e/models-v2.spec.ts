import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog, modelsCatalogFixture, modelsCatalogProviderCount } from "./support/models-catalog-fixture";

// The V2 models page: it lists the public catalogue, filters it on the client
// (provider, credit category, plan, feature, search), reads the credit ranges from
// the same data, and does not overflow a 320px phone.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/models", grade: "Apex", unit: ["credit", "credits"] },
  { lang: "ko", path: "/ko/models", grade: "에이펙스", unit: ["크레딧", "크레딧"] },
] as const;
const total = modelsCatalogFixture.length;
const countText = (lang: "en" | "ko", shown: number) =>
  modelsPageContent[lang].list.count.replace("{shown}", String(shown)).replace("{total}", String(total));

for (const { lang, path, grade, unit } of pages) {
  const copy = modelsPageContent[lang];

  test(`${lang} models page lists the catalogue and filters it`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await prepareGuestPage(page, lang);
    await mockModelsCatalog(page);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    const cards = page.locator("article[data-model-id]");
    const count = page.getByTestId("models-count");
    // The static fallback list is replaced by the catalogue's own models.
    await expect(count).toHaveText(countText(lang, total), { timeout: 30_000 });
    await expect(cards).toHaveCount(total);
    await expect(page.getByTestId("models-title")).toContainText(copy.hero.title[0].replace("{n}", String(modelsCatalogProviderCount)));

    // Every credit figure is the catalogue's weight.
    const opus = cards.filter({ has: page.getByRole("heading", { name: "Claude Opus 5.5", exact: true }) });
    await expect(opus.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `${copy.list.creditLabel}: 32 ${unit[1]}`);
    const luna = cards.filter({ has: page.getByRole("heading", { name: "GPT 6 Luna", exact: true }) });
    await expect(luna.getByTestId("model-page-credit-cost")).toHaveAttribute("aria-label", `${copy.list.creditLabel}: 1 ${unit[0]}`);
    await expect(cards.filter({ hasText: copy.list.tags.limited })).toHaveCount(1);

    const group = (name: string) => page.getByRole("group", { name, exact: true });
    const chip = (row: string, name: string) => group(row).getByRole("button", { name, exact: true });

    // Provider: one at a time, with the count updated for screen readers.
    const anthropic = chip(copy.list.rows.provider, "Anthropic");
    await expect(anthropic).toHaveAttribute("aria-pressed", "false");
    await anthropic.click();
    await expect(anthropic).toHaveAttribute("aria-pressed", "true");
    await expect(chip(copy.list.rows.provider, copy.list.all)).toHaveAttribute("aria-pressed", "false");
    await expect(cards).toHaveCount(2);
    await expect(count).toHaveText(countText(lang, 2));

    // Plan: access starts with this plan, so Anthropic has no Free-account model.
    await chip(copy.list.rows.plan, copy.list.plans.Free).click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText(copy.list.empty, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: copy.list.clear, exact: true }).click();
    await expect(cards).toHaveCount(total);
    await expect(page.getByRole("button", { name: copy.list.clear, exact: true })).toHaveCount(0);

    // Features combine: reasoning and 1 credit leave one model.
    await chip(copy.list.rows.feature, copy.list.features.reasoning).click();
    await expect(cards).toHaveCount(4);
    await chip(copy.list.rows.feature, copy.list.features.oneCredit).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "deepseek-v4-pro");
    await chip(copy.list.rows.feature, copy.list.features.reasoning).click();
    await chip(copy.list.rows.feature, copy.list.features.oneCredit).click();
    await chip(copy.list.rows.feature, copy.list.features.image).click();
    await expect(cards).toHaveCount(4);
    await page.getByRole("button", { name: copy.list.clear, exact: true }).click();

    // Credit category, from the catalogue's usage class.
    await chip(copy.list.rows.grade, grade).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-model-id", "claude-fable-5-2");
    await page.getByRole("button", { name: copy.list.clear, exact: true }).click();

    // Search matches a model name, a provider name and a model id, ignoring case and padding.
    const search = page.getByRole("searchbox", { name: copy.list.searchLabel });
    await search.fill("sonar");
    await expect(cards).toHaveCount(2);
    await search.fill("OPENAI");
    await expect(cards).toHaveAttribute("data-model-id", "gpt-6-luna");
    await search.fill("  claude-fable-5-2  ");
    await expect(cards).toHaveAttribute("data-model-id", "claude-fable-5-2");
    await search.fill("no such model");
    await expect(page.getByText(copy.list.empty, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: copy.list.clear, exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(count).toHaveText(countText(lang, total));
    await expectNoHorizontalOverflow(page);
  });

  test(`${lang} models page reads the credit ranges from the catalogue`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await prepareGuestPage(page, lang);
    await mockModelsCatalog(page);
    await page.goto(path);
    await expect(page.getByTestId("models-count")).toHaveText(countText(lang, total), { timeout: 30_000 });
    const bands = page.locator(".m-band");
    await expect(bands).toHaveCount(3);
    await expect(bands.nth(0)).toContainText("GPT 6 Luna, DeepSeek-V4 Pro");
    await expect(bands.nth(0).locator(".m-cr b")).toHaveText("1");
    await expect(bands.nth(1).locator(".m-cr b")).toHaveText("4");
    await expect(bands.nth(2).locator(".m-cr b")).toHaveText("20–80");
    const calc = page.getByRole("link", { name: new RegExp(copy.credits.calc) });
    await expect(calc).toHaveAttribute("href", `/${lang}/pricing#calc`);
    const status = page.getByTestId("models-status-link");
    await expect(status).toHaveAttribute("href", `/status?lang=${lang}`);
    await expect(status).toHaveAttribute("target", "_blank");
    await expect(status).toHaveAttribute("rel", /noopener/);
  });

  test(`${lang} models page keeps its filters usable on a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    await mockModelsCatalog(page);
    await page.goto(path);
    const cards = page.locator("article[data-model-id]");
    await expect(page.getByTestId("models-count")).toHaveText(countText(lang, total), { timeout: 30_000 });
    await expect(cards).toHaveCount(total);

    // The chip rows start collapsed; the search and the result count stay in view.
    const toggle = page.getByTestId("models-mobile-filters-toggle");
    const rows = page.locator("#models-catalog-filters");
    await expect(toggle).toHaveText(new RegExp(`^${copy.list.filtersToggle}`));
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rows).toBeHidden();
    await expect(page.getByRole("searchbox", { name: copy.list.searchLabel })).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(rows).toBeVisible();
    await rows.getByRole("button", { name: "Perplexity", exact: true }).click();
    await expect(cards).toHaveCount(2);
    await expectNoHorizontalOverflow(page);

    // The long name wraps inside its card, also with the browser's text size doubled.
    const long = cards.filter({ has: page.getByRole("heading", { name: "Perplexity Sonar Reasoning Pro", exact: true }) });
    await expect(long).toBeVisible();
    const box = (await long.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    await expectNoHorizontalOverflow(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await toggle.press("Enter");
    await expect(rows).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
}

test("models page stops its card motion for visitors who prefer reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareGuestPage(page, "en");
  await mockModelsCatalog(page);
  await page.goto("/models");
  await expect(page.getByTestId("models-count")).toHaveText(countText("en", total), { timeout: 30_000 });
  await expect(page.locator("article[data-model-id]").first()).toHaveCSS("animation-name", "none");
});
