import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { pricingPageContent } from "@/components/marketing/v2/pricing/pricingPageContent";

// The V2 pricing page: it loads in every URL form, keeps the /pricing#calc anchor the chat
// page links to, can be paused, and does not overflow a 320px phone in any language.
test.setTimeout(90_000);

const pages = [
  { lang: "en", path: "/pricing" },
  { lang: "ko", path: "/ko/pricing" },
] as const;

for (const { lang, path } of pages) {
  test(`${lang} pricing page opens, keeps its anchors and fits 320px`, async ({ page }) => {
    const copy = pricingPageContent[lang];
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId("pricing-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId("pricing-title")).toContainText(copy.hero.title[0]);
    // The chat page links to /pricing#calc.
    await expect(page.locator("#calc")).toHaveCount(1);
    for (const id of ["calc", "top"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
    for (const plan of ["free", "pro", "max"]) await expect(page.getByTestId(`pricing-plan-card-${plan}`)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const lang of ["zh", "zh-Hant", "fr", "de", "es", "pt"] as const) {
  test(`${lang} pricing page opens and fits 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    const response = await page.goto(`/${lang}/pricing`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("pricing-title")).toContainText(pricingPageContent[lang].hero.title[0], { timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("the hero's calculator link lands on the calculator", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/pricing");
  await page.getByRole("link", { name: /Calculate my usage/ }).click();
  await expect(page).toHaveURL(/#calc$/);
  await expect(page.getByTestId("pricing-calculator")).toBeInViewport();
});

test("/pricing#calc opens at the calculator", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/pricing#calc");
  await expect(page.getByTestId("pricing-calculator")).toBeInViewport({ timeout: 30_000 });
});

test("pricing page pauses its motion from the hero button", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/pricing");
  const root = page.getByTestId("pricing-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId("pricing-motion-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-motion", "running");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(root).toHaveAttribute("data-motion", "paused");
});

test("pricing page shows a still page when the visitor prefers reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/pricing");
  const root = page.getByTestId("pricing-page");
  await expect(root).toBeVisible({ timeout: 30_000 });
  await expect(root).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("pricing-motion-toggle")).toHaveCount(0);
});

test("the plan models dialog keeps focus away from the page behind it, and closes with Escape and its button", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/pricing");
  const trigger = page.getByTestId("pricing-models-free");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /models you can use/ });
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press("Tab");
    // A modal <dialog> makes the page behind it inert: focus is in the dialog, or has left the
    // document for the browser's own controls (then the active element is the body).
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      return !active || active === document.body ? "browser" : active.closest("dialog") ? "dialog" : "page";
    });
    expect(where, `focus reached the page behind the dialog after ${step + 1} tabs`).not.toBe("page");
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByTestId("pricing-models-dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("pricing-models-dialog")).toHaveCount(0);
});

test("the comparison table's model lists open the same dialog", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/pricing");
  await page.getByTestId("pricing-models-table-pro").click();
  await expect(page.getByTestId("pricing-models-dialog")).toContainText("Pro");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pricing-models-table-pro")).toBeFocused();
});

test("the page sends no checkout request by itself", async ({ page }) => {
  let checkouts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/billing/")) checkouts++; });
  await prepareGuestPage(page, "en");
  await page.goto("/pricing");
  await page.getByTestId("pricing-models-pro").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("pricing-calc-web").check();
  expect(checkouts).toBe(0);
});
