import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getModelBrand } from "../lib/modelBranding.ts";

const providersWithLogos = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "deepseek",
  "mistral",
  "xai",
  "qwen",
  "perplexity",
  "zhipu",
  "moonshot",
  "cohere",
];

test("every provider logo points at a file in public/", () => {
  for (const provider of providersWithLogos) {
    const brand = getModelBrand(provider);
    assert.ok(brand.image, `${provider} has no logo`);
    const file = path.join(process.cwd(), "public", brand.image);
    assert.ok(existsSync(file), `${provider} logo ${brand.image} is missing`);
  }
});

test("Cohere models show the Cohere logo, not a letter mark", () => {
  assert.equal(getModelBrand("cohere").image, "/model-icons/cohere.png");
});
