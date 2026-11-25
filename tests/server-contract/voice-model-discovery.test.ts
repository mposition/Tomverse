import assert from "node:assert/strict";
import test from "node:test";
import { getOpenAiLiveModelsAtRate } from "@/lib/providerModelDocEvidence";
import { OPENAI_PRICING_MARKDOWN_URL } from "@/lib/providerModelDocsCore";

const pricing = "GPT-Live\n\n### Pricing Table data\n\n| Model | Active rate | Standby rate |\n|---|---|---|\n| gpt-live-1.1 | $0.05 / minute | $0.02 / minute |\n| gpt-live-1 | $0.05 / minute | $0.02 / minute |";
const modelPage = (id: string) => [
  "Model ID: `" + id + "`", "### Live session duration",
  "| Metric | Price | Unit |\n|---|---|---|\n| Active | $0.05 | minute |",
  "## Endpoints", "| Endpoint | Route | Support |\n|---|---|---|\n| Live | `v1/live/sessions` | Supported |",
].join("\n\n");

test("discovery withholds unread pricing, distinguishes an incomplete check and verifies both sources", async t => {
  let tariff = pricing;
  let missing = false;
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requested.push(url);
    const id = url.split("/").at(-1)?.replace(/\.md$/, "") ?? "";
    if (missing && id === "gpt-live-1.1") return new Response(null, { status: 503 });
    const body = url === OPENAI_PRICING_MARKDOWN_URL ? tariff : modelPage(id);
    return new Response(body, { headers: { "Content-Type": "text/markdown" } });
  });
  tariff += "\n\nA new introductory rate applies.";
  assert.equal(await getOpenAiLiveModelsAtRate(50_000), null);
  assert.deepEqual(requested, [OPENAI_PRICING_MARKDOWN_URL]);
  tariff = pricing;
  missing = true;
  assert.equal(await getOpenAiLiveModelsAtRate(50_000), null);
  missing = false;
  assert.deepEqual(await getOpenAiLiveModelsAtRate(50_000), ["gpt-live-1.1", "gpt-live-1"]);
  tariff = pricing.replaceAll("$0.05 / minute", "$0.08 / minute");
  assert.deepEqual(await getOpenAiLiveModelsAtRate(50_000), []);
  assert.deepEqual(await getOpenAiLiveModelsAtRate(80_000), []);
});
