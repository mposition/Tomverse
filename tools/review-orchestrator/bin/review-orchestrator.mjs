#!/usr/bin/env node
/**
 * Server entry point.
 *
 *   review-orchestrator rpc <base64url JSON>   what the Windows client sends over SSH
 *   review-orchestrator ssh-dispatch           forced command: reads SSH_ORIGINAL_COMMAND
 *   review-orchestrator daemon                 the scheduling loop (systemd)
 *   review-orchestrator status [jobId]         local inspection
 *   review-orchestrator quota record <id> <remaining> <percent|credits|usd>   local only
 *   review-orchestrator quota check [id]      local only: read account usage without a review
 *   review-orchestrator drain on|off|wait      local only: stop new assignments for an update
 *   review-orchestrator cancel <jobId>...      local only: close a job's queued slots
 *
 * Exit codes for submit and wait: 0 accept, 1 reject, 2 unknown, 3 pending.
 * report and the queue overview exit 0 on success. 64 usage, 65 error.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { computeLoad } from "../lib/assign.mjs";
import { probeProviderQuotas, readQuotaStatus, recordManualQuota, writeQuotaStatus } from "../lib/quota.mjs";
import { loadConfig } from "../lib/config.mjs";
import { Orchestrator, UsageError, isDraining, setDraining, submitJob } from "../lib/service.mjs";
import { Store, isJobId, summarise } from "../lib/store.mjs";
import { buildStatusSnapshot, createStatusSnapshotWriter } from "../lib/status-report.mjs";
import { release, tryAcquire } from "../lib/fsutil.mjs";
import { Transform } from "node:stream";

const EXIT = { accept: 0, reject: 1, unknown: 2, pending: 3, usage: 64, error: 65 };
const COMMANDS = new Set(["submit", "wait", "status", "report"]);

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function decodeRpc(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,20000}$/.test(token)) {
    throw new UsageError("rpc_invalid");
  }
  let request;
  try {
    request = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new UsageError("rpc_invalid");
  }
  if (!request || typeof request !== "object" || !COMMANDS.has(request.command)) {
    throw new UsageError("rpc_command_invalid");
  }
  return request;
}

/** `SSH_ORIGINAL_COMMAND` is "<anything> rpc <token>"; only the token is read. */
export function tokenFromSshCommand(original) {
  const parts = (original ?? "").trim().split(/\s+/);
  const at = parts.lastIndexOf("rpc");
  if (at === -1 || at !== parts.length - 2) throw new UsageError("rpc_missing");
  return parts[at + 1];
}

