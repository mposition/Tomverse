#!/usr/bin/env node
/**
 * Server entry point.
 *
 *   review-orchestrator rpc <base64url JSON>   what the Windows client sends over SSH
 *   review-orchestrator ssh-dispatch           forced command: reads SSH_ORIGINAL_COMMAND
 *   review-orchestrator daemon                 the scheduling loop (systemd)
 *   review-orchestrator status [jobId]         local inspection
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
import { loadConfig } from "../lib/config.mjs";
import { Orchestrator, UsageError, submitJob } from "../lib/service.mjs";
import { Store, isJobId, summarise } from "../lib/store.mjs";
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

function overview(store, config) {
  const jobs = store.listJobs();
  const load = computeLoad(jobs, Date.now());
  const queued = jobs.reduce((n, { slots }) => n + slots.filter((s) => s.status === "queued").length, 0);
  return {
    queuedReviews: queued,
    providers: config.providers.map((p) => ({
      id: p.id,
      vendor: p.vendor,
      enabled: p.enabled === true,
      running: load[p.id]?.running ?? 0,
      last24h: load[p.id]?.recent24h ?? 0,
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
    print(overview(store, config));
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
  let nextPrune = 0;
  while (!stopping) {
    try {
      orchestrator.tick();
    } catch (error) {
      log(`tick failed: ${error.message}`);
    }
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

async function main(argv) {
  const [command, ...rest] = argv;
  const config = loadConfig();
  if (command === "daemon") return daemon(config);
  if (command === "rpc") return handle(config, decodeRpc(rest[0]));
  if (command === "ssh-dispatch") return handle(config, decodeRpc(tokenFromSshCommand(process.env.SSH_ORIGINAL_COMMAND)));
  if (command === "status") return handle(config, { command: "status", jobId: rest[0] });
  throw new UsageError("command_unknown", "use rpc, ssh-dispatch, daemon or status");
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
