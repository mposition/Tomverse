import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_A3_COMPETITOR_BUDGET_MS,
  MARKETING_A3_REPORT_MARGIN_MS,
  runMarketingA3Cycle,
} from "@/lib/marketingA3CycleCore";
import {
  MARKETING_INTEL_REPORT_MAX_BODY_BYTES,
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";

const SECRET = "a".repeat(48);
const NOW = Date.parse("2026-10-17T00:00:00.000Z");
const DEADLINE = new Date(NOW + 20 * 60 * 1000).toISOString();

const context = (tracked) => ({ channels: [], claims: [], assets: [], brief: null, marketIntel: null, competitors: { tracked, knownIds: [] } });
const poe = {
  competitorId: "poe",
  displayName: "Poe",
  officialHosts: ["poe.com"],
  trackedPages: ["https://poe.com/pricing", "https://poe.com/changelog"],
};
const fact = (sourceUrl) => ({
  factType: "plan_tier",
  value: { kind: "token", value: "pro" },
  sourceUrl,
});

/** Ports that record what the run asked for, answering from the given table. */
const ports = (overrides = {}) => {
  const seen = { pages: [], calls: [], reports: [], sleeps: [] };
  let id = 0;
  const deps = {
    readContext: async () => context([poe]),
    fetchPage: async (url) => {
      seen.pages.push(url);
      return url.endsWith("/changelog") ? { ok: false, reason: "http_status" } : { ok: true, page: { url, text: "Pro plan" } };
    },
    callLlm: async (messages, requestKey) => {
      seen.calls.push({ messages, requestKey });
      return {
        status: "answered",
        callId: `call-${seen.calls.length}`,
        requestKey,
        content: JSON.stringify({ facts: [fact("https://poe.com/pricing")], unrepresentable: 1 }),
        ledgerState: "settled",
      };
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

test("a run reads each tracked page, asks once per competitor, and reports one signed market_intel report", async () => {
  const { deps, seen } = ports();
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary, {
    competitors: 1,
    pagesRead: 1,
    pagesRefused: { http_status: 1 },
    calls: 1,
    factsKept: 1,
    unrepresentable: 1,
    report: { httpStatus: 200, status: "recorded" },
    stoppedAt: null,
  });
  assert.deepEqual(seen.pages.sort(), ["https://poe.com/changelog", "https://poe.com/pricing"]);
  // The page that could not be read is not shown to the model.
  const data = JSON.parse(seen.calls[0].messages[1].content);
  assert.deepEqual(data.pages.map((page) => page.url), ["https://poe.com/pricing"]);
  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(report.kind, "market_intel");
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  assert.deepEqual(report.payload.facts.map((row) => [row.competitorId, row.sourceUrl]), [["poe", "https://poe.com/pricing"]]);
  assert.equal(report.payload.unrepresentableFactCount, 1);
});

test("nothing is asked or reported when no competitor has a tracked page", async () => {
  for (const tracked of [[], [{ ...poe, trackedPages: [] }]]) {
    const { deps, seen } = ports({ readContext: async () => context(tracked) });
    const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
    assert.equal(summary.calls, 0);
    assert.equal(summary.report, null);
    assert.equal(summary.stoppedAt, null);
    assert.equal(seen.reports.length, 0);
  }
  // An app older than the registry sends no field at all: nobody is tracked.
  const { deps } = ports({ readContext: async () => ({ channels: [] }) });
  assert.equal((await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps)).stoppedAt, null);
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
  assert.equal(seen.pages.length, 0);
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
  assert.equal(flaky.seen.calls.length, 1, "never a second call to the provider");

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

test("an unreadable context stops before any page is read", async () => {
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
    assert.equal(seen.pages.length, 0);
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

test("a page read cut off by the deadline is a read that did not happen", async () => {
  const { deps } = ports({
    fetchPage: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  const summary = await runMarketingA3Cycle({ generatorRunId: "run-1", deadlineAt: DEADLINE }, deps);
  assert.deepEqual(summary.pagesRefused, { timeout: 2 });
  assert.equal(summary.calls, 0);
  assert.equal(summary.stoppedAt, null);
});

test("with too little time left the report is not sent, which is a deadline and not a failure", async () => {
  let clock = NOW;
  const { deps, seen } = ports({
    now: () => clock,
    callLlm: async (messages, requestKey) => {
      // The call returns with less than the report's margin left.
      clock = Date.parse(DEADLINE) - MARKETING_A3_REPORT_MARGIN_MS + 1;
      return {
        status: "answered",
        callId: "c",
        requestKey,
        content: JSON.stringify({ facts: [fact("https://poe.com/pricing")], unrepresentable: 0 }),
        ledgerState: "settled",
      };
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
    trackedPages: [longUrl],
  }));
  const { deps, seen } = ports({
    readContext: async () => context(competitorsList),
    fetchPage: async (url) => ({ ok: true, page: { url, text: "numbers" } }),
    callLlm: async (messages, requestKey) => ({
      status: "answered",
      callId: "c",
      requestKey,
      content: JSON.stringify({ facts: many, unrepresentable: 0 }),
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
