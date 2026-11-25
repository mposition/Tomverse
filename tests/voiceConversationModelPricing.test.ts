import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openAiLiveModelsAtPublishedRate, openAiLiveMinuteRate } from "@/lib/providerModelDocsCore";

test("both generations of OpenAI's pricing table supply the same tariff only inside the Live section", () => {
  const archived = readFileSync(new URL("./fixtures/providerModelDocs/openai-pricing-2026-09-13.md", import.meta.url), "utf8");
  assert.deepEqual(openAiLiveModelsAtPublishedRate(archived, 50_000), ["gpt-live-1"]);
  const header = "| Model | Active rate | Standby rate |\n| --- | --- | --- |";
  const before = header + "\n| gpt-live-9 | $0.05 / minute | $0.02 / minute |";
  const live = header + "\n| gpt-live-1.1 | $0.05 / minute | $0.02 / minute |";
  const pricing = [before, "GPT-Live", "### Pricing Table data", live].join("\n\n");
  assert.deepEqual(openAiLiveModelsAtPublishedRate(pricing, 50_000), ["gpt-live-1.1"]);
  assert.deepEqual(openAiLiveModelsAtPublishedRate(pricing, 80_000), []);
  assert.equal(openAiLiveModelsAtPublishedRate(before, 50_000), null);
  assert.equal(openAiLiveModelsAtPublishedRate("GPT-Live\n\nOther models\n\n" + live, 50_000), null);
  assert.equal(openAiLiveModelsAtPublishedRate(pricing + "\n\nA new introductory rate applies.", 50_000), null);
  const reviewed = "GPT-5.6 Sol’s promotional pricing is available until November 30, 2026.";
  assert.deepEqual(openAiLiveModelsAtPublishedRate(pricing + "\n\n" + reviewed, 50_000), ["gpt-live-1.1"]);
  assert.equal(openAiLiveModelsAtPublishedRate(pricing + "\n\n" + reviewed.replace("until", "through"), 50_000), null);
  assert.equal(openAiLiveModelsAtPublishedRate(pricing + "\n| gpt-live-1.1 | $0.08 / minute | $0.02 / minute |", 50_000), null);
  assert.equal(openAiLiveModelsAtPublishedRate(pricing + "\n| gpt-live-2 | $0.05 / minute |", 50_000), null);
});

test("the exact model's non-promotional active-minute tariff and supported Live endpoint determine eligibility", () => {
  const id = "gpt-live-1.1";
  const doc = [
    "Model ID: `gpt-live-1.1`", "## Pricing", "### Live session duration",
    "| Metric | Price | Unit |\n| --- | ---: | --- |\n| Active | $0.05 | minute |\n| Standby | $0.02 | minute |",
    "## Endpoints", "| Endpoint | Route | Support |\n| --- | --- | --- |\n| Live | `v1/live/sessions` | Supported |",
  ].join("\n\n");
  assert.equal(openAiLiveMinuteRate(doc, id), 50_000);
  assert.equal(openAiLiveMinuteRate(doc.replace("$0.05", "$0.08"), id), 80_000);
  assert.equal(openAiLiveMinuteRate(doc.replace("$0.05 | minute", "$0.05 | hour"), id), null);
  assert.equal(openAiLiveMinuteRate(doc.replace("Supported |", "Not supported |"), id), null);
  assert.equal(openAiLiveMinuteRate(doc + "\n\nIntroductory pricing applies.", id), null);
  assert.equal(openAiLiveMinuteRate(doc, "gpt-live-2"), null);
});
