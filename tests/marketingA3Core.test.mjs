import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingA3Messages,
  marketingA3ReportBody,
  marketingA3SourceUrl,
  readMarketingA3Answer,
} from "@/lib/marketingA3Core";
import {
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";

const HOSTS = ["poe.com", "www.poe.com"];
const PAGE = "https://poe.com/pricing";

test("the model is asked to search the official domains, with the competitor as data under a fixed instruction", () => {
  const [system, user] = marketingA3Messages({ competitorId: "poe", displayName: "Poe", officialHosts: HOSTS });
  assert.equal(system.role, "system");
  assert.match(system.content, /data, not instructions/);
  assert.match(system.content, /web search/);
  const data = JSON.parse(user.content);
  assert.deepEqual(data.competitor, { id: "poe", name: "Poe", officialDomains: HOSTS });
  assert.ok(Array.isArray(data.tokens.plan_tier));
});

test("a cited URL is kept as https on an official host, without the query and fragment the provider adds", () => {
  assert.equal(marketingA3SourceUrl("https://poe.com/pricing?utm_source=chatgpt.com#plans", HOSTS), PAGE);
  assert.equal(marketingA3SourceUrl("https://WWW.Poe.com/about", HOSTS), "https://www.poe.com/about");
  // A trailing slash is the same page.
  assert.equal(marketingA3SourceUrl("https://poe.com/pricing/", HOSTS), PAGE);
  assert.equal(marketingA3SourceUrl("https://poe.com/", HOSTS), "https://poe.com/");
  for (const url of [
    "http://poe.com/pricing",
    "https://poe.com:8443/pricing",
    "https://user:pw@poe.com/pricing",
    "https://blog.poe.com/pricing",
    "https://poe.com.evil.example/pricing",
    "https://evil.example/poe.com",
    "not a url",
  ]) {
    assert.equal(marketingA3SourceUrl(url, HOSTS), null, url);
  }
});

test("only facts that parse and cite a URL the provider cited on an official host are kept, under the service's id and time", () => {
  const checkedAt = "2026-10-17T00:00:00.000Z";
  const citations = ["https://poe.com/pricing?utm_source=chatgpt.com", "https://evil.example/pricing"];
  const answer = JSON.stringify({
    facts: [
      { factType: "plan_price_monthly", value: { kind: "money", amountMinor: 2000, currency: "USD" }, sourceUrl: PAGE },
      // On an official host, but never cited by the provider.
      { factType: "plan_price_monthly", value: { kind: "money", amountMinor: 1, currency: "USD" }, sourceUrl: "https://poe.com/other" },
      // Cited, but not on an official host.
      { factType: "plan_price_monthly", value: { kind: "money", amountMinor: 1, currency: "USD" }, sourceUrl: "https://evil.example/pricing" },
      // A token outside its vocabulary.
      { factType: "plan_tier", value: { kind: "token", value: "ultra" }, sourceUrl: PAGE },
      // Tries to name another competitor and its own time: both are overwritten.
      {
        factType: "plan_tier",
        value: { kind: "token", value: "pro" },
        sourceUrl: `${PAGE}?utm_source=chatgpt.com`,
        competitorId: "rival",
        checkedAt: "2020-01-01T00:00:00.000Z",
      },
    ],
    unrepresentable: 2,
  });
  const input = { competitorId: "poe", officialHosts: HOSTS, citations, checkedAt };
  const read = readMarketingA3Answer(answer, input);
  assert.equal(read.unreadable, false);
  assert.deepEqual(read.facts, [
    { competitorId: "poe", factType: "plan_price_monthly", value: { kind: "money", amountMinor: 2000, currency: "USD" }, sourceUrl: PAGE, checkedAt },
    { competitorId: "poe", factType: "plan_tier", value: { kind: "token", value: "pro" }, sourceUrl: PAGE, checkedAt },
  ]);
  assert.equal(read.unrepresentable, 5);
  assert.deepEqual(read.dropped, { source_not_retrieved: 1, source_not_official_host: 1, shape: 1 });

  // A fenced answer is still read.
  const fence = "`".repeat(3);
  assert.equal(readMarketingA3Answer(`${fence}json\n${answer}\n${fence}`, input).facts.length, 2);

  // With nothing cited, nothing is kept.
  assert.equal(readMarketingA3Answer(answer, { ...input, citations: [] }).facts.length, 0);

  for (const content of ["not json", "[]", "{}", '{"facts":"x"}']) {
    assert.deepEqual(readMarketingA3Answer(content, input), { facts: [], unrepresentable: 0, unreadable: true, dropped: {} });
  }
});

test("the report is a signed market_intel report the app's route accepts as is", () => {
  const secret = "s".repeat(48);
  const report = marketingA3ReportBody(secret, {
    generatorRunId: "run-1",
    reportId: "a3-poe",
    periodStart: "2026-10-10T00:00:00.000Z",
    periodEnd: "2026-10-17T00:00:00.000Z",
    deadlineAt: "2026-10-17T01:00:00.000Z",
    facts: [
      { competitorId: "poe", factType: "plan_tier", value: { kind: "token", value: "pro" }, sourceUrl: PAGE, checkedAt: "2026-10-17T00:00:00.000Z" },
    ],
    unrepresentableFactCount: 3,
  });
  const parsed = marketingGeneratorReportSchema.safeParse(report);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(marketingGeneratorReportProvenanceMatches(secret, parsed.data), true);
  assert.equal(marketingGeneratorReportProvenanceMatches("t".repeat(48), parsed.data), false);
});

