// The closed shape of the ops snapshot, and how one snapshot becomes one
// observation per S2 page key.
//
// docs/policy/sre-ops.md §1 and §3 rule 7 are the contract. The runner and the
// app both import this module, so the app cannot emit a field the runner does
// not check, and the runner cannot read a field the app does not send. Parsing
// is closed: an unknown field, a wrong type or a value outside its enum makes
// the whole snapshot invalid, and an invalid snapshot is treated exactly like
// a failed one. No free text crosses this boundary -- no error string, no
// message, no user or trace id.
//
// Each section can independently be the string "unknown" when the app could not
// compute it; then only the keys that read that section are unknown. An empty
// readiness object is invalid (readiness always has checks), while an empty job
// or budget list is valid and simply leaves those keys unknown. A parsed
// snapshot is a frozen copy, so a caller cannot change it after validation.

import { S2_PAGE_SIGNALS } from "./classify-core.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const FAILURE_BANDS = ["0", "1", "2", "3+"];
export const UTILISATION_BANDS = ["<70", "70-85", "85-95", ">=95", "exhausted"];
export const BUDGET_SCOPES = ["day", "month"];

const TOP_LEVEL_FIELDS = ["schemaVersion", "generatedAt", "commitSha", "readiness", "scheduledJobs", "providerBudgets"];
const JOB_FIELDS = ["key", "delayed", "stuck", "lastRunAt", "lastSuccessAt", "consecutiveFailuresBand"];
const BUDGET_FIELDS = ["provider", "scope", "utilisationBand", "resetAt"];

const IDENTIFIER = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const MINUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const HOUR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_ENTRIES = 64;

/** Returns `{ ok: true, snapshot }` or `{ ok: false, reason }` (an enum). */
export function parseSnapshot(value) {
  if (!isPlainObject(value)) return invalid("not_object");
  if (!sameKeys(value, TOP_LEVEL_FIELDS)) return invalid("fields");
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return invalid("schema_version");
  if (!isInstant(value.generatedAt, MINUTE_INSTANT)) return invalid("generated_at");
  if (typeof value.commitSha !== "string" || !COMMIT_SHA.test(value.commitSha)) return invalid("commit_sha");

  if (value.readiness !== "unknown") {
    if (!isPlainObject(value.readiness)) return invalid("readiness");
    const entries = Object.entries(value.readiness);
    if (entries.length === 0 || entries.length > MAX_ENTRIES) return invalid("readiness");
    if (entries.some(([name, ok]) => !IDENTIFIER.test(name) || typeof ok !== "boolean")) return invalid("readiness");
  }

  if (value.scheduledJobs !== "unknown") {
    if (!Array.isArray(value.scheduledJobs) || value.scheduledJobs.length > MAX_ENTRIES) return invalid("scheduled_jobs");
    const seen = new Set();
    for (const job of value.scheduledJobs) {
      if (!isPlainObject(job) || !sameKeys(job, JOB_FIELDS)) return invalid("scheduled_jobs");
      if (!IDENTIFIER.test(job.key ?? "") || seen.has(job.key)) return invalid("scheduled_jobs");
      seen.add(job.key);
      if (typeof job.delayed !== "boolean" || typeof job.stuck !== "boolean") return invalid("scheduled_jobs");
      if (!FAILURE_BANDS.includes(job.consecutiveFailuresBand)) return invalid("scheduled_jobs");
      for (const at of [job.lastRunAt, job.lastSuccessAt]) {
        if (at !== null && !isInstant(at, MINUTE_INSTANT)) return invalid("scheduled_jobs");
      }
    }
  }

  if (value.providerBudgets !== "unknown") {
    if (!Array.isArray(value.providerBudgets) || value.providerBudgets.length > MAX_ENTRIES) return invalid("provider_budgets");
    const seen = new Set();
    for (const budget of value.providerBudgets) {
      if (!isPlainObject(budget) || !sameKeys(budget, BUDGET_FIELDS)) return invalid("provider_budgets");
      if (!IDENTIFIER.test(budget.provider ?? "") || !BUDGET_SCOPES.includes(budget.scope)) return invalid("provider_budgets");
      const id = `${budget.provider}#${budget.scope}`;
      if (seen.has(id)) return invalid("provider_budgets");
      seen.add(id);
      if (!UTILISATION_BANDS.includes(budget.utilisationBand)) return invalid("provider_budgets");
      if (!isInstant(budget.resetAt, HOUR_INSTANT)) return invalid("provider_budgets");
    }
  }

  return { ok: true, snapshot: deepFreeze(structuredClone(value)) };
}

/**
 * One observation per S2 page key, keyed `signal#scope`.
 *
 * `healthOk` is whether `/api/health` answered; `snapshot` is a value that
 * passed `parseSnapshot`, or `null` when the snapshot request failed or the
 * value was invalid. When health itself did not answer, every key is
 * `unknown`: the whole-app outage is P8's to report, not a page key's.
 */
export function observationsFromSnapshot({ healthOk, snapshot }) {
  const out = {};
  const set = (signalId, scope, observation) => (out[`${signalId}#${scope}`] = observation);

  for (const signal of S2_PAGE_SIGNALS) {
    for (const scope of signal.scopes) set(signal.id, scope, "unknown");
  }
  if (!healthOk) return out;

  // P1u is "readiness cannot be judged" (policy §1): a snapshot that answered
  // but could not compute readiness is that failure too, or a readiness
  // computation that keeps throwing or timing out would leave the core keys
  // unknown and page nothing.
  set("P1u", "snapshot", snapshot && snapshot.readiness !== "unknown" ? "ok" : "failed");
  if (!snapshot) return out;

  if (snapshot.readiness !== "unknown") {
    for (const signalId of ["P1a", "P1b", "P1c"]) {
      const signal = S2_PAGE_SIGNALS.find((s) => s.id === signalId);
      for (const scope of signal.scopes) {
        const value = snapshot.readiness[scope];
        set(signalId, scope, value === true ? "ok" : value === false ? "false" : "unknown");
      }
    }
  }

  if (snapshot.scheduledJobs !== "unknown") {
    const job = (key) => snapshot.scheduledJobs.find((j) => j.key === key);
    const reconciliation = job("credit_reservation_reconciliation");
    set(
      "P3",
      "credit_reservation_reconciliation",
      !reconciliation ? "unknown" : reconciliation.stuck ? "stuck" : reconciliation.delayed ? "delayed" : "ok",
    );
    const drain = job("standard_email_drain");
    set(
      "P-D",
      "standard_email_drain",
      !drain ? "unknown" : drain.consecutiveFailuresBand === "3+" ? "failures_3_plus" : "ok",
    );
  }
  return out;
}

/** Readiness check names the snapshot reported that are not page keys (policy §1 item 3). */
export function digestReadinessNames(snapshot) {
  if (!snapshot || snapshot.readiness === "unknown") return [];
  const pageScopes = new Set(
    S2_PAGE_SIGNALS.filter((s) => ["P1a", "P1b", "P1c"].includes(s.id)).flatMap((s) => s.scopes),
  );
  return Object.keys(snapshot.readiness).filter((name) => !pageScopes.has(name)).sort();
}

function deepFreeze(v) {
  if (v && typeof v === "object") {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function sameKeys(obj, fields) {
  const keys = Object.keys(obj);
  return keys.length === fields.length && fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

function isInstant(value, pattern) {
  return typeof value === "string" && pattern.test(value) && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function invalid(reason) {
  return { ok: false, reason };
}
