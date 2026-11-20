import { expect, test, type Page } from "@playwright/test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, INPUT_CREDIT_MULTIPLIERS, MODEL_USAGE_CREDIT_WEIGHTS } from "../../lib/models";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "../../lib/webSearchCredits";
import { prepareGuestPage } from "./support/app-fixtures";

// The V2 pricing page's credit calculator charges what a send is charged (tier weights and
// input multipliers from lib/models.ts, the flat web search surcharge from
// lib/webSearchCredits.ts), and the models dialog shows the catalogue's base credits.
const PLANS = [
  { id: "free", name: "Free", monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD", monthlyMessageLimit: 300, dailyMessageLimit: 30 },
  { id: "pro", name: "Pro", monthlyPriceCents: 1_500, annualPriceCents: 14_400, currency: "USD", monthlyMessageLimit: 3_000, dailyMessageLimit: 300 },
  { id: "max", name: "Max", monthlyPriceCents: 2_500, annualPriceCents: 24_000, currency: "USD", monthlyMessageLimit: 10_000, dailyMessageLimit: 0 },
];

async function open(page: Page, lang: "en" | "ko") {
  await prepareGuestPage(page, lang);
  await page.route("**/api/billing/config**", (route) => route.fulfill({ json: { plans: PLANS, creditPacks: [], featuredPromotion: null } }));
  await page.goto(`/pricing?lang=${lang}`);
  await expect(page.getByTestId("pricing-calculator")).toBeVisible({ timeout: 30_000 });
}

const perSend = (page: Page) => page.getByTestId("pricing-calc-per");
const result = (page: Page, plan: string) => page.getByTestId(`pricing-calc-result-${plan}`);

test("the calculator starts at one Standard model and divides each plan's credits by it", async ({ page }) => {
  await open(page, "en");
  await expect(perSend(page)).toHaveText(String(MODEL_USAGE_CREDIT_WEIGHTS.standard));
  for (const plan of PLANS) await expect(result(page, plan.id)).toContainText(`${plan.monthlyMessageLimit.toLocaleString("en-AU")} requests`);
});

test("model tiers, input length and web search add up as a send is charged", async ({ page }) => {
  await open(page, "en");
  await page.getByTestId("pricing-calc-tier-advanced").check();
  await page.getByTestId("pricing-calc-tier-premium").check();
  const weights = [MODEL_USAGE_CREDIT_WEIGHTS.standard, MODEL_USAGE_CREDIT_WEIGHTS.advanced, MODEL_USAGE_CREDIT_WEIGHTS.premium];
  await expect(perSend(page)).toHaveText(String(weights.reduce((sum, weight) => sum + weight, 0)));
  // The longest band: each model is multiplied and rounded up on its own.
  const top = INPUT_CREDIT_MULTIPLIERS[INPUT_CREDIT_MULTIPLIERS.length - 1].multiplier;
  await page.locator("#pricing-calc-ctx").fill(String(INPUT_CREDIT_MULTIPLIERS.length));
  const long = weights.reduce((sum, weight) => sum + Math.ceil(weight * top), 0);
  await expect(perSend(page)).toHaveText(String(long));
  // Web search: a flat surcharge per model, never multiplied by the input length.
  await page.getByTestId("pricing-calc-web").check();
  const total = long + WEB_SEARCH_SURCHARGE_CREDITS * 3;
  await expect(perSend(page)).toHaveText(String(total));
  await expect(result(page, "max")).toContainText(`${Math.floor(10_000 / total).toLocaleString("en-AU")} requests`);
  await expect(page.getByTestId("pricing-calc-breakdown")).toContainText("web search");
});

test("the last picked model tier cannot be unchecked", async ({ page }) => {
  await open(page, "en");
  const standard = page.getByTestId("pricing-calc-tier-standard");
  await standard.click();
  await expect(standard).toBeChecked();
  await expect(perSend(page)).toHaveText(String(MODEL_USAGE_CREDIT_WEIGHTS.standard));
});

test("the Korean calculator uses Korean units", async ({ page }) => {
  await open(page, "ko");
  await expect(result(page, "pro")).toContainText("3,000회");
  await expect(page.getByTestId("pricing-calculator")).toContainText("크레딧 계산기");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the models dialog shows the catalogue's base credits", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.route("**/api/billing/config**", (route) => route.fulfill({ json: { plans: PLANS, creditPacks: [], featuredPromotion: null } }));
  for (const weight of [2, 3]) {
    const model = { ...AVAILABLE_MODELS.find((item) => item.id === DEFAULT_MODEL_ID)!, creditWeight: weight };
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: [model] } }));
    await page.goto("/pricing?lang=en");
    await expect(page.getByTestId("pricing-models-pro")).toContainText("1 of 1");
    await page.getByTestId("pricing-models-pro").click();
    const item = page.getByTestId("pricing-models-dialog").locator(`[data-model-id="${model.id}"]`);
    await expect(item).toContainText(model.name);
    await expect(item.locator("b")).toHaveText(String(weight));
  }
});

test("an empty catalogue leaves the dialog without a model list or a capacity promise", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.route("**/api/billing/config**", (route) => route.fulfill({ json: { plans: PLANS, creditPacks: [], featuredPromotion: null } }));
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: [] } }));
  await page.goto("/pricing?lang=en");
  await expect(page.getByTestId("pricing-models-pro")).toContainText("0 of 0");
  await page.getByTestId("pricing-models-pro").click();
  await expect(page.getByTestId("pricing-models-dialog").locator("[data-model-id]")).toHaveCount(0);
});
