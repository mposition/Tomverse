import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_A3_COMPETITOR_BUDGET_MS,
  MARKETING_A3_REPORT_MARGIN_MS,
  runMarketingA3Cycle,
} from "@/lib/marketingA3CycleCore";
import { MARKETING_A3_ANSWER_SCHEMA, MARKETING_A3_DISCOVERY_ANSWER_SCHEMA } from "@/lib/marketingA3Core";
import {
  MARKETING_INTEL_REPORT_MAX_BODY_BYTES,
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";

const SECRET = "a".repeat(48);
const NOW = Date.parse("2026-10-17T00:00:00.000Z");
const DEADLINE = new Date(NOW + 20 * 60 * 1000).toISOString();

const context = (tracked, knownIds = []) => ({
  channels: [],
  claims: [],
  assets: [],
  brief: null,
  marketIntel: null,
  competitors: { tracked, knownIds },
});
const poe = {
  competitorId: "poe",
  displayName: "Poe",
  officialHosts: ["poe.com"],
};
/** What the provider cites, as it cites it: with its own query on the end. */
const CITED = ["https://poe.com/pricing?utm_source=chatgpt.com"];
const fact = (sourceUrl) => ({
  factType: "plan_tier",
  value: { kind: "token", value: "pro" },
  sourceUrl,
});

/** A settled web-search answer. */
const answered = (requestKey, content, citations) => ({
  status: "answered",
  callId: `call-${requestKey}`,
  requestKey,
  content: JSON.stringify(content),
  citations,
  ledgerState: "settled",
});

/** The discovery search's cited pages, and a candidate citing them. */
const FOUND = ["https://www.typingmind.com/", "https://www.typingmind.com/pricing"];
const candidate = (overrides = {}) => ({
  competitorId: "typingmind",
  displayName: "TypingMind",
  officialHosts: ["typingmind.com"],
  evidenceUrls: [FOUND[1]],
  rationale: "A chat front end for many model providers, sold as one licence.",
  ...overrides,
});

/** Ports that record what the run asked for, answering from the given table. */
const ports = (overrides = {}) => {
  const seen = { calls: [], reports: [], sleeps: [] };
  let id = 0;
  const deps = {
    readContext: async () => context([poe]),
    callLlm: async (messages, requestKey, allowedDomains, answerSchema) => {
      seen.calls.push({ messages, requestKey, allowedDomains, answerSchema });
      // No domains is the run's discovery search, which finds nothing by default.
      if (allowedDomains.length === 0) return answered(requestKey, { candidates: [] }, []);
      return answered(
        requestKey,
        {
          // The second cites a page the provider never cited: not kept.
          facts: [fact("https://poe.com/pricing"), fact("https://poe.com/changelog")],
          unrepresentable: 1,
        },
        CITED,
      );
    },
    submitReport: async (report) => {
      seen.reports.push(report);
      return { httpStatus: 200, body: { result: { status: "recorded", reportRowId: "r1", existing: false } } };
    },
    secret: SECRET,
    newId: () => `id-${(id += 1)}`,
    now: () => NOW,
    sleep: async (ms) => {
      seen.sleeps.push(ms);
    },
    ...overrides,
  };
  return { deps, seen };
};

test("a run searches once per competitor within its official domains, and reports one signed market_intel report", async () => {
  const { deps, seen } = ports();
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary, {
    competitors: 1,
    calls: 2,
    factsKept: 1,
    unrepresentable: 2,
    dropped: { source_not_retrieved: 1 },
    candidatesKept: 0,
    candidatesDropped: {},
    report: { httpStatus: 200, status: "recorded" },
    stoppedAt: null,
  });
  assert.deepEqual(seen.calls[0].allowedDomains, ["poe.com"]);
  // Each call is held to the shape its reader parses.
  assert.deepEqual(seen.calls[0].answerSchema, MARKETING_A3_ANSWER_SCHEMA);
  assert.deepEqual(seen.calls.at(-1).answerSchema, MARKETING_A3_DISCOVERY_ANSWER_SCHEMA);
  const data = JSON.parse(seen.calls[0].messages[1].content);
  assert.deepEqual(data.competitor, { id: "poe", name: "Poe", officialDomains: ["poe.com"] });
  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(report.kind, "market_intel");
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  assert.deepEqual(report.payload.facts.map((row) => [row.competitorId, row.sourceUrl]), [["poe", "https://poe.com/pricing"]]);
  assert.equal(report.payload.unrepresentableFactCount, 2);
  // A report that proposes nothing carries no candidate field: its bytes are what they were.
  assert.equal("competitorCandidates" in seen.reports[0], false);
});

