import assert from "node:assert/strict";
import test from "node:test";
import {
  combinePerplexityUsageCosts,
  parsePerplexityResponseBody,
  parsePerplexityUsageCost,
} from "../lib/perplexityUsageCore.ts";
import {
  parseDeepSeekBalance,
  parseMoonshotBalance,
} from "../lib/providerBalanceCore.ts";
import {
  createAlibabaCloudBillingRequest,
  googleCloudBillingQueryRequest,
  parseAlibabaCloudBillingPage,
  parseGoogleCloudBillingQuery,
} from "../lib/cloudBillingSyncCore.ts";

const perplexityPayload = (totalCost, requestCost = 0.005) => ({
  usage: {
    prompt_tokens: 1013,
    completion_tokens: 30,
    total_tokens: 1043,
    search_context_size: "medium",
    citation_tokens: 12,
    num_search_queries: 3,
    reasoning_tokens: 8,
    cost: {
      input_tokens_cost: 0.001013,
      output_tokens_cost: 0.00045,
      reasoning_tokens_cost: 0.0001,
      request_cost: requestCost,
      citation_tokens_cost: 0.0002,
      search_queries_cost: 0.015,
      total_cost: totalCost,
    },
  },
});

test("Perplexity response usage preserves exact request and search costs", () => {
  const parsed = parsePerplexityUsageCost(perplexityPayload(0.021763));
  assert.equal(parsed.totalCostMicroUsd, 21_763);
  assert.equal(parsed.requestCostMicroUsd, 5_000);
  assert.equal(parsed.searchQueriesCostMicroUsd, 15_000);
  assert.equal(parsed.searchQueries, 3);
  assert.equal(parsed.searchContextSize, "medium");
});

test("Perplexity SSE parser finds the final usage event and combines retries", () => {
  const first = parsePerplexityResponseBody(
    `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: ${JSON.stringify(perplexityPayload(0.01))}\n\ndata: [DONE]\n`
  );
  const second = parsePerplexityResponseBody(
    JSON.stringify(perplexityPayload(0.02, 0.01))
  );
  const combined = combinePerplexityUsageCosts([first, second]);
  assert.equal(combined.totalCostMicroUsd, 30_000);
  assert.equal(combined.requestCostMicroUsd, 15_000);
  assert.equal(combined.promptTokens, 2_026);
  assert.equal(combined.searchContextSize, "multiple_requests");
});

test("DeepSeek balance prefers USD and retains availability breakdown", () => {
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "14.00",
        granted_balance: "4.00",
        topped_up_balance: "10.00",
      },
      {
        currency: "USD",
        total_balance: "2.50",
        granted_balance: "0.50",
        topped_up_balance: "2.00",
      },
    ],
  });
  assert.deepEqual(parsed, {
    amount: 2.5,
    currency: "USD",
    available: true,
    grantedAmount: 0.5,
    toppedUpAmount: 2,
  });
});

test("Moonshot balance exposes available, voucher, and cash balances", () => {
  assert.deepEqual(
    parseMoonshotBalance({
      code: 0,
      data: {
        available_balance: 49.58894,
        voucher_balance: 46.58893,
        cash_balance: 3.00001,
      },
      scode: "0x0",
      status: true,
    }),
    {
      amount: 49.58894,
      currency: "USD",
      available: true,
      grantedAmount: 46.58893,
      toppedUpAmount: 3.00001,
    }
  );
});

test("Google Cloud billing query includes credits and converts local currency to USD", () => {
  const request = googleCloudBillingQueryRequest(
    "billing-project.billing_dataset.gcp_billing_export_v1_ABC",
    new Date("2026-07-14T12:00:00.000Z")
  );
  assert.match(request.query, /UNNEST\(credits\)/);
  assert.match(request.query, /currency_conversion_rate/);
  assert.equal(request.queryParameters[0].parameterValue.value, "2026-07-14");
  assert.deepEqual(
    parseGoogleCloudBillingQuery({
      jobComplete: true,
      rows: [{ f: [{ v: "81234" }, { v: "42" }, { v: "0" }] }],
    }),
    { costMicroUsd: 81_234, rowCount: 42, invalidCurrencyRateRows: 0 }
  );
});

test("Alibaba Cloud request uses ACS3 signing and daily bill parameters", () => {
  const request = createAlibabaCloudBillingRequest({
    endpoint: "https://business.ap-southeast-1.aliyuncs.com",
    accessKeyId: "test-access-key",
    accessKeySecret: "test-secret",
    date: new Date("2026-07-14T12:00:00.000Z"),
    pageNumber: 2,
    productCode: "dashscope",
    now: new Date("2026-07-15T01:02:03.000Z"),
    nonce: "fixed-nonce",
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("BillingCycle"), "2026-07");
  assert.equal(url.searchParams.get("BillingDate"), "2026-07-14");
  assert.equal(url.searchParams.get("Granularity"), "DAILY");
  assert.equal(url.searchParams.get("PageNum"), "2");
  assert.equal(url.searchParams.get("ProductCode"), "dashscope");
  assert.match(request.headers.Authorization, /^ACS3-HMAC-SHA256 Credential=/);
  assert.equal(request.headers["x-acs-date"], "2026-07-15T01:02:03Z");
});

test("Alibaba Cloud billing parser sums USD pretax amounts and rejects CNY", () => {
  const parsed = parseAlibabaCloudBillingPage({
    RequestId: "request-1",
    Data: {
      TotalCount: 2,
      Items: {
        Item: [
          { Currency: "USD", PretaxAmount: "1.25" },
          { Currency: "usd", PretaxAmount: "-0.05" },
        ],
      },
    },
  });
  assert.equal(parsed.costUsd, 1.2);
  assert.equal(parsed.itemCount, 2);
  assert.throws(
    () =>
      parseAlibabaCloudBillingPage({
        Data: {
          TotalCount: 1,
          Items: { Item: [{ Currency: "CNY", PretaxAmount: "1" }] },
        },
      }),
    /exact micro-USD reconciliation/
  );
});
