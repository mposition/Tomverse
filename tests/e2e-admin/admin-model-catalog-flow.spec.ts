import { adminFixtureDatabase } from "./support/database";
import { expect, test } from "./support/console";

/**
 * The image catalogue's guided flow: a model that needs its details fixed and
 * a model whose price draft is ready, shown as one next step each, then the
 * price check with editable credits and the apply. The draft is seeded rather
 * than requested, so no paid LLM call runs here.
 */

const QWEN = "qwen-image-2.0";
const SOURCE = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

const seedCatalog = async () => {
  const database = adminFixtureDatabase();
  await database.modelCatalogEntry.create({
    data: { category: "image", modelId: "gemini-nano-banana-2.1", profile: { provider: "google" } },
  });
  await database.modelCatalogEntry.create({
    data: {
      category: "image",
      modelId: QWEN,
      profile: {
        provider: "qwen",
        apiModelId: QWEN,
        name: "Qwen Image 2.0",
        lifecycle: "preview",
        sizes: ["1024x1024", "1536x1024"],
        qualities: ["low", "high"],
        latencyClass: "balanced",
        provenance: [],
        outputMimeTypes: ["image/png"],
      },
      // Credits well above any floor, so the test controls which cell is short.
      draft: {
        pricingVersion: "qwen-image-2.0-2026-11-12-llm",
        prices: [
          { quality: "low", size: "1024x1024", credits: 200, outputCostMicroUsd: 20_000 },
          { quality: "low", size: "1536x1024", credits: 200, outputCostMicroUsd: 30_000 },
          { quality: "high", size: "1024x1024", credits: 300, outputCostMicroUsd: 60_000 },
          { quality: "high", size: "1536x1024", credits: 300, outputCostMicroUsd: 90_000 },
        ],
        verification: { verifiedAt: "2026-11-12", sources: [SOURCE], thinkingCapMicroUsd: 0 },
      },
      draftSource: "llm",
      draftCreatedAt: new Date(),
    },
  });
};

const CODER = "gpt-coding-flow-e2e";

// A coding draft as the LLM path stores it (codingDraftFromAnswer), with
// OpenAI's own pages so the judge's source checks pass.
const codingDraft = {
  name: "Flow Test Coder",
  provider: "openai",
  apiModelId: CODER,
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 200_000, maxOutputTokens: 32_000 },
  pricing: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 8,
    creditWeight: 4,
    verifiedAt: "2026-11-12",
    sources: [
      "https://developers.openai.com/api/docs/pricing",
      "https://openai.com/policies/services-agreement",
      "https://platform.openai.com/docs/guides/your-data",
    ],
  },
  terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/policies/services-agreement", checkedAt: "2026-11-12" },
  retention: { url: "https://platform.openai.com/docs/guides/your-data", checkedAt: "2026-11-12" },
  processingRegion: "US",
};

