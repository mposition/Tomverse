/**
 * The daemon's half of the status report for the Tomverse app's Agent office.
 *
 * The daemon runs as the review account, and so does every reviewer CLI it
 * starts -- a reviewer reads the change under review, which can ask it to
 * print any file or process environment that account can read. So the daemon
 * holds no credential for the app. It only writes a content-free snapshot
 * file (`statusSnapshot.dir`) once a minute.
 *
 * The other half is bin/review-status-sender.mjs: a single file that imports
 * only Node built-ins, installed root-owned outside the review account's
 * checkout and run under its own account (deploy/review-status-sender.service,
 * systemd DynamicUser). It holds the bearer secret, rebuilds the snapshot
 * field by field and POSTs it. The review account can read neither its secret
 * nor its environment, and cannot change the code it runs.
 *
 * The snapshot is content-free by construction: per reviewer its id, vendor,
 * whether it is enabled, how many reviews it runs out of how many it may, and
 * its account quota as the daemon's own probe last read it (a state and one
 * number);
 * how many jobs wait for a reviewer; whether the server is draining; and the
 * last 24 hours' verdict counts. No job id, author, branch, scope, diff,
 * finding or reviewer text is read into it.
 *
 * Reporting is telemetry. It never decides anything here: a failed write does
 * not delay, skip or change a review.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { aggregate } from "./verdict.mjs";

/** The sender's secret. No provider may be given it (config refuses it in passEnv). */
export const STATUS_REPORT_SECRET_ENV = "REVIEW_ORCHESTRATOR_STATUS_SECRET";
export const STATUS_SNAPSHOT_FILE = "snapshot.json";
/**
 * Fixed, not configurable: the sender treats a snapshot older than three of
 * these as a stopped daemon, and the app treats five minutes without a report
 * as a lost server. A knob here would let the two drift apart.
 */
export const STATUS_SNAPSHOT_INTERVAL_SECONDS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
// The app's limits: ids and vendors are short machine names, at most 16
// reviewers, at most 64 slots each. The sender checks the same limits.
const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROVIDERS = 16;
const MAX_SLOTS = 64;
const MAX_COUNT = 100_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const QUOTA_STATES = ["available", "exhausted", "unknown", "disabled"];
export const QUOTA_UNITS = ["percent", "credits", "usd"];
const MAX_QUOTA_AMOUNT = 1_000_000_000;

/**
 * One provider's quota as lib/quota.mjs reports it, reduced to a state and
 * one amount: a percentage when the probe gives one, otherwise an amount in
 * credits or USD, otherwise none. Anything the probe did not say is unknown.
 */
export function quotaForSnapshot(quota) {
  const state = QUOTA_STATES.includes(quota?.state) ? quota.state : "unknown";
  if (state === "unknown" || state === "disabled") return { state, remaining: null, unit: null };
  if (Number.isFinite(quota.remainingPercent)) {
    return { state, remaining: Math.round(clamp(quota.remainingPercent, 0, 100) * 10) / 10, unit: "percent" };
  }
  if (Number.isFinite(quota.remaining) && QUOTA_UNITS.includes(quota.unit)) {
    const max = quota.unit === "percent" ? 100 : MAX_QUOTA_AMOUNT;
    return { state, remaining: Math.round(clamp(quota.remaining, 0, max) * 100) / 100, unit: quota.unit };
  }
  return { state, remaining: null, unit: null };
}

/**
 * The snapshot for one moment. `jobs` is `Store.listJobs()`, `load` is
 * `computeLoad(jobs, now)`, `quotas` is `readQuotaStatus(config)` (absent
 * entries read as unknown).
 */
export function buildStatusSnapshot({ jobs, providers, load, quotas = {}, draining, now }) {
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
        quota: quotaForSnapshot(quotas[provider.id]),
      })),
    last24h: {
      accept: Math.min(last24h.accept, MAX_COUNT),
      reject: Math.min(last24h.reject, MAX_COUNT),
      unknown: Math.min(last24h.unknown, MAX_COUNT),
    },
  };
}

/** Atomic and world-readable: the sender runs as another account. Content-free, so nothing is exposed. */
export function writeStatusSnapshot(dir, snapshot) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, STATUS_SNAPSHOT_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/**
 * Writes the snapshot no more often than once a minute and logs only when the
 * outcome changes. Returns null when `statusSnapshot` is not configured -- the
 * review server runs exactly as before.
 */
export function createStatusSnapshotWriter({ config, log, snapshot, now = Date.now, write = writeStatusSnapshot }) {
  const target = config.statusSnapshot;
  if (!target) return null;
  const intervalMs = STATUS_SNAPSHOT_INTERVAL_SECONDS * 1000;
  let nextAt = 0;
  let lastOutcome = null;
  const outcome = (value, line) => {
    if (value !== lastOutcome) log(line);
    lastOutcome = value;
  };
  return {
    /** Called every daemon tick; synchronous, one small file. */
    maybeWrite() {
      if (now() < nextAt) return;
      nextAt = now() + intervalMs;
      try {
        write(target.dir, snapshot());
        outcome("ok", "status snapshot written");
      } catch (error) {
        outcome(`failed:${error.code ?? error.message}`, `status snapshot failed: ${error.code ?? error.message}`);
      }
    },
  };
}
