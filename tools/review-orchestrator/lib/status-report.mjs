/**
 * The status report the daemon sends to the Tomverse app's Agent office.
 *
 * The app cannot reach this server (it is behind SSH), so the daemon pushes a
 * small snapshot about once a minute to `statusReport.url`. The snapshot is
 * content-free by construction: per reviewer its id, vendor, whether it is
 * enabled and how many reviews it runs out of how many it may; how many jobs
 * wait for a reviewer; whether the server is draining; and the last 24 hours'
 * verdict counts. No job id, author, branch, scope, diff, finding or reviewer
 * text is read into it. The app refuses any other field
 * (lib/reviewOrchestratorStatusCore.ts in the app).
 *
 * Reporting is telemetry. It never decides anything here: a failed or slow
 * report does not delay, skip or change a review.
 */
import { aggregate } from "./verdict.mjs";

export const STATUS_REPORT_SECRET_ENV = "REVIEW_ORCHESTRATOR_STATUS_SECRET";
export const STATUS_REPORT_MIN_SECRET_LENGTH = 32;
export const STATUS_REPORT_DEFAULT_INTERVAL_SECONDS = 60;
export const STATUS_REPORT_TIMEOUT_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;
// The app's limits: ids and vendors are short machine names, at most 16
// reviewers, at most 64 slots each.
const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROVIDERS = 16;
const MAX_SLOTS = 64;
const MAX_COUNT = 100_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** The snapshot for one moment. `jobs` is `Store.listJobs()`, `load` is `computeLoad(jobs, now)`. */
export function buildStatusSnapshot({ jobs, providers, load, draining, now }) {
  const last24h = { accept: 0, reject: 0, unknown: 0 };
  let pendingJobs = 0;
  for (const { slots } of jobs) {
    if (slots.some((slot) => slot.status === "queued")) pendingJobs += 1;
    const status = aggregate(slots);
    if (status === "pending") continue;
    const endedAt = Math.max(...slots.map((slot) => (Number.isFinite(slot.endedAt) ? slot.endedAt : 0)));
    if (now - endedAt >= DAY_MS) continue;
    last24h[status === "accept" || status === "reject" ? status : "unknown"] += 1;
  }
  return {
    schemaVersion: 1,
    draining: draining === true,
    pendingJobs: Math.min(pendingJobs, MAX_COUNT),
    providers: providers
      .filter((provider) => MACHINE_NAME.test(provider.id ?? ""))
      .slice(0, MAX_PROVIDERS)
      .map((provider) => ({
        id: provider.id,
        vendor: MACHINE_NAME.test(provider.vendor ?? "") ? provider.vendor : "unknown",
        enabled: provider.enabled === true,
        running: clamp(load[provider.id]?.running ?? 0, 0, MAX_SLOTS),
        maxConcurrent: clamp(Number.isInteger(provider.maxConcurrent) ? provider.maxConcurrent : 1, 1, MAX_SLOTS),
      })),
    last24h: {
      accept: Math.min(last24h.accept, MAX_COUNT),
      reject: Math.min(last24h.reject, MAX_COUNT),
      unknown: Math.min(last24h.unknown, MAX_COUNT),
    },
  };
}

/**
 * The secret from the daemon's environment, or null when reporting cannot
 * run. Never logged, never passed to a reviewer (config refuses it in
 * `passEnv`).
 */
export function statusReportSecret(env = process.env) {
  const secret = env[STATUS_REPORT_SECRET_ENV];
  return typeof secret === "string" && secret.length >= STATUS_REPORT_MIN_SECRET_LENGTH ? secret : null;
}

/**
 * One POST. Resolves to the HTTP status, or a short reason when no answer
 * came. Redirects are refused: the bearer secret goes to the configured URL
 * and nowhere else.
 */
export async function sendStatusReport({ url, secret, snapshot, fetchImpl = fetch, timeoutMs = STATUS_REPORT_TIMEOUT_MS }) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(snapshot),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is a result code at most; it is not read.
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.status === 200, outcome: `http_${response.status}` };
  } catch (error) {
    return { ok: false, outcome: error?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

/**
 * The daemon's reporter: sends at most one report at a time, no more often
 * than the interval, and logs only when the outcome changes, so a route that
 * is not deployed yet is one line in the journal rather than one a minute.
 * Returns null when `statusReport` is not configured or the secret is
 * missing -- the review server runs exactly as before.
 */
export function createStatusReporter({ config, env = process.env, log, snapshot, fetchImpl = fetch, now = Date.now }) {
  const target = config.statusReport;
  if (!target) return null;
  const secret = statusReportSecret(env);
  if (secret === null) {
    log(`status report off: ${STATUS_REPORT_SECRET_ENV} is missing or shorter than ${STATUS_REPORT_MIN_SECRET_LENGTH} characters`);
    return null;
  }
  const intervalMs = target.intervalSeconds * 1000;
  let nextAt = 0;
  let inflight = null;
  let lastOutcome = null;
  return {
    /** Called every daemon tick; returns immediately. */
    maybeSend() {
      if (inflight || now() < nextAt) return;
      nextAt = now() + intervalMs;
      let body;
      try {
        body = snapshot();
      } catch (error) {
        log(`status report skipped: ${error.message}`);
        return;
      }
      inflight = sendStatusReport({ url: target.url, secret, snapshot: body, fetchImpl }).then(({ outcome }) => {
        if (outcome !== lastOutcome) log(`status report ${outcome === "http_200" ? "ok" : `failed: ${outcome}`}`);
        lastOutcome = outcome;
      }).finally(() => {
        inflight = null;
      });
    },
    /** For tests and shutdown: the report in flight, if any. */
    settled: () => inflight ?? Promise.resolve(),
  };
}
