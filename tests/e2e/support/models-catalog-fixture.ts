import type { Page } from "@playwright/test";

type FixtureModel = {
  id: string;
  name: string;
  provider: string;
  minimumPlan: "Guest" | "Free" | "Pro";
  usageClass: string;
  creditWeight: number;
  reasoning: "none" | "high";
  image: boolean;
  status?: "enabled" | "limited";
};

const model = (spec: FixtureModel) => ({
  id: spec.id,
  name: spec.name,
  apiModel: spec.id,
  provider: spec.provider,
  icon: "",
  bestFor: "",
  minimumPlan: spec.minimumPlan,
  usageClass: spec.usageClass,
  creditWeight: spec.creditWeight,
  enabled: true,
  status: spec.status ?? "enabled",
  publiclyListed: true,
  catalogDeleted: false,
  reasoning: spec.reasoning,
  contextWindowTokens: 1_000_000,
  inputCapabilities: { image: spec.image, nativePdf: false },
});

/**
 * A small public catalogue that covers every filter of the V2 models page: five
 * providers, three plans, four credit categories, image input on and off,
 * reasoning on and off, one limited model and one long model name.
 */
export const modelsCatalogFixture = [
  model({ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", usageClass: "standard", creditWeight: 1, reasoning: "none", image: true }),
  model({ id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", minimumPlan: "Pro", usageClass: "frontier", creditWeight: 32, reasoning: "high", image: true }),
  model({ id: "claude-fable-5-2", name: "Claude Fable 5.2", provider: "anthropic", minimumPlan: "Pro", usageClass: "apex", creditWeight: 80, reasoning: "high", image: true }),
  model({ id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", provider: "deepseek", minimumPlan: "Free", usageClass: "standard", creditWeight: 1, reasoning: "high", image: false }),
  model({ id: "mistral-medium-3-5", name: "Mistral Medium 3.5", provider: "mistral", minimumPlan: "Free", usageClass: "advanced", creditWeight: 4, reasoning: "none", image: true, status: "limited" }),
  model({ id: "perplexity-sonar", name: "Perplexity Sonar", provider: "perplexity", minimumPlan: "Free", usageClass: "research", creditWeight: 20, reasoning: "none", image: false }),
  model({ id: "perplexity-sonar-reasoning-pro", name: "Perplexity Sonar Reasoning Pro", provider: "perplexity", minimumPlan: "Pro", usageClass: "research", creditWeight: 20, reasoning: "high", image: false }),
];

export const modelsCatalogProviderCount = new Set(modelsCatalogFixture.map((item) => item.provider)).size;

/** Serves `models` as the public catalogue, which is the only place the page reads models from. */
export async function mockModelsCatalog(page: Page, models: readonly object[] = modelsCatalogFixture) {
  await page.route("**/api/models/catalog**", (route) => route.fulfill({ json: { models } }));
}
