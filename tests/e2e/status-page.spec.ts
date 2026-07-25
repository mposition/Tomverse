import { expect, test } from "@playwright/test";

// The E2E environment deliberately points DATABASE_URL at an unreachable
// host (see playwright.config.ts), which makes this the real integration
// test for the "provider health data can't be loaded" fallback path
// (app/(application)/status/page.tsx's try/catch around
// getProviderHealthDashboard()) -- no mocking needed, the DB really is down.
test("status page never 500s when provider health data can't be loaded, and falls back to Unknown", async ({
  page,
}) => {
  const response = await page.goto("/status");
  expect(response?.status()).toBeLessThan(500);

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
    /all monitored providers are operational/i
  );

  await expect(
    page.getByText(
      "Provider health data could not be loaded right now, so every provider below is shown as Unknown rather than guessed at."
    )
  ).toBeVisible();
});

test("status page never claims a provider is Operational without visible evidence", async ({
  page,
}) => {
  await page.goto("/status");

  // With the DB unreachable, no provider rows render at all (an intentional,
  // honest empty state) rather than a fabricated list of green badges. The
  // "Operational" count tile (0) is still fine -- it's a category label, not
  // a claim about any specific provider -- so this scopes to the provider
  // list section rather than matching that label too.
  const providerSection = page.getByRole("heading", { name: "Provider Status" }).locator("..");
  await expect(providerSection.getByText(/No providers are currently monitored\./)).toBeVisible();
  await expect(providerSection.getByText("Operational", { exact: true })).toHaveCount(0);
});

test("status page headline and timestamp are accessible and UTC-labeled", async ({ page }) => {
  await page.goto("/status");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();

  // "Data as of" uses a real <time datetime> element, not just plain text.
  const dataAsOfTime = page.locator("time").first();
  await expect(dataAsOfTime).toBeVisible();
  await expect(dataAsOfTime).toHaveAttribute("datetime", /.+/);
  await expect(dataAsOfTime).toContainText("UTC");
});
