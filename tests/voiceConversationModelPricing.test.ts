import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listedOpenAiLiveModels, openAiLiveMinuteRate } from "@/lib/providerModelDocsCore";

test("both generations of OpenAI's Live pricing table supply identities only from the Live section", () => {
  const archived = readFileSync(new URL("./fixtures/providerModelDocs/openai-pricing-2026-09-13.md", import.meta.url), "utf8");
  assert.deepEqual(listedOpenAiLiveModels(archived), ["gpt-live-1"]);
  const header = "| Model | Active rate | Standby rate |\n| --- | --- | --- |";
  const before = header + "\n| gpt-live-9 | $0.05 / minute | $0.02 / minute |";
  const live = header + "\n| gpt-live-1.1 | $0.05 / minute | $0.02 / minute |";
  assert.deepEqual(listedOpenAiLiveModels([before, "GPT-Live", "### Pricing Table data", live].join("\n\n")), ["gpt-live-1.1"]);
  assert.equal(listedOpenAiLiveModels(before), null);
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
