/**
 * The status report for the Tomverse app's Agent office, in two halves that
 * never share an account.
 *
 * The daemon runs as the review account, and so does every reviewer CLI it
 * starts -- a reviewer reads the change under review, which can ask it to
 * print any file or process environment that account can read. So the daemon
 * holds no credential for the app. It only writes a content-free snapshot
 * file (`statusSnapshot.dir`) about once a minute.
 *
 * A separate sender (bin/review-status-sender.mjs) runs under its own account
 * (deploy/review-status-sender.service, systemd DynamicUser). It holds the
 * bearer secret, reads the snapshot, rebuilds it field by field and POSTs it
 * to the app's internal status route. The review account can neither read
 * that secret's file nor that process's environment.
 *
 * The snapshot is content-free by construction: per reviewer its id, vendor,
 * whether it is enabled and how many reviews it runs out of how many it may;
 * how many jobs wait for a reviewer; whether the server is draining; and the
 * last 24 hours' verdict counts. No job id, author, branch, scope, diff,
 * finding or reviewer text is read into it, and the sender forwards only
 * those fields -- whatever else the file holds is dropped. The app refuses any
 * other field (lib/reviewOrchestratorStatusCore.ts in the app).
 *
 * Reporting is telemetry. It never decides anything here: a failed write or
 * send does not delay, skip or change a review.
 */
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { aggregate } from "./verdict.mjs";

export const STATUS_REPORT_SECRET_ENV = "REVIEW_ORCHESTRATOR_STATUS_SECRET";
export const STATUS_REPORT_MIN_SECRET_LENGTH = 32;
export const STATUS_SNAPSHOT_DEFAULT_INTERVAL_SECONDS = 60;
export const STATUS_SNAPSHOT_FILE = "snapshot.json";
export const STATUS_REPORT_TIMEOUT_MS = 10_000;
/** The app's request cap; a larger file is not a snapshot this code wrote. */
export const STATUS_SNAPSHOT_MAX_BYTES = 8192;

const DAY_MS = 24 * 60 * 60 * 1000;
// The app's limits: ids and vendors are short machine names, at most 16
// reviewers, at most 64 slots each.
const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROVIDERS = 16;
const MAX_SLOTS = 64;
const MAX_COUNT = 100_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isCount = (value) => Number.isInteger(value) && value >= 0;

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
 * The snapshot rebuilt from a value read off disk, field by field, or null
 * when it is not one. The sender forwards only this: the file is written by
 * the review account, so anything beyond these fields is dropped, never sent.
 */
