// Building the ops snapshot the observers read (docs/policy/sre-ops.md §1,
// §3 rule 7). The app computes each section from functions it already has --
// the readiness checks /api/ready runs, the scheduled-jobs dashboard, the
// provider budget statuses -- and this module turns their results into the
// closed shape envelope-schema-core.mjs parses: names and booleans, bands,
// minute- and hour-truncated instants. Nothing else crosses: no error string,
// no last error, no micro-USD, no count a person produced.
//
// A section whose computation failed is "unknown", and only the keys that
// read it become unknown. The built snapshot is run through parseSnapshot()
// before it is returned, so the app cannot emit a shape the runner refuses.

import { FAILURE_BANDS, SNAPSHOT_SCHEMA_VERSION, parseSnapshot } from "./envelope-schema-core.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ZERO_SHA = "0".repeat(40);

const floorIso = (value, unit) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / unit) * unit).toISOString();
};

/** Consecutive failures as a band; the exact count is not exported. */
export function failureBand(count) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return FAILURE_BANDS[Math.min(count, 3)];
}

/**
 * The utilisation band of one provider window. Exhausted means nothing is
 * left, whatever the ratio says; otherwise the thresholds are the ones the
 * budget levels use (notice 70, warning 85, critical 95).
 */
export function utilisationBand({ usedMicroUsd, limitMicroUsd }) {
  if (!Number.isFinite(usedMicroUsd) || !Number.isFinite(limitMicroUsd) || limitMicroUsd <= 0) return null;
  if (usedMicroUsd >= limitMicroUsd) return "exhausted";
  const ratio = usedMicroUsd / limitMicroUsd;
  if (ratio >= 0.95) return ">=95";
  if (ratio >= 0.85) return "85-95";
  if (ratio >= 0.7) return "70-85";
  return "<70";
}

function readinessSection(checks) {
  if (checks === null || typeof checks !== "object") return "unknown";
  const out = {};
  for (const [name, value] of Object.entries(checks)) {
    if (typeof value !== "boolean") return "unknown";
    out[name] = value;
  }
  return out;
}

function jobsSection(jobs) {
  if (!Array.isArray(jobs)) return "unknown";
  return jobs.map((job) => ({
    key: job.key,
    delayed: job.delayed === true,
    stuck: job.status === "stuck",
    lastRunAt: job.lastRunAt ? floorIso(job.lastRunAt, MINUTE) : null,
    lastSuccessAt: job.lastSuccessAt ? floorIso(job.lastSuccessAt, MINUTE) : null,
    consecutiveFailuresBand: failureBand(job.consecutiveFailures),
  }));
}

function budgetsSection(report) {
  if (!report || report.usageUnavailable === true || !Array.isArray(report.providers)) return "unknown";
  return report.providers.flatMap((provider) =>
    (provider.periods ?? []).map((period) => ({
      provider: provider.provider,
      scope: period.period,
      utilisationBand: utilisationBand(period),
      resetAt: floorIso(period.resetAt, HOUR),
    })),
  );
}

const settled = (result, build) => (result && result.status === "fulfilled" ? build(result.value) : "unknown");

/**
 * Builds and validates the snapshot. Each section argument is a
 * Promise.allSettled result: { status: "fulfilled", value } or a rejection.
 * Returns { ok: true, snapshot } or { ok: false, reason } from parseSnapshot.
 */
export function buildSnapshot({ readiness, jobs, budgets, now, commitSha }) {
  const value = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: floorIso(now, MINUTE),
    // A build without a recorded commit says so with zeros rather than leaving
    // the field out; the runner reads it for the digest, never for a decision.
    commitSha: typeof commitSha === "string" && /^[0-9a-f]{40}$/.test(commitSha) ? commitSha : ZERO_SHA,
    readiness: settled(readiness, (v) => readinessSection(v?.checks)),
    scheduledJobs: settled(jobs, jobsSection),
    providerBudgets: settled(budgets, budgetsSection),
  };
  return parseSnapshot(value);
}

/** How long one section may take before it is reported unknown. */
export const SECTION_TIMEOUT_MS = 5_000;

/**
 * Settles `promise` within `ms`, in Promise.allSettled's shape. A source that
 * never answers -- an exhausted pool, a database that accepts and stalls --
 * becomes a rejection here, so its section is unknown and the others still
 * go out. The source keeps running; the snapshot no longer waits for it.
 */
export function settleWithin(promise, ms = SECTION_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("ops_snapshot_section_timeout")), ms);
  });
  return Promise.race([promise, timeout])
    .then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    )
    .finally(() => clearTimeout(timer));
}