async function readStdinToFile(config) {
  const dir = join(config.stateDir, "incoming");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomBytes(8).toString("hex")}.bundle`);
  // Count while writing: a forced-command key must not be able to fill the disk.
  let size = 0;
  const cap = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > config.maxBundleBytes) callback(new UsageError("bundle_too_large"));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(process.stdin, cap, createWriteStream(path));
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return path;
}

function overview(store, config, quotas = null) {
  const jobs = store.listJobs();
  const load = computeLoad(jobs, Date.now());
  const queued = jobs.reduce((n, { slots }) => n + slots.filter((s) => s.status === "queued").length, 0);
  return {
    capabilities: ["reviewer-selection-v1"],
    draining: isDraining(config),
    runningReviews: Object.values(load).reduce((n, entry) => n + entry.running, 0),
    queuedReviews: queued,
    providers: config.providers.map((p) => ({
      id: p.id,
      vendor: p.vendor,
      enabled: p.enabled === true,
      running: load[p.id]?.running ?? 0,
      last24h: load[p.id]?.recent24h ?? 0,
      quota: quotas?.[p.id]?.state ?? "unknown",
      remaining: quotas?.[p.id]?.remaining ?? quotas?.[p.id]?.remainingPercent ?? null,
      quotaUnit: quotas?.[p.id]?.unit ?? (quotas?.[p.id]?.remainingPercent === undefined ? null : "percent"),
      // Credit left after the included pool (Cursor), shown only when the probe read it.
      ...(Number.isFinite(quotas?.[p.id]?.creditUsd) ? { creditUsd: quotas[p.id].creditUsd } : {}),
    })),
  };
}

async function handle(config, request) {
  const store = new Store(config.stateDir);
  if (request.command === "submit") {
    const bundle = await readStdinToFile(config);
    try {
      const result = await submitJob(config, request, bundle);
      print({ ...result, status: "pending", next: `wait ${result.jobId}` });
      return EXIT.pending;
    } finally {
      rmSync(bundle, { force: true });
    }
  }
  if (request.command === "status" && !request.jobId) {
    print(overview(store, config, readQuotaStatus(config)));
    return 0;
  }
  if (!isJobId(request.jobId)) throw new UsageError("job_id_invalid");
  const entry = store.readJob(request.jobId);
  if (!entry) throw new UsageError("job_not_found");
  if (request.command === "report") {
    const index = Number.isInteger(request.slot) ? request.slot : 0;
    const path = store.reviewPath(request.jobId, index);
    process.stdout.write(existsSync(path) ? readFileSync(path, "utf8") : "");
    return 0;
  }
  if (request.command === "wait") {
    const limit = Math.min(Number(request.timeoutSeconds) || config.waitMaxSeconds, config.waitMaxSeconds);
    const deadline = Date.now() + limit * 1000;
    let summary = summarise(store.readJob(request.jobId));
    while (summary.status === "pending" && Date.now() < deadline) {
      await sleep(config.pollMs);
      summary = summarise(store.readJob(request.jobId));
    }
    print(summary);
    return EXIT[summary.status];
  }
  const summary = summarise(entry);
  print(summary);
  return EXIT[summary.status];
}

/** Exclusive: a second daemon on the same state directory refuses to start. */
function acquireDaemonLock(config) {
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "daemon.lock");
  const token = tryAcquire(path);
  if (token === null) throw new Error("daemon_already_running");
  return () => release(path, token);
}

async function daemon(config) {
  const releaseLock = acquireDaemonLock(config);
  const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const orchestrator = new Orchestrator(config, { log });
  const recovered = orchestrator.recoverOrphans();
  if (recovered > 0) log(`closed ${recovered} orphaned review(s) as unknown`);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log("review-orchestrator daemon started");
  // Telemetry for the app's Agent office: a content-free snapshot file. The
  // daemon holds no credential for the app -- a separate sender under its own
  // account sends the file (lib/status-report.mjs), so nothing here waits on
  // the network.
  const snapshotWriter = createStatusSnapshotWriter({
    config,
    log,
    snapshot: () => {
      const jobs = orchestrator.store.listJobs();
      const now = Date.now();
      return buildStatusSnapshot({
        jobs,
        providers: config.providers,
        load: computeLoad(jobs, now),
        quotas: readQuotaStatus(config, now),
        draining: isDraining(config),
        now,
      });
    },
  });
  if (snapshotWriter) log("status snapshot on");
  let nextPrune = 0;
  while (!stopping) {
    try {
      const quotas = await probeProviderQuotas(config);
      orchestrator.tick(quotas);
      writeQuotaStatus(config, quotas);
    } catch (error) {
      log(`tick failed: ${error.message}`);
    }
    snapshotWriter?.maybeWrite();
    if (Date.now() >= nextPrune) {
      nextPrune = Date.now() + 60 * 60 * 1000;
      await orchestrator.prune().catch((error) => log(`prune failed: ${error.message}`));
    }
    await sleep(config.pollMs);
  }
  // Reviewers run in their own process groups, so they would outlive the
  // daemon. Kill them; the next start closes their slots as unknown.
  log(`stopping with ${orchestrator.inflight.size} review(s) in flight; they will be closed as unknown`);
  orchestrator.killAll();
  await Promise.race([orchestrator.idle(), sleep(10_000)]);
  releaseLock();
  process.exit(0);
}

/**
 * Local only -- not reachable over rpc, so no client key can pause the queue.
 *
 *   drain on     stop new assignments (running reviews continue)
 *   drain wait   block until no review is running; exit 0, or 3 on timeout
 *   drain off    resume assignments
 */
async function drain(config, [action, ...rest]) {
  const store = new Store(config.stateDir);
  if (action === "on" || action === "off") {
    setDraining(config, action === "on");
    print(overview(store, config, readQuotaStatus(config)));
    return 0;
  }
  if (action === "wait") {
    const at = rest.indexOf("--timeout");
    const limitSeconds = at === -1 ? 3600 : Number(rest[at + 1]);
    if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) throw new UsageError("timeout_invalid");
    if (!isDraining(config)) throw new UsageError("not_draining", "run `drain on` first, or new reviews keep starting");
    const deadline = Date.now() + limitSeconds * 1000;
    let view = overview(store, config, readQuotaStatus(config));
    while (view.runningReviews > 0 && Date.now() < deadline) {
      await sleep(config.pollMs);
      view = overview(store, config, readQuotaStatus(config));
    }
    print(view);
    return view.runningReviews === 0 ? 0 : EXIT.pending;
  }
  throw new UsageError("drain_action", "use drain on, drain off or drain wait [--timeout seconds]");
}

async function main(argv) {
  const [command, ...rest] = argv;
  const config = loadConfig();
  if (command === "daemon") return daemon(config);
  if (command === "rpc") return handle(config, decodeRpc(rest[0]));
  if (command === "ssh-dispatch") return handle(config, decodeRpc(tokenFromSshCommand(process.env.SSH_ORIGINAL_COMMAND)));
  if (command === "status") return handle(config, { command: "status", jobId: rest[0] });
  if (command === "quota" && rest[0] === "check" && rest.length <= 2) {
    const providers = rest[1] ? config.providers.filter((provider) => provider.id === rest[1]) : config.providers;
    if (providers.length === 0) throw new UsageError("quota_provider_invalid");
    // A local account check may inspect a disabled provider without enabling its assignments.
    print(await probeProviderQuotas({ ...config,
      providers: providers.map((provider) => ({ ...provider, enabled: true })) }));
    return 0;
  }
  if (command === "quota" && rest[0] === "record" && rest.length === 4) {
    const remaining = Number(rest[2]);
    if (rest[2].trim() === "" || !Number.isFinite(remaining)) throw new UsageError("remaining_quota_invalid");
    try {
      const row = recordManualQuota(config, rest[1], remaining, rest[3]);
      print({ provider: rest[1], ...row });
      return 0;
    } catch (error) {
      if (["manual_quota_provider_invalid", "remaining_quota_invalid"].includes(error.message)) {
        throw new UsageError(error.message);
      }
      throw error;
    }
  }
  if (command === "drain") return drain(config, rest);
  if (command === "cancel") {
    // Local only, like drain. Closes queued slots; a running review finishes.
    if (rest.length === 0) throw new UsageError("cancel_needs_job_id");
    const orchestrator = new Orchestrator(config);
    const result = rest.map((jobId) => {
      if (!isJobId(jobId)) throw new UsageError("job_id_invalid", jobId);
      return { jobId, closedSlots: orchestrator.cancel(jobId) };
    });
    print(result);
    return 0;
  }
  throw new UsageError("command_unknown", "use rpc, ssh-dispatch, daemon, status, quota check, quota record, drain or cancel");
}

// Compare real paths: a symlinked launcher must still run main, not exit 0 silently.
const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`${JSON.stringify({ error: error.code ?? "error", message: error.message })}\n`);
      process.exit(error instanceof UsageError || error.clientFault ? EXIT.usage : EXIT.error);
    },
  );
}