export function normaliseStatusSnapshot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { schemaVersion, draining, pendingJobs, providers, last24h } = value;
  if (schemaVersion !== 1 || typeof draining !== "boolean" || !isCount(pendingJobs)) return null;
  if (!Array.isArray(providers) || providers.length > MAX_PROVIDERS) return null;
  if (last24h === null || typeof last24h !== "object" || !["accept", "reject", "unknown"].every((key) => isCount(last24h[key]))) {
    return null;
  }
  const ids = new Set();
  const rebuilt = [];
  for (const provider of providers) {
    if (provider === null || typeof provider !== "object") return null;
    const { id, vendor, enabled, running, maxConcurrent } = provider;
    if (!MACHINE_NAME.test(id ?? "") || !MACHINE_NAME.test(vendor ?? "") || ids.has(id)) return null;
    if (typeof enabled !== "boolean" || !isCount(running) || !isCount(maxConcurrent) || maxConcurrent < 1) return null;
    if (running > MAX_SLOTS || maxConcurrent > MAX_SLOTS) return null;
    ids.add(id);
    rebuilt.push({ id, vendor, enabled, running, maxConcurrent });
  }
  return {
    schemaVersion: 1,
    draining,
    pendingJobs: Math.min(pendingJobs, MAX_COUNT),
    providers: rebuilt,
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
 * The daemon's half: writes the snapshot no more often than the interval and
 * logs only when the outcome changes. Returns null when `statusSnapshot` is
 * not configured -- the review server runs exactly as before.
 */
export function createStatusSnapshotWriter({ config, log, snapshot, now = Date.now, write = writeStatusSnapshot }) {
  const target = config.statusSnapshot;
  if (!target) return null;
  const intervalMs = target.intervalSeconds * 1000;
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

/**
 * The secret from the sender's environment, or null when it cannot run.
 * Never logged.
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
 * The sender's settings from its environment, or a reason it cannot run.
 * The URL is https without credentials or fragment; the snapshot path is
 * absolute.
 */
export function statusSenderSettings(env = process.env) {
  const secret = statusReportSecret(env);
  if (secret === null) return { error: `${STATUS_REPORT_SECRET_ENV} is missing or shorter than ${STATUS_REPORT_MIN_SECRET_LENGTH} characters` };
  let url;
  try {
    url = new URL(env.REVIEW_STATUS_URL ?? "");
  } catch {
    return { error: "REVIEW_STATUS_URL must be an absolute https URL" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return { error: "REVIEW_STATUS_URL must be https, without credentials or fragment" };
  }
  const snapshotPath = env.REVIEW_STATUS_SNAPSHOT ?? "";
  if (!snapshotPath.startsWith("/")) return { error: "REVIEW_STATUS_SNAPSHOT must be an absolute path" };
  const intervalSeconds = Number(env.REVIEW_STATUS_INTERVAL_SECONDS ?? STATUS_SNAPSHOT_DEFAULT_INTERVAL_SECONDS);
  if (!(Number.isInteger(intervalSeconds) && intervalSeconds >= 30 && intervalSeconds <= 3600)) {
    return { error: "REVIEW_STATUS_INTERVAL_SECONDS must be an integer from 30 to 3600" };
  }
  return { secret, url: url.href, snapshotPath, intervalSeconds };
}

/**
 * The sender's half: one attempt per call. A snapshot older than three
 * intervals is not sent -- the daemon has stopped writing it, and the app
 * should see silence, not a fresh copy of the last minute the daemon was
 * alive.
 */
export function createStatusSender({ settings, log, fetchImpl = fetch, now = Date.now, readSnapshot = defaultReadSnapshot }) {
  const maxAgeMs = settings.intervalSeconds * 3 * 1000;
  let lastOutcome = null;
  const outcome = (value, line) => {
    if (value !== lastOutcome) log(line);
    lastOutcome = value;
  };
  return {
    async sendOnce() {
      let read;
      try {
        read = readSnapshot(settings.snapshotPath);
      } catch (error) {
        outcome(`unreadable:${error.code ?? "error"}`, `status snapshot unreadable: ${error.code ?? "error"}`);
        return;
      }
      if (now() - read.modifiedAt > maxAgeMs) {
        outcome("stale", "status snapshot is stale; not sending");
        return;
      }
      const snapshot = read.size > STATUS_SNAPSHOT_MAX_BYTES ? null : normaliseStatusSnapshot(parseOrNull(read.text));
      if (snapshot === null) {
        outcome("invalid", "status snapshot is not a valid snapshot; not sending");
        return;
      }
      const sent = await sendStatusReport({ url: settings.url, secret: settings.secret, snapshot, fetchImpl });
      outcome(sent.outcome, sent.ok ? "status report ok" : `status report failed: ${sent.outcome}`);
    },
  };
}

function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One open file: its time and at most one byte past the cap, so a larger file is refused without loading it. */
function defaultReadSnapshot(path) {
  const fd = openSync(path, "r");
  try {
    const { mtimeMs } = fstatSync(fd);
    const buffer = Buffer.alloc(STATUS_SNAPSHOT_MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
      if (size === buffer.length) break;
    }
    return { modifiedAt: mtimeMs, size, text: buffer.subarray(0, Math.min(size, STATUS_SNAPSHOT_MAX_BYTES)).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}
