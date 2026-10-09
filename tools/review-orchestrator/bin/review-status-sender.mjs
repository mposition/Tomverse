#!/usr/bin/env node
/**
 * Sends the review server's status snapshot to the Tomverse app's Agent office.
 *
 * One self-contained file that imports only Node built-ins. It is installed
 * root-owned outside the review account's checkout and runs under its own
 * account (deploy/review-status-sender.service, systemd DynamicUser), because
 * it holds the bearer secret and every reviewer CLI runs as the review account
 * (lib/status-report.mjs says why that matters). Code the review account can
 * edit -- the checkout, anything it imports -- must never run here, or the
 * next restart would hand that code the secret.
 *
 * It reads no review configuration, no job and no reviewer output -- only the
 * snapshot file the daemon writes, rebuilt field by field before it is sent.
 *
 * Environment:
 *   REVIEW_ORCHESTRATOR_STATUS_SECRET   bearer secret, 32+ characters
 *   REVIEW_STATUS_URL                   https URL of the app's status route
 *   REVIEW_STATUS_SNAPSHOT              absolute path of the daemon's snapshot.json
 *
 * Exit 64 when the settings cannot run; otherwise it runs until stopped.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATUS_REPORT_SECRET_ENV = "REVIEW_ORCHESTRATOR_STATUS_SECRET";
const MIN_SECRET_LENGTH = 32;
/** One report a minute; the app calls five minutes of silence a lost server. */
export const SEND_INTERVAL_SECONDS = 60;
/** Three of the daemon's one-minute writes missed: the daemon has stopped. */
export const SNAPSHOT_MAX_AGE_SECONDS = 180;
const TIMEOUT_MS = 10_000;
/** The app's request cap; a larger file is not a snapshot the daemon wrote. */
export const SNAPSHOT_MAX_BYTES = 8192;

// The app's limits, the same as the daemon's (tests hold the two together).
const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROVIDERS = 16;
const MAX_SLOTS = 64;
const MAX_COUNT = 100_000;
const QUOTA_STATES = ["available", "exhausted", "unknown", "disabled"];
const QUOTA_UNITS = ["percent", "credits", "usd"];
const MAX_QUOTA_AMOUNT = 1_000_000_000;

const isCount = (value) => Number.isInteger(value) && value >= 0;

/** A provider's quota rebuilt, or undefined when the file holds none, or null when it holds a bad one. */
function normaliseQuota(quota) {
  if (quota === undefined) return undefined;
  if (quota === null || typeof quota !== "object" || !QUOTA_STATES.includes(quota.state)) return null;
  const { state, remaining, unit } = quota;
  if (remaining === null && unit === null) return { state, remaining: null, unit: null };
  if (state === "unknown" || state === "disabled") return null;
  if (!QUOTA_UNITS.includes(unit) || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) return null;
  if (remaining > (unit === "percent" ? 100 : MAX_QUOTA_AMOUNT)) return null;
  return { state, remaining, unit };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The snapshot rebuilt from a value read off disk, field by field, or null
 * when it is not one. Only this is sent: the file is written by the review
 * account, so anything beyond these fields is dropped.
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
    const quota = normaliseQuota(provider.quota);
    if (quota === null) return null;
    ids.add(id);
    rebuilt.push(quota === undefined ? { id, vendor, enabled, running, maxConcurrent } : { id, vendor, enabled, running, maxConcurrent, quota });
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

/**
 * One POST. Resolves to the HTTP status, or a short reason when no answer
 * came. Redirects are refused: the bearer secret goes to the configured URL
 * and nowhere else.
 */
export async function sendStatusReport({ url, secret, snapshot, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
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
 * The settings from the environment, or a reason the sender cannot run. The
 * URL is https without credentials or fragment; the snapshot path is
 * absolute. The secret's value never appears in a reason.
 */
export function statusSenderSettings(env = process.env) {
  const secret = env[STATUS_REPORT_SECRET_ENV];
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    return { error: `${STATUS_REPORT_SECRET_ENV} is missing or shorter than ${MIN_SECRET_LENGTH} characters` };
  }
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
  return { secret, url: url.href, snapshotPath };
}

/** One open file: its time and at most one byte past the cap, so a larger file is refused without loading it. */
export function readSnapshotFile(path) {
  const fd = openSync(path, "r");
  try {
    const { mtimeMs } = fstatSync(fd);
    const buffer = Buffer.alloc(SNAPSHOT_MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
      if (size === buffer.length) break;
    }
    return { modifiedAt: mtimeMs, size, text: buffer.subarray(0, Math.min(size, SNAPSHOT_MAX_BYTES)).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

const parseOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * One attempt per call. A snapshot older than SNAPSHOT_MAX_AGE_SECONDS is not
 * sent -- the daemon has stopped writing it, and the app should see silence,
 * not a fresh copy of the last minute the daemon was alive. Logs only when
 * the outcome changes.
 */
export function createStatusSender({ settings, log, fetchImpl = fetch, now = Date.now, readSnapshot = readSnapshotFile }) {
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
      if (now() - read.modifiedAt > SNAPSHOT_MAX_AGE_SECONDS * 1000) {
        outcome("stale", "status snapshot is stale; not sending");
        return;
      }
      const snapshot = read.size > SNAPSHOT_MAX_BYTES ? null : normaliseStatusSnapshot(parseOrNull(read.text));
      if (snapshot === null) {
        outcome("invalid", "status snapshot is not a valid snapshot; not sending");
        return;
      }
      const sent = await sendStatusReport({ url: settings.url, secret: settings.secret, snapshot, fetchImpl });
      outcome(sent.outcome, sent.ok ? "status report ok" : `status report failed: ${sent.outcome}`);
    },
  };
}

async function main() {
  const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const settings = statusSenderSettings(process.env);
  if (settings.error) {
    log(`status sender not started: ${settings.error}`);
    return 64;
  }
  // Nothing to finish on stop: a report in flight is just not delivered.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  const sender = createStatusSender({ settings, log });
  log("status sender started");
  for (;;) {
    await sender.sendOnce();
    await sleep(SEND_INTERVAL_SECONDS * 1000);
  }
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`status sender failed: ${error.message}\n`);
      process.exit(65);
    },
  );
}
