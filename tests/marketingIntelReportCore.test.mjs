import assert from "node:assert/strict";
import test from "node:test";

import {
  marketIntelSourceAllowed,
  marketingGeneratorReportDigest,
  marketingGeneratorReportKey,
  marketingGeneratorReportProvenance,
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
  marketingGeneratorReportStoredPayload,
} from "@/lib/marketingIntelReportCore";

const SECRET = "g".repeat(48);
const HOSTS = Object.freeze({ poe: ["poe.com"] });

const fact = (overrides = {}) => ({
  competitorId: "poe",
  factType: "launch_date",
  value: { kind: "date", value: "2026-10-01" },
  sourceUrl: "https://poe.com/blog/launch",
  checkedAt: "2026-10-16T00:00:00.000Z",
  ...overrides,
});

const unsigned = (overrides = {}) => ({
  generatorRunId: "run-1",
  reportId: "intel-1",
  kind: "market_intel",
  periodStart: "2026-10-09T00:00:00.000Z",
  periodEnd: "2026-10-16T00:00:00.000Z",
  deadlineAt: "2026-10-16T01:00:00.000Z",
  payload: { facts: [fact()], unrepresentableFactCount: 0 },
  ...overrides,
});
const signed = (overrides = {}) => {
  const report = unsigned(overrides);
  return { ...report, provenance: marketingGeneratorReportProvenance(SECRET, report) };
};

test("only a brief or market facts, strictly shaped, with a period that runs forwards", () => {
  assert.equal(marketingGeneratorReportSchema.safeParse(signed()).success, true);
  assert.equal(
    marketingGeneratorReportSchema.safeParse(
      signed({ kind: "brief", payload: { topicIds: ["t"], claimIds: [], sourceDigests: [] } }),
    ).success,
    true,
  );
  for (const kind of ["weekly_kpi", "retention_run", "webhook_shadow", "measurement_120d"]) {
    assert.equal(marketingGeneratorReportSchema.safeParse(signed({ kind })).success, false, kind);
  }
  assert.equal(marketingGeneratorReportSchema.safeParse({ ...signed(), verdict: "ok" }).success, false);
  assert.equal(
    marketingGeneratorReportSchema.safeParse(signed({ periodStart: "2026-10-17T00:00:00.000Z" })).success,
    false,
  );
});

test("the signature covers every field but itself, the deadline included", () => {
  const report = signed();
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  assert.equal(marketingGeneratorReportProvenanceMatches("h".repeat(48), report), false);
  for (const change of [
    { reportId: "intel-2" },
    { deadlineAt: "2026-10-16T02:00:00.000Z" },
    { payload: { facts: [fact()], unrepresentableFactCount: 1 } },
  ]) {
    assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, { ...report, ...change }), false);
  }
});

test("the key names the report; the digest names its bytes", () => {
  const a = unsigned();
  assert.equal(marketingGeneratorReportKey(a), marketingGeneratorReportKey({ ...a, payload: { facts: [], unrepresentableFactCount: 0 } }));
  assert.notEqual(marketingGeneratorReportKey(a), marketingGeneratorReportKey({ ...a, kind: "brief" }));
  assert.notEqual(marketingGeneratorReportKey(a), marketingGeneratorReportKey({ ...a, generatorRunId: "run-2" }));
  assert.notEqual(
    marketingGeneratorReportDigest(a),
    marketingGeneratorReportDigest({ ...a, deadlineAt: "2026-10-16T02:00:00.000Z" }),
  );
});

test("with no approved competitor, no fact is kept", () => {
  const stored = marketingGeneratorReportStoredPayload(signed(), {});
  assert.deepEqual(stored, { payload: { facts: [], unrepresentableFactCount: 1 }, droppedFactCount: 1 });
});

const candidate = (overrides = {}) => ({
  competitorId: "alpha",
  displayName: "Alpha",
  officialHosts: ["alpha.example"],
  evidenceUrls: ["https://alpha.example/pricing"],
  rationale: "Sells the same comparison.",
  ...overrides,
});

