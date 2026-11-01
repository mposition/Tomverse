import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMarketIntelValue,
  groupMarketIntelFacts,
  isHttpsUrl,
} from "../lib/marketingReportView.ts";

test("money is shown as currency and a major-unit amount", () => {
  assert.equal(formatMarketIntelValue({ kind: "money", amountMinor: 2000, currency: "USD" }), "USD 20.00");
  assert.equal(formatMarketIntelValue({ kind: "money", amountMinor: 1999, currency: "AUD" }), "AUD 19.99");
  // A currency with no minor unit is not divided.
  assert.equal(formatMarketIntelValue({ kind: "money", amountMinor: 3000, currency: "JPY" }), "JPY 3000");
  // A code the runtime does not know falls back to two digits.
  assert.equal(formatMarketIntelValue({ kind: "money", amountMinor: 500, currency: "ZZZ" }), "ZZZ 5.00");
});

test("tokens, dates and numbers are shown as stored", () => {
  assert.equal(formatMarketIntelValue({ kind: "token", value: "unlimited" }), "unlimited");
  assert.equal(formatMarketIntelValue({ kind: "date", value: "2026-11-01" }), "2026-11-01");
  assert.equal(formatMarketIntelValue({ kind: "number", value: 100, unit: null }), "100");
  assert.equal(formatMarketIntelValue({ kind: "number", value: 100, unit: "messages" }), "100 messages");
});

test("facts are grouped by competitor in first-seen order, named from the registry", () => {
  const fact = (competitorId, factType) => ({
    competitorId,
    factType,
    value: { kind: "token", value: "pro" },
    sourceUrl: "https://example.com",
    checkedAt: "2026-11-01T00:00:00Z",
  });
  const groups = groupMarketIntelFacts(
    [fact("b", "plan_tier"), fact("a", "plan_tier"), fact("b", "availability")],
    { b: "Beta Inc" }
  );
  assert.deepEqual(
    groups.map((group) => [group.competitorId, group.name, group.facts.map((f) => f.factType)]),
    [
      ["b", "Beta Inc", ["plan_tier", "availability"]],
      ["a", "a", ["plan_tier"]],
    ]
  );
});

test("only an https source is made a link", () => {
  assert.equal(isHttpsUrl("https://example.com/pricing"), true);
  assert.equal(isHttpsUrl("http://example.com"), false);
  assert.equal(isHttpsUrl("javascript:alert(1)"), false);
});
