import assert from "node:assert/strict";
import test from "node:test";

import { MARKET_INTEL_FACT_TOKENS } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_A3_ANSWER_SCHEMA,
  MARKETING_A3_DISCOVERY_ANSWER_SCHEMA,
  marketingA3Messages,
  marketingA3ReportBody,
  marketingA3SourceUrl,
  readMarketingA3Answer,
  readMarketingA3Discovery,
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


/** Every object a strict Structured Outputs schema holds must list all its keys as required and allow no others. */
function strictProblems(node, path = "$") {
  if (!node || typeof node !== "object") return [];
  const problems = [];
  if (node.type === "object") {
    const keys = Object.keys(node.properties ?? {});
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties is not false`);
    if (JSON.stringify([...(node.required ?? [])].sort()) !== JSON.stringify([...keys].sort())) {
      problems.push(`${path}: required is not every property`);
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (Array.isArray(child)) child.forEach((item, index) => problems.push(...strictProblems(item, `${path}.${key}[${index}]`)));
    else if (child && typeof child === "object") problems.push(...strictProblems(child, `${path}.${key}`));
  }
  return problems;
}

test("both answer schemas are valid strict Structured Outputs schemas", () => {
  assert.deepEqual(strictProblems(MARKETING_A3_ANSWER_SCHEMA.schema), []);
  assert.deepEqual(strictProblems(MARKETING_A3_DISCOVERY_ANSWER_SCHEMA.schema), []);
  // A strict schema's root is an object, not a union.
  assert.equal(MARKETING_A3_ANSWER_SCHEMA.schema.type, "object");
  assert.equal(MARKETING_A3_DISCOVERY_ANSWER_SCHEMA.schema.type, "object");
});

test("a token fact the provider can produce is exactly a stored vocabulary, by fact type", () => {
  const branches = MARKETING_A3_ANSWER_SCHEMA.schema.properties.facts.items.anyOf;
  const tokenBranches = Object.fromEntries(
    branches
      .filter((branch) => branch.properties.factType.enum)
      .map((branch) => [branch.properties.factType.enum[0], branch.properties.value.properties.value.enum]),
  );
  assert.deepEqual(tokenBranches, MARKET_INTEL_FACT_TOKENS);
  // The open branch has no token kind: a token outside a vocabulary cannot be produced.
  const open = branches.find((branch) => !branch.properties.factType.enum);
  const kinds = open.properties.value.anyOf.map((value) => value.properties.kind.enum[0]);
  assert.deepEqual(kinds.sort(), ["date", "money", "number"]);
});

test("an answer in the schema's shape is kept whole: no fact the provider can produce is dropped for its shape", () => {
  const checkedAt = "2026-10-30T00:00:00.000Z";
  const tokenFacts = Object.entries(MARKET_INTEL_FACT_TOKENS).flatMap(([factType, tokens]) =>
    tokens.map((token) => ({ factType, value: { kind: "token", value: token }, sourceUrl: PAGE })),
  );
  const facts = [
    ...tokenFacts.slice(0, 30),
    { factType: "plan_price_monthly_pro", value: { kind: "money", amountMinor: 1999, currency: "USD" }, sourceUrl: PAGE },
    { factType: "plan_price_annual_pro", value: { kind: "money", amountMinor: 19900, currency: "EUR" }, sourceUrl: PAGE },
    { factType: "message_limit_daily_free", value: { kind: "number", value: 50, unit: "messages_per_day" }, sourceUrl: PAGE },
    { factType: "model_count", value: { kind: "number", value: 40, unit: null }, sourceUrl: PAGE },
    { factType: "launch_date", value: { kind: "date", value: "2026-09-01" }, sourceUrl: PAGE },
  ];
  const read = readMarketingA3Answer(JSON.stringify({ facts, unrepresentable: 2 }), {
    competitorId: "poe",
    officialHosts: HOSTS,
    citations: [PAGE],
    checkedAt,
  });
  assert.deepEqual(read.dropped, {});
  assert.equal(read.facts.length, facts.length);
  assert.equal(read.unrepresentable, 2);
});

test("a discovery answer in the schema's shape parses as a candidate", () => {
  const evidence = "https://www.typingmind.com/";
  const read = readMarketingA3Discovery(
    JSON.stringify({
      candidates: [
        {
          competitorId: "typingmind",
          displayName: "TypingMind",
          officialHosts: ["typingmind.com"],
          evidenceUrls: [evidence],
          rationale: "One chat front end for many model providers.",
        },
      ],
    }),
    { knownIds: [], citations: [evidence] },
  );
  assert.deepEqual(read.dropped, {});
  assert.equal(read.candidates.length, 1);
});