test("market facts may carry up to five signed competitor candidates, each once", () => {
  assert.equal(marketingGeneratorReportSchema.safeParse(signed({ competitorCandidates: [candidate()] })).success, true);
  assert.equal(
    marketingGeneratorReportSchema.safeParse(
      signed({ competitorCandidates: Array.from({ length: 6 }, (_, i) => candidate({ competitorId: `c${i}` })) }),
    ).success,
    false,
  );
  assert.equal(
    marketingGeneratorReportSchema.safeParse(signed({ competitorCandidates: [candidate(), candidate()] })).success,
    false,
  );
  assert.equal(
    marketingGeneratorReportSchema.safeParse(signed({ competitorCandidates: [candidate({ status: "approved" })] })).success,
    false,
  );
  // A brief proposes nothing.
  assert.equal(
    marketingGeneratorReportSchema.safeParse(
      signed({ kind: "brief", payload: { topicIds: ["t"], claimIds: [], sourceDigests: [] }, competitorCandidates: [] }),
    ).success,
    false,
  );
  // The candidates are signed: changing one changes the report.
  const a = unsigned({ competitorCandidates: [candidate()] });
  assert.notEqual(
    marketingGeneratorReportDigest(a),
    marketingGeneratorReportDigest({ ...a, competitorCandidates: [candidate({ officialHosts: ["evil.example"] })] }),
  );
  // A candidate is sent in its stored form, so the signed bytes are the
  // verified bytes: anything normalisation would change is refused.
  for (const overrides of [
    { officialHosts: ["www.alpha.example", "alpha.example"] },
    { officialHosts: ["Alpha.example"] },
    { officialHosts: ["alpha.example", "alpha.example"] },
    { displayName: " Alpha" },
    { rationale: "Sells the same comparison. " },
  ]) {
    assert.equal(
      marketingGeneratorReportSchema.safeParse(signed({ competitorCandidates: [candidate(overrides)] })).success,
      false,
      JSON.stringify(overrides),
    );
  }
  assert.equal(
    marketingGeneratorReportSchema.safeParse(
      signed({ competitorCandidates: [candidate({ officialHosts: ["alpha.example", "www.alpha.example"] })] }),
    ).success,
    true,
  );
  // Proposing nothing leaves the bytes as they were before candidates existed.
  assert.equal(marketingGeneratorReportDigest(unsigned()), marketingGeneratorReportDigest({ ...unsigned(), competitorCandidates: undefined }));
});

test("a fact is kept only for an exact official host of its own competitor", () => {
  assert.equal(marketIntelSourceAllowed(fact(), HOSTS), true);
  assert.equal(marketIntelSourceAllowed(fact({ sourceUrl: "https://POE.com/x" }), HOSTS), true);
  for (const sourceUrl of [
    "https://blog.poe.com/launch",
    "https://poe.com.example.net/launch",
    "https://poe.com:8443/launch",
    "https://user@poe.com/launch",
    "http://poe.com/launch",
    "not a url",
  ]) {
    assert.equal(marketIntelSourceAllowed(fact({ sourceUrl }), HOSTS), false, sourceUrl);
  }
  assert.equal(marketIntelSourceAllowed(fact({ competitorId: "other" }), HOSTS), false);
  assert.equal(marketIntelSourceAllowed(fact({ competitorId: "constructor" }), HOSTS), false);
  assert.equal(marketIntelSourceAllowed(fact({ competitorId: "__proto__" }), HOSTS), false);
});

test("facts that cannot be kept are counted with the unrepresentable ones, a brief is kept as sent", () => {
  const report = signed({
    payload: { facts: [fact(), fact({ sourceUrl: "https://elsewhere.example/x" })], unrepresentableFactCount: 2 },
  });
  assert.deepEqual(marketingGeneratorReportStoredPayload(report, HOSTS), {
    payload: { facts: [fact()], unrepresentableFactCount: 3 },
    droppedFactCount: 1,
  });
  const brief = signed({ kind: "brief", payload: { topicIds: ["t"], claimIds: [], sourceDigests: [] } });
  assert.deepEqual(marketingGeneratorReportStoredPayload(brief, HOSTS), { payload: brief.payload, droppedFactCount: 0 });
});