test.describe("coding model catalogue flow", () => {
  test.beforeEach(async ({ signInAs }) => {
    await adminFixtureDatabase().modelCatalogEntry.create({
      data: { category: "coding", modelId: CODER, draft: codingDraft, draftSource: "llm", draftCreatedAt: new Date() },
    });
    await signInAs("owner");
  });

  test("a coding draft is checked as a field table, applied with the operator's weight, then turned on after a confirmation", async ({ page }) => {
    await page.goto("/admin/models?tab=catalog");
    // No profile JSON to type anywhere on the screen.
    await expect(page.getByText("Profile (JSON)")).toHaveCount(0);

    const card = page.getByTestId("model-catalog-pending-coding").filter({ hasText: CODER });
    await expect(card).toHaveAttribute("data-stage", "draft_ready");
    await card.getByRole("button", { name: "Check profile" }).click();

    const detail = page.getByTestId("model-catalog-coding-detail");
    await expect(detail).toBeVisible();
    const profile = detail.getByTestId("model-catalog-coding-profile");
    // Prices and evidence are read, not typed.
    await expect(profile.getByText("$8", { exact: true })).toBeVisible();
    // The terms page is also one of the pages the draft read, so it is listed twice.
    await expect(detail.getByRole("link", { name: /openai\.com\/policies\/services-agreement/ })).toHaveCount(2);
    await expect(detail.getByRole("link", { name: /platform\.openai\.com\/docs\/guides\/your-data/ }).first()).toBeVisible();
    await expect(detail.getByText("Allows resale and coding agents")).toBeVisible();

    const weight = detail.getByTestId("model-catalog-coding-weight");
    const apply = detail.getByTestId("model-catalog-coding-apply");
    await weight.fill("1");
    await expect(apply).toBeDisabled();
    await expect(detail.getByText("Fix the marked fields to apply.")).toBeVisible();
    await weight.fill("9");
    await detail.getByTestId("model-catalog-coding-name").fill("Flow Coder");
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(page.getByTestId("model-catalog-toast")).toContainText("Applied the profile for Flow Coder.");
    const key = { category_modelId: { category: "coding", modelId: CODER } };
    const applied = await adminFixtureDatabase().modelCatalogEntry.findUniqueOrThrow({ where: key });
    expect(applied.draft).toBeNull();
    expect(applied.enabled).toBeNull();
    expect((applied.profile as { name: string; pricing: { creditWeight: number } }).pricing.creditWeight).toBe(9);
    expect((applied.profile as { name: string }).name).toBe("Flow Coder");

    await expect(detail).toHaveAttribute("data-stage", "ready_to_enable");
    await detail.getByRole("button", { name: "Turn on", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Turn on Flow Coder?" });
    await expect(dialog).toContainText("from the Pro plan");
    await expect(dialog).toContainText("weight 9");
    await dialog.getByRole("button", { name: /Turn on/ }).click();

    await expect(page.getByTestId("model-catalog-toast")).toContainText("Flow Coder is on.");
    expect((await adminFixtureDatabase().modelCatalogEntry.findUniqueOrThrow({ where: key })).enabled).toBe(true);
    await expect(detail).toHaveAttribute("data-stage", "serving");
  });
});

test.describe("image model catalogue flow", () => {
  test.beforeEach(async ({ signInAs }) => {
    await seedCatalog();
    await signInAs("owner");
  });

  test("waiting models show one next step each, in words, and a checked draft applies with the edited credits", async ({ page }) => {
    await page.goto("/admin/models?tab=catalog");

    const pending = page.getByTestId("model-catalog-pending-image");
    await expect(pending).toHaveCount(2);
    const gemini = pending.filter({ hasText: "gemini-nano-banana-2.1" });
    await expect(gemini).toHaveAttribute("data-stage", "profile_invalid");
    await expect(gemini.getByRole("button", { name: "Fix model details" })).toBeVisible();
    await expect(page.getByText("invalid_full_profile")).toHaveCount(0);

    const qwen = pending.filter({ hasText: QWEN });
    await expect(qwen).toHaveAttribute("data-stage", "draft_ready");
    await qwen.getByRole("button", { name: "Check prices" }).click();

    const detail = page.getByTestId("model-catalog-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("model-catalog-price-table")).toBeVisible();
    // The table (wide) and the card list (narrow) carry the same cells; the wide one shows here.
    await expect(detail.getByTestId("model-catalog-price-table").getByText("$0.090")).toBeVisible();
    await expect(detail.getByRole("link", { name: /alibabacloud\.com/ })).toBeVisible();

    const cell = detail.getByTestId("model-catalog-price-table").getByTestId("model-catalog-credits-high|1536x1024");
    const apply = detail.getByTestId("model-catalog-apply");
    await cell.fill("1");
    await expect(apply).toBeDisabled();
    await expect(detail.getByText("Fix 1 cell to apply.")).toBeVisible();
    await cell.fill("320");
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(page.getByTestId("model-catalog-toast")).toContainText("Applied the prices for Qwen Image 2.0.");
    const revision = await adminFixtureDatabase().modelCatalogPriceRevision.findFirstOrThrow({
      where: { category: "image", modelId: QWEN },
    });
    expect(revision.pricingVersion).toBe("qwen-image-2.0-2026-11-12-llm");
    expect((revision.prices as { quality: string; size: string; credits: number }[]).find((p) => p.quality === "high" && p.size === "1536x1024")?.credits).toBe(320);
    // The draft is consumed and the model is on the turn-on step: ready, or
    // waiting only for a provider budget (none is set in this harness), and
    // never told to make a new draft for a missing budget.
    await expect(detail).toHaveAttribute("data-stage", /ready_to_enable|needs_budget/);
    await expect(detail.getByRole("button", { name: "Make a new draft" })).toHaveCount(0);
  });
});