test("after the tracked competitors, one unrestricted search proposes new ones with evidence the provider cited", async () => {
  const { deps, seen } = ports({
    readContext: async () => context([poe], ["poe", "monica"]),
    callLlm: async (messages, requestKey, allowedDomains) => {
      seen.calls.push({ messages, requestKey, allowedDomains });
      if (allowedDomains.length > 0) return answered(requestKey, { facts: [], unrepresentable: 0 }, CITED);
      return answered(
        requestKey,
        {
          candidates: [
            candidate(),
            // Already in the registry, under any status: not proposed again.
            candidate({ competitorId: "monica", displayName: "Monica" }),
            candidate({ competitorId: "poe", displayName: "Poe again" }),
            // Evidence the provider did not return, even one character off: not evidence.
            candidate({ competitorId: "chathub", displayName: "ChatHub", evidenceUrls: ["https://chathub.gg/"] }),
            candidate({ competitorId: "msty", displayName: "Msty", evidenceUrls: [`${FOUND[1]}/`] }),
            // No evidence at all, and a shape the registry would not store.
            candidate({ competitorId: "noproof", displayName: "No proof", evidenceUrls: [] }),
            candidate({ competitorId: "Bad Id" }),
            // The same new id twice is proposed once.
            candidate({ displayName: "TypingMind twice" }),
          ],
        },
        FOUND,
      );
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.equal(summary.stoppedAt, null);
  assert.equal(summary.calls, 2);
  assert.equal(summary.candidatesKept, 1);
  assert.deepEqual(summary.candidatesDropped, { known: 3, evidence_not_cited: 2, shape: 2 });
  // The discovery call is the last one, unrestricted, and told what the registry already holds.
  const discovery = seen.calls[1];
  assert.deepEqual(discovery.allowedDomains, []);
  assert.deepEqual(JSON.parse(discovery.messages[1].content), { known: { ids: ["monica", "poe"], names: ["Poe"] } });
  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  assert.deepEqual(report.competitorCandidates, [candidate()]);
});

test("with no tracked competitor only the discovery search runs, and a run that finds nothing reports nothing", async () => {
  for (const tracked of [[], [{ ...poe, officialHosts: [] }]]) {
    const { deps, seen } = ports({ readContext: async () => context(tracked) });
    const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
    assert.equal(summary.calls, 1);
    assert.deepEqual(seen.calls[0].allowedDomains, []);
    assert.equal(summary.report, null);
    assert.equal(summary.stoppedAt, null);
    assert.equal(seen.reports.length, 0);
  }
  // An app older than the registry sends no field at all: nobody is tracked or known.
  const { deps } = ports({ readContext: async () => ({ channels: [] }) });
  assert.equal((await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps)).stoppedAt, null);
});

test("a run that only discovers reports its candidates; a discovery call that does not settle stops the run", async () => {
  const found = ports({
    readContext: async () => context([]),
    callLlm: async (messages, requestKey) => answered(requestKey, { candidates: [candidate()] }, FOUND),
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, found.deps);
  assert.deepEqual(summary.report, { httpStatus: 200, status: "recorded" });
  assert.deepEqual(found.seen.reports[0].competitorCandidates, [candidate()]);
  assert.deepEqual(found.seen.reports[0].payload, { facts: [], unrepresentableFactCount: 0 });

  // The facts already found are not reported: a stopped run reports nothing.
  const { deps, seen } = ports({
    callLlm: async (messages, requestKey, allowedDomains) =>
      allowedDomains.length === 0
        ? { status: "unknown", callId: "c", requestKey }
        : answered(requestKey, { facts: [fact("https://poe.com/pricing")], unrepresentable: 0 }, CITED),
  });
  const stopped = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(stopped.stoppedAt, { stage: "llm", detail: "unknown" });
  assert.equal(seen.reports.length, 0);

  // An answer that is not the JSON asked for proposes nothing and is counted.
  const garbled = ports({ callLlm: async (messages, requestKey, allowedDomains) =>
    allowedDomains.length === 0 ? answered(requestKey, { facts: [] }, FOUND) : answered(requestKey, { facts: [], unrepresentable: 0 }, CITED) });
  const read = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, garbled.deps);
  assert.deepEqual(read.candidatesDropped, { unreadable_answer: 1 });
});

test("the discovery search is not started without the time a competitor gets", async () => {
  let clock = NOW;
  const { deps, seen } = ports({
    now: () => clock,
    callLlm: async (messages, requestKey) => {
      clock = Date.parse(DEADLINE) - MARKETING_A3_COMPETITOR_BUDGET_MS + 1;
      return answered(requestKey, { facts: [fact("https://poe.com/pricing")], unrepresentable: 0 }, CITED);
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "deadline_too_close" });
  assert.equal(summary.calls, 1);
  assert.equal(seen.reports.length, 0);
});

test("an unknown or refused call stops the run, and a stopped run reports nothing", async () => {
  for (const [outcome, detail] of [
    [{ status: "unknown", callId: "c", requestKey: "k" }, "unknown"],
    [{ status: "refused", stage: "reserve", code: "model_not_pinned" }, "reserve:model_not_pinned"],
    [{ status: "stopped", stage: "settle", callId: "c", requestKey: "k" }, "stopped"],
  ]) {
    const second = { ...poe, competitorId: "zeta", displayName: "Zeta" };
    const { deps, seen } = ports({
      readContext: async () => context([poe, second]),
      callLlm: async () => outcome,
    });
    const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
    assert.deepEqual(summary.stoppedAt, { stage: "llm", detail });
    assert.equal(summary.calls, 1, "the next competitor is not asked");
    assert.equal(seen.reports.length, 0);
  }
});

test("a run that cannot finish a competitor before its deadline stops before starting it", async () => {
  const { deps, seen } = ports();
  const tight = new Date(NOW + MARKETING_A3_COMPETITOR_BUDGET_MS - 1).toISOString();
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: tight }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "deadline_too_close" });
  assert.equal(seen.calls.length, 0);
  assert.equal(seen.reports.length, 0);
});

