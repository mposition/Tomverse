import { expect, test } from "@playwright/test";
import { getPublicStatusCopy } from "../../lib/publicStatusCopy";

const english = getPublicStatusCopy("en");

test("English status query stays English despite another preferred browser language", async ({ request }) => {
  const response = await request.get("/status?lang=en", { headers: { "accept-language": "ko-KR" } });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<html\b[^>]*lang="en"/);
  expect(html).toContain('href="https://tomverse.app/status?lang=en"');
  expect(html).toContain(english.dataUnavailableHeadline);
  expect(html).toMatch(/hreflang="en"[^>]*href="https:\/\/tomverse\.app\/status\?lang=en"|href="https:\/\/tomverse\.app\/status\?lang=en"[^>]*hreflang="en"/i);
});

// The E2E environment deliberately points DATABASE_URL at an unreachable
// host (see playwright.config.ts), which makes this the real integration
// test for the "provider health data can't be loaded" fallback path
// (app/(site)/(application)/status/page.tsx's try/catch around
// getProviderHealthDashboard()) -- no mocking needed, the DB really is down.
test("status page never 500s when provider health data can't be loaded, and falls back to Unknown", async ({
  page,
}) => {
  const response = await page.goto("/status?lang=en");
  expect(response?.status()).toBeLessThan(500);

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
    /all monitored providers are operational/i
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(english.dataUnavailableHeadline);
  await expect(page.getByRole("heading", { level: 1 })).toHaveClass(/text-zinc-300/);

  await expect(
    page.getByText(
      english.dataUnavailable
    )
  ).toBeVisible();
});

test("status page never claims a provider is Operational without visible evidence", async ({
  page,
}) => {
  await page.goto("/status?lang=en");

  // With the DB unreachable, no provider rows render at all (an intentional,
  // honest empty state) rather than a fabricated list of green badges. The
  // "Operational" count tile (0) is still fine -- it's a category label, not
  // a claim about any specific provider -- so this scopes to the provider
  // list section rather than matching that label too.
  const providerSection = page.getByRole("heading", { name: english.providerTitle }).locator("..");
  await expect(providerSection.getByText(english.emptyUnavailable)).toBeVisible();
  await expect(providerSection.getByText(english.empty)).toHaveCount(0);
  await expect(providerSection.getByText(english.statuses.operational, { exact: true })).toHaveCount(0);
});

test("status page headline and timestamp are accessible and UTC-labeled", async ({ page }) => {
  await page.goto("/status?lang=en");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();

  // With no health data, the time describes page generation, not fabricated
  // monitoring freshness. It still uses a real UTC <time datetime> element.
  await expect(page.getByText(english.pageGeneratedAt, { exact: false })).toBeVisible();
  const dataAsOfTime = page.locator("time").first();
  await expect(dataAsOfTime).toBeVisible();
  await expect(dataAsOfTime).toHaveAttribute("datetime", /.+/);
  await expect(dataAsOfTime).toContainText("UTC");
});

// AUD-R001: with the DB unreachable, getScheduledJobsDashboard() also fails
// and is caught the same way getProviderHealthDashboard() is (see
// app/(site)/(application)/status/page.tsx) -- the page must show the single
// "data could not be loaded" notice, not also surface a contradictory
// "monitoring delayed" notice derived from the same missing data.
test("status page never shows a probe-scheduler-delay notice on top of the general data-unavailable notice", async ({
  page,
}) => {
  await page.goto("/status?lang=en");

  await expect(
    page.getByText(
      english.dataUnavailable
    )
  ).toBeVisible();
  await expect(page.getByText(/scheduled automatic checks/i)).toHaveCount(0);
});

test("status page fits a 320px mobile viewport with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/status?lang=en");

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, "no horizontal page overflow at 320px").toBeLessThanOrEqual(
    dimensions.viewport + 1
  );

  // The headline, the "Data as of" freshness badge, and the four
  // Operational/Degraded/Incident/Unknown count tiles must all stay
  // readable (not clipped or zero-width) at the narrowest supported width.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("time").first()).toBeVisible();
  for (const label of Object.values(english.statuses)) {
    const tile = page.getByText(label, { exact: true }).first();
    await expect(tile).toBeVisible();
    const box = await tile.boundingBox();
    expect(box, `${label} tile bounding box`).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  }
});

for (const language of ["ko", "fr"] as const) {
  test(`status query ${language} aligns server language, metadata and homepage return`, async ({ page }) => {
    const copy = getPublicStatusCopy(language);
    const response = await page.goto(`/status?lang=${language}`);
    expect(response?.status()).toBeLessThan(500);
    const serverHtml = await response!.text();
    expect(serverHtml).toMatch(new RegExp(`<html\\b[^>]*lang="${language}"`));
    expect(serverHtml).toMatch(new RegExp(`<main\\b[^>]*lang="${language}"`));
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page.locator("main[lang]")).toHaveAttribute("lang", language);
    await expect(page).toHaveTitle(new RegExp(copy.metadataTitle));
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", copy.metadataDescription);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", language === "ko" ? "ko_KR" : "fr_FR");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://tomverse.app/status?lang=${language}`);
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(8);
    await expect(page.locator(`link[rel="alternate"][hreflang="${language}"]`)).toHaveAttribute("href", `https://tomverse.app/status?lang=${language}`);
    await expect(page.getByRole("link", { name: copy.backHome })).toHaveAttribute("href", `/${language}`);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(copy.dataUnavailableHeadline);
    await expect(heading).toHaveClass(/text-zinc-300/);
    await expect(page.getByText(copy.dataUnavailable)).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.providerTitle }).locator("..").getByText(copy.emptyUnavailable)).toBeVisible();
  });
}
