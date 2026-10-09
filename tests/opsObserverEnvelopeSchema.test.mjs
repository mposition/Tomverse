// The snapshot boundary (docs/policy/sre-ops.md §1, §3 rule 7): parsing is
// closed, no free text crosses, a section can be unknown on its own, and a
// snapshot maps onto exactly the eight S2 page keys.

import assert from "node:assert/strict";
import test from "node:test";

import { S2_PAGE_KEYS } from "../scripts/ops-observer/classify-core.mjs";
import {
  digestReadinessNames,
  observationsFromSnapshot,
  parseSnapshot,
} from "../scripts/ops-observer/envelope-schema-core.mjs";

const READINESS = {
  database: true,
  securityEnvironment: true,
  providerBudgets: true,
  imageProviderBudget: true,
  voiceProviderBudget: true,
  voiceModelPrice: true,
  searchProviderBudget: true,
  emailSendingIdentity: true,
  emailSnapshotKeyring: true,
  emailUnsubscribeKeyring: true,
  emailUnsubscribeKeyRetention: true,
  emailConsentKeyring: true,
  emailBusinessIdentity: true,
  emailSubjectLabels: true,
  emailFooterDisclosures: true,
  amuxReviewApproval: true,
  emailBiennialConsentNotice: true,
};

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-05T03:20:00.000Z",
    commitSha: "a".repeat(40),
    readiness: { ...READINESS },
    scheduledJobs: [
      job("credit_reservation_reconciliation"),
      job("standard_email_drain"),
    ],
    providerBudgets: [
      { provider: "openai", scope: "day", utilisationBand: "<70", resetAt: "2026-10-06T00:00:00.000Z" },
    ],
    ...overrides,
  };
}

function job(key, extra = {}) {
  return {
    key,
    delayed: false,
    stuck: false,
    lastRunAt: "2026-10-05T03:15:00.000Z",
    lastSuccessAt: "2026-10-05T03:15:00.000Z",
    consecutiveFailuresBand: "0",
    ...extra,
  };
}

test("a well-formed snapshot parses", () => {
  assert.deepEqual(parseSnapshot(snapshot()).ok, true);
  assert.equal(parseSnapshot(snapshot({ readiness: "unknown", scheduledJobs: "unknown", providerBudgets: "unknown" })).ok, true);
});

test("parsing is closed: extra fields, free text and out-of-enum values are refused", () => {
  const cases = [
    [{ ...snapshot(), lastError: "boom" }, "fields"],
    [snapshot({ schemaVersion: 2 }), "schema_version"],
    [snapshot({ generatedAt: "2026-10-05T03:20:17.000Z" }), "generated_at"],
    [snapshot({ generatedAt: "2026-02-30T00:00:00.000Z" }), "generated_at"],
    [snapshot({ commitSha: "HEAD" }), "commit_sha"],
    [snapshot({ readiness: { database: "false" } }), "readiness"],
    [snapshot({ readiness: { "drop table": true } }), "readiness"],
    [snapshot({ readiness: {} }), "readiness"],
    [snapshot({ scheduledJobs: [{ ...job("x"), lastError: "Error: secret" }] }), "scheduled_jobs"],
    [snapshot({ scheduledJobs: [job("x", { consecutiveFailuresBand: "4" })] }), "scheduled_jobs"],
    [snapshot({ scheduledJobs: [job("x"), job("x")] }), "scheduled_jobs"],
    [snapshot({ scheduledJobs: [job("x", { lastRunAt: "yesterday" })] }), "scheduled_jobs"],
    [snapshot({ providerBudgets: [{ provider: "openai", scope: "week", utilisationBand: "<70", resetAt: "2026-10-06T00:00:00.000Z" }] }), "provider_budgets"],
    [snapshot({ providerBudgets: [{ provider: "openai", scope: "day", utilisationBand: "<70", resetAt: "2026-10-06T00:30:00.000Z" }] }), "provider_budgets"],
    [snapshot({ providerBudgets: [{ provider: "openai", scope: "day", utilisationBand: "12345 microusd", resetAt: "2026-10-06T00:00:00.000Z" }] }), "provider_budgets"],
    [null, "not_object"],
    [[snapshot()], "not_object"],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(parseSnapshot(value), { ok: false, reason }, JSON.stringify(value)?.slice(0, 80));
  }
});

