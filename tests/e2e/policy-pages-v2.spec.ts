import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { en } from "../../locales/en";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { PROVIDER_DATA_DESTINATIONS } from "@/lib/providerDataDestinations";

// The V2 policy pages: they load, fit a 320px phone without any clause running
// off screen, jump to a clause from the contents, search the provider table, and
// print every itemized notice exactly as the locale text says it.
test.setTimeout(90_000);

const PAGES = [
  { path: "/safety?lang=en", testId: "policy-page-safety", title: infoPages.safety.en.title },
  { path: "/ko/safety", testId: "policy-page-safety", title: infoPages.safety.ko.title, lang: "ko" as const },
  { path: "/privacy?lang=en", testId: "policy-page-privacy", title: en.privacyPolicy.title },
  { path: "/terms?lang=en", testId: "policy-page-terms", title: infoPages.terms.en.title },
  { path: "/refund?lang=en", testId: "policy-page-refund", title: infoPages.refund.en.title },
];

/** Text of the page that ends past the right edge of the viewport. */
const offscreenText = (page: Page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  return Array.from(document.querySelectorAll("main :is(p, li, h1, h2, h3, dt, dd, a, b, strong, small)"))
    .filter((node) => !node.closest("[role='region']") && !node.closest(".sr-only"))
    .map((node) => ({ text: (node.textContent ?? "").trim().slice(0, 50), right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width }))
    .filter((box) => box.width > 0 && box.right > width + 1);
});

for (const { path, testId, title, lang } of PAGES) {
  test(`${path} opens and fits a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang ?? "en");
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("policy-title")).toHaveText(title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await offscreenText(page)).toEqual([]);
  });
}

test("terms contents jump to the clause and mark it current", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/terms?lang=en");
  const clause = infoPages.terms.en.sections[6];
  const contents = page.getByRole("complementary").getByRole("navigation");
  const link = contents.getByRole("link", { name: clause.title, exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(page).toHaveURL(/#section-7$/);
  await expect(page.getByRole("heading", { name: clause.title, exact: true })).toBeInViewport();
  await expect(link).toHaveAttribute("aria-current", "true");
});

test("on a phone the jump list folds and still jumps", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await prepareGuestPage(page, "en");
  await page.goto("/refund?lang=en");
  const fold = page.locator("details.toc-fold");
  await expect(fold).toBeVisible({ timeout: 30_000 });
  await fold.locator("summary").click();
  const clause = infoPages.refund.en.sections[4];
  await fold.getByRole("link", { name: clause.title, exact: true }).click();
  await expect(page).toHaveURL(/#section-5$/);
  await expect(page.getByRole("heading", { name: clause.title, exact: true })).toBeInViewport();
});

test("the provider table can be searched without changing its rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/privacy?lang=en");
  const table = page.getByRole("region", { name: en.privacyPolicy.providerTableTitle });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(PROVIDER_DATA_DESTINATIONS.length, { timeout: 30_000 });
  const search = page.getByTestId("privacy-provider-search");
  await expect(search).toHaveAccessibleName("Find a provider");

  await search.fill("anthropic");
  const visible = rows.filter({ visible: true });
  await expect(visible).not.toHaveCount(0);
  expect(await visible.count()).toBeLessThan(PROVIDER_DATA_DESTINATIONS.length);
  for (const text of await visible.allTextContents()) expect(text.toLowerCase()).toContain("anthropic");

  await search.fill("no provider is called this");
  await expect(visible).toHaveCount(0);
  await expect(page.getByText("No provider in the table matches.")).toBeVisible();

  await search.fill("");
  await expect(visible).toHaveCount(PROVIDER_DATA_DESTINATIONS.length);
});

test("itemized notices read exactly as the locale text", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/privacy?lang=en");
  const notice = page.locator(".legal-dl").filter({ has: page.getByRole("heading", { name: en.privacyPolicy.providerTransferTitle, exact: true }) });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const expected = [1, 2, 3, 4, 5, 6, 7].map((n) => en.privacyPolicy[`providerTransfer${n}` as keyof typeof en.privacyPolicy] as string);
  expect(await notice.locator("li").allTextContents()).toEqual(expected);
});

test("policy page motion can be paused, and is still when reduced motion is preferred", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/safety?lang=en");
  const root = page.getByTestId("policy-page-safety");
  const toggle = page.getByTestId("policy-motion-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: 30_000 });
  await expect(root).toHaveAttribute("data-motion", "running");
  await toggle.click();
  await expect(root).toHaveAttribute("data-motion", "paused");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/terms?lang=en");
  await expect(page.getByTestId("policy-page-terms")).toHaveAttribute("data-motion", "paused", { timeout: 30_000 });
  await expect(page.getByTestId("policy-motion-toggle")).toHaveCount(0);
});