test("a lost or 5xx answer resends the same signed report; a 4xx does not", async () => {
  let attempt = 0;
  const flaky = ports({
    submitReport: async (report) => {
      flaky.seen.reports.push(report);
      attempt += 1;
      if (attempt === 1) throw new TypeError("socket hang up");
      if (attempt === 2) return { httpStatus: 503, body: {} };
      return { httpStatus: 200, body: { result: { status: "recorded" } } };
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, flaky.deps);
  assert.deepEqual(summary.report, { httpStatus: 200, status: "recorded" });
  assert.equal(flaky.seen.reports.length, 3);
  assert.deepEqual(flaky.seen.reports[1], flaky.seen.reports[0]);
  assert.deepEqual(flaky.seen.reports[2], flaky.seen.reports[0]);
  assert.equal(flaky.seen.calls.length, 2, "never another call to the provider: one search and the discovery");

  const refused = ports({ submitReport: async () => ({ httpStatus: 400, body: { code: "invalid_request" } }) });
  const answer = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, refused.deps);
  assert.deepEqual(answer.stoppedAt, { stage: "submit", detail: "http_400:unreadable" });

  const lost = ports({
    submitReport: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const unknown = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, lost.deps);
  assert.deepEqual(unknown.stoppedAt, { stage: "submit", detail: "outcome_unknown" });
});

test("an unreadable context stops before anything is asked", async () => {
  for (const readContext of [
    async () => {
      throw new Error("http 500");
    },
    async () => ({ competitors: { tracked: "x" } }),
    async () => ({ competitors: { tracked: [{ competitorId: 1 }] } }),
  ]) {
    const { deps, seen } = ports({ readContext });
    const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
    assert.equal(summary.stoppedAt?.stage, "context");
    assert.equal(seen.calls.length, 0);
  }
});

test("a call that throws is an unknown outcome: the run stops and reports nothing", async () => {
  const { deps, seen } = ports({
    callLlm: async () => {
      throw new Error("aborted");
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: "threw" });
  assert.equal(seen.reports.length, 0);
});

test("with too little time left the report is not sent, which is a deadline and not a failure", async () => {
  let clock = NOW;
  const { deps, seen } = ports({
    now: () => clock,
    callLlm: async (messages, requestKey, allowedDomains) => {
      if (allowedDomains.length > 0) {
        return answered(requestKey, { facts: [fact("https://poe.com/pricing")], unrepresentable: 0 }, CITED);
      }
      // The discovery call returns with less than the report's margin left.
      clock = Date.parse(DEADLINE) - MARKETING_A3_REPORT_MARGIN_MS + 1;
      return answered(requestKey, { candidates: [] }, []);
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "report_deadline_too_close" });
  assert.equal(seen.reports.length, 0);
});

test("a report never exceeds the route's byte limit; the facts that do not fit are counted", async () => {
  const longUrl = `https://poe.com/${"p".repeat(480)}`;
  const many = Array.from({ length: 40 }, (_, index) => ({
    factType: `f${"x".repeat(50)}${index}`,
    value: { kind: "number", value: index, unit: null },
    sourceUrl: longUrl,
  }));
  const competitorsList = Array.from({ length: 6 }, (_, index) => ({
    competitorId: `c${index}`,
    displayName: `C${index}`,
    officialHosts: ["poe.com"],
  }));
  const { deps, seen } = ports({
    readContext: async () => context(competitorsList),
    callLlm: async (messages, requestKey) => ({
      status: "answered",
      callId: "c",
      requestKey,
      content: JSON.stringify({ facts: many, unrepresentable: 0 }),
      citations: [longUrl],
      ledgerState: "settled",
    }),
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.equal(summary.stoppedAt, null);
  const report = seen.reports[0];
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= MARKETING_INTEL_REPORT_MAX_BODY_BYTES);
  assert.ok(report.payload.facts.length < 200, `kept ${report.payload.facts.length}`);
  assert.equal(report.payload.facts.length + report.payload.unrepresentableFactCount, 240);
  assert.equal(summary.factsKept + summary.unrepresentable, 240);
  assert.equal(marketingGeneratorReportSchema.safeParse(report).success, true);
});

test("a call released before dispatch is A3 running out of time, not an unknown outcome", async () => {
  const { deps, seen } = ports({ callLlm: async () => ({ status: "released", callId: "c" }) });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  // The worker carries on with A5 on a deadline stop, and stops on llm or submit.
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "released_before_dispatch" });
  assert.equal(seen.reports.length, 0);
  // A release whose answer was lost is not a release.
  const lost = ports({ callLlm: async () => ({ status: "stopped", stage: "release", callId: "c", requestKey: "k" }) });
  assert.deepEqual((await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, lost.deps)).stoppedAt, {
    stage: "llm",
    detail: "stopped",
  });
});

test("an answer the ledger retained as unknown stops the run and is not used", async () => {
  const { deps, seen } = ports({
    callLlm: async () => ({ status: "retained", callId: "c", requestKey: "k", ledgerState: "unknown_retained" }),
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: "retained" });
  assert.equal(summary.factsKept, 0);
  assert.equal(seen.reports.length, 0);
});