test("a healthy snapshot maps to ok on exactly the eight page keys", () => {
  const obs = observationsFromSnapshot({ healthOk: true, snapshot: snapshot() });
  assert.deepEqual(Object.keys(obs).sort(), [...S2_PAGE_KEYS].sort());
  assert.ok(Object.values(obs).every((o) => o === "ok"));
});

test("failing checks and jobs map to their bands", () => {
  const obs = observationsFromSnapshot({
    healthOk: true,
    snapshot: snapshot({
      readiness: { ...READINESS, database: false, emailSnapshotKeyring: false },
      scheduledJobs: [
        job("credit_reservation_reconciliation", { delayed: true, stuck: true }),
        job("standard_email_drain", { consecutiveFailuresBand: "3+" }),
      ],
    }),
  });
  assert.equal(obs["P1a#database"], "false");
  assert.equal(obs["P1c#emailSnapshotKeyring"], "false");
  assert.equal(obs["P1a#securityEnvironment"], "ok");
  assert.equal(obs["P3#credit_reservation_reconciliation"], "stuck");
  assert.equal(obs["P-D#standard_email_drain"], "failures_3_plus");
});

test("a failed snapshot with health answering is P1u, and everything else is unknown", () => {
  const obs = observationsFromSnapshot({ healthOk: true, snapshot: null });
  assert.equal(obs["P1u#snapshot"], "failed");
  assert.ok(Object.entries(obs).filter(([k]) => k !== "P1u#snapshot").every(([, o]) => o === "unknown"));
});

test("health not answering makes every key unknown (P8 reports the outage)", () => {
  const obs = observationsFromSnapshot({ healthOk: false, snapshot: null });
  assert.ok(Object.values(obs).every((o) => o === "unknown"));
});

test("an unknown section makes only its keys unknown; a missing job or check is unknown, not ok", () => {
  const obs = observationsFromSnapshot({
    healthOk: true,
    snapshot: snapshot({ readiness: "unknown", scheduledJobs: [job("standard_email_drain")] }),
  });
  assert.equal(obs["P1a#database"], "unknown");
  assert.equal(obs["P3#credit_reservation_reconciliation"], "unknown");
  assert.equal(obs["P-D#standard_email_drain"], "ok");
  // Readiness that could not be computed is P1u's failure, not a quiet unknown.
  assert.equal(obs["P1u#snapshot"], "failed");
  // Another section's unknown leaves P1u ok: it is about readiness only.
  const jobsUnknown = observationsFromSnapshot({ healthOk: true, snapshot: snapshot({ scheduledJobs: "unknown" }) });
  assert.equal(jobsUnknown["P1u#snapshot"], "ok");
  assert.equal(jobsUnknown["P3#credit_reservation_reconciliation"], "unknown");

  const noCheck = { ...READINESS };
  delete noCheck.providerBudgets;
  assert.equal(observationsFromSnapshot({ healthOk: true, snapshot: snapshot({ readiness: noCheck }) })["P1b#providerBudgets"], "unknown");
});

test("every non-page readiness check is listed for the digest, including ones added later", () => {
  assert.deepEqual(digestReadinessNames(snapshot()), [
    "amuxReviewApproval",
    "emailBiennialConsentNotice",
    "emailBusinessIdentity",
    "emailConsentKeyring",
    "emailFooterDisclosures",
    "emailSubjectLabels",
    "emailUnsubscribeKeyRetention",
    "emailUnsubscribeKeyring",
    "imageProviderBudget",
    "searchProviderBudget",
    "voiceModelPrice",
    "voiceProviderBudget",
  ]);
  assert.ok(digestReadinessNames(snapshot({ readiness: { ...READINESS, brandNewCheck: false } })).includes("brandNewCheck"));
});

test("a parsed snapshot is a frozen copy", () => {
  const input = snapshot();
  const { snapshot: parsed } = parseSnapshot(input);
  input.readiness.database = false;
  assert.equal(parsed.readiness.database, true);
  assert.throws(() => {
    parsed.readiness.database = false;
  }, TypeError);
});
