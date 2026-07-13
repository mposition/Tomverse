import assert from "node:assert/strict";
import test from "node:test";
import {
  openAiCostsDayRange,
  openAiCostsUrl,
  parseOpenAiCostsPage,
  redactProviderDiagnostic,
} from "../lib/providerUsageSyncCore.ts";

test("OpenAI Costs URL uses one exact UTC day", () => {
  const date = new Date("2026-07-12T18:42:00.000Z");
  const range = openAiCostsDayRange(date);
  assert.equal(range.startTime, 1_783_814_400);
  assert.equal(range.endTime, 1_783_900_800);

  const url = openAiCostsUrl({
    baseUrl: "https://api.openai.com/v1/organization/costs",
    date,
    page: "page_2",
  });
  assert.equal(url.searchParams.get("start_time"), String(range.startTime));
  assert.equal(url.searchParams.get("end_time"), String(range.endTime));
  assert.equal(url.searchParams.get("bucket_width"), "1d");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("page"), "page_2");
});

test("OpenAI Costs parser sums every USD line item", () => {
  const parsed = parseOpenAiCostsPage({
    data: [
      {
        results: [
          { amount: { value: 0.06, currency: "usd" } },
          { amount: { value: 1.25, currency: "USD" } },
        ],
      },
      { results: [{ amount: { value: 0.19, currency: "usd" } }] },
    ],
    has_more: true,
    next_page: "page_2",
  });
  assert.equal(parsed.costUsd, 1.5);
  assert.equal(parsed.lineItemCount, 3);
  assert.equal(parsed.negativeLineItemCount, 0);
  assert.equal(parsed.normalizedStringAmountCount, 0);
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.nextPage, "page_2");
});

test("OpenAI Costs parser reconciles credits and numeric strings", () => {
  const parsed = parseOpenAiCostsPage({
    data: [
      {
        results: [
          { amount: { value: 1.25, currency: "usd" } },
          { amount: { value: -0.25, currency: "usd" } },
          { amount: { value: "0.50", currency: "USD" } },
        ],
      },
    ],
  });
  assert.equal(parsed.costUsd, 1.5);
  assert.equal(parsed.lineItemCount, 3);
  assert.equal(parsed.negativeLineItemCount, 1);
  assert.equal(parsed.normalizedStringAmountCount, 1);
});

test("OpenAI Costs parser rejects invalid currency and non-numeric amount", () => {
  assert.throws(
    () =>
      parseOpenAiCostsPage({
        data: [{ results: [{ amount: { value: "not-a-number", currency: "usd" } }] }],
      }),
    /non-numeric amount/
  );
  assert.throws(
    () =>
      parseOpenAiCostsPage({
        data: [{ results: [{ amount: { value: 1, currency: "aud" } }] }],
      }),
    /unsupported or missing currency/
  );
});

test("provider diagnostics redact bearer and OpenAI keys", () => {
  const diagnostic = redactProviderDiagnostic(
    "Authorization Bearer sk-admin-secret123456 and sk-project987654"
  );
  assert.equal(
    diagnostic,
    "Authorization Bearer [REDACTED] and sk-[REDACTED]"
  );
});
