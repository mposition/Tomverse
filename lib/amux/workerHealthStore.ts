import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

import {
  AMUX_WORKER_CIRCUIT_HISTORY,
  type AmuxWorkerCircuit,
  amuxWorkerCircuit,
} from "./workerCircuitCore.ts";
import {
  AMUX_WORKER_HEALTH_SIGNAL_STALE_MS,
  type AmuxWorkerHealthSource,
  type AmuxWorkerHealthView,
  amuxWorkerHealthSignalRaised,
  amuxWorkerUsageState,
} from "./workerHealthCore.ts";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The workers' quarantine, usage reading and box signals (owner decision
 * 2026-11-15). Reads only; the quarantine is derived from each worker's own
 * latest ended attempts (lib/amux/workerCircuitCore.ts) and stores nothing.
 */

async function workerNames(db: Db, names: readonly string[] | null) {
  if (names) return [...new Set(names)];
  const rows = await db.amuxWorkerRuntime.findMany({ select: { workerName: true } });
  return rows.map((row) => row.workerName);
}

/** Each worker's latest usage reading: when, and whether it had work left. */
async function latestUsage(db: Db, names: readonly string[]) {
  if (names.length === 0) return new Map<string, { observedAt: Date; exhausted: boolean }>();
  const rows = await db.$queryRaw<Array<{ worker: string; observedAt: Date;
    exhausted: boolean; remainingBasisPoints: number }>>`
    SELECT DISTINCT ON (q."worker") q."worker", q."observedAt", q."exhausted",
      q."remainingBasisPoints"
    FROM "AmuxQuotaObservation" q WHERE q."worker" = ANY(${[...names]}::text[])
    ORDER BY q."worker", q."observedAt" DESC, q."id" DESC`;
  return new Map(rows.map((row) => [row.worker, { observedAt: row.observedAt,
    exhausted: row.exhausted || row.remainingBasisPoints <= 0 }]));
}

/** Every named worker's quarantine state; all workers with a runtime when `names` is null. */
export async function readAmuxWorkerCircuits(db: Db = prisma,
  names: readonly string[] | null = null, now = new Date()): Promise<Map<string, AmuxWorkerCircuit>> {
  const result = new Map<string, AmuxWorkerCircuit>();
  const workers = await workerNames(db, names);
  if (workers.length === 0) return result;
  const [attempts, usage] = await Promise.all([
    db.$queryRaw<Array<{ worker: string; reason: string | null; endedAt: Date }>>`
      SELECT w."name" AS "worker", a."reason", a."endedAt"
      FROM unnest(${workers}::text[]) AS w("name")
      CROSS JOIN LATERAL (
        SELECT x."reason", x."endedAt" FROM "AmuxExecutionAttempt" x
        WHERE x."worker" = w."name" AND x."endedAt" IS NOT NULL
        ORDER BY x."endedAt" DESC, x."id" DESC
        LIMIT ${AMUX_WORKER_CIRCUIT_HISTORY}) a
      ORDER BY w."name", a."endedAt" DESC`,
    latestUsage(db, workers),
  ]);
  const recentByWorker = new Map<string, Array<{ reason: string | null; endedAtMs: number }>>();
  for (const row of attempts) {
    const list = recentByWorker.get(row.worker) ?? [];
    list.push({ reason: row.reason, endedAtMs: row.endedAt.getTime() });
    recentByWorker.set(row.worker, list);
  }
  for (const worker of workers) {
    const reading = usage.get(worker);
    result.set(worker, amuxWorkerCircuit({ recent: recentByWorker.get(worker) ?? [],
      usageObservedAtMs: reading && !reading.exhausted ? reading.observedAt.getTime() : null,
      nowMs: now.getTime() }));
  }
  return result;
}

/** What the Admin worker list shows for each named worker. */
export async function readAmuxWorkerHealthViews(names: readonly string[],
  now = new Date(), db: Db = prisma): Promise<Record<string, AmuxWorkerHealthView>> {
  const workers = [...new Set(names)];
  if (workers.length === 0) return {};
  const [circuits, usage, signals] = await Promise.all([
    readAmuxWorkerCircuits(db, workers, now),
    latestUsage(db, workers),
    db.amuxWorkerHealthSignal.findMany({ where: { workerName: { in: workers },
      receivedAt: { gte: new Date(now.getTime() - AMUX_WORKER_HEALTH_SIGNAL_STALE_MS) } },
      orderBy: [{ workerName: "asc" }, { source: "asc" }] }),
  ]);
  const views: Record<string, AmuxWorkerHealthView> = {};
  for (const worker of workers) {
    const circuit = circuits.get(worker);
    const reading = usage.get(worker);
    views[worker] = {
      workerName: worker,
      circuit: !circuit ? { state: "closed", consecutive: 0, lastKind: null, lastAt: null, retryAt: null } : {
        state: circuit.state, consecutive: circuit.consecutive, lastKind: circuit.lastKind,
        lastAt: circuit.state === "closed" ? null : new Date(circuit.lastAtMs).toISOString(),
        retryAt: circuit.state === "open" ? new Date(circuit.retryAtMs).toISOString() : null },
      usage: { state: amuxWorkerUsageState(reading?.observedAt.getTime() ?? null, now.getTime()),
        observedAt: reading?.observedAt.toISOString() ?? null, exhausted: reading?.exhausted ?? false },
      signals: signals.filter((row) => row.workerName === worker).map((row) => {
        const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ?
          row.detail as Record<string, unknown> : {};
        return { source: row.source, signal: row.signal, observedAt: row.observedAt.toISOString(),
          firstSeenAt: row.firstSeenAt.toISOString(),
          expiresAt: typeof detail.expiresAt === "string" ? detail.expiresAt : null };
      }),
    };
  }
  return views;
}

export type AmuxWorkerHealthSignalInput = {
  source: AmuxWorkerHealthSource;
  signal: string;
  observedAt: Date;
  expiresAt: Date | null;
};

/**
 * Stores the newest signal per worker and source, keeping when the current
 * signal began, and raises a sign-in problem as an operational incident the
 * first time it arrives. A repeated signal is not raised again.
 */
export async function recordAmuxWorkerHealthSignals(workerName: string,
  signals: readonly AmuxWorkerHealthSignalInput[], now = new Date(), db: typeof prisma = prisma) {
  let recorded = 0;
  const raise: Array<{ source: string; signal: string; expiresAt: string | null }> = [];
  for (const input of signals) {
    const detail: Prisma.InputJsonObject = input.expiresAt ?
      { expiresAt: input.expiresAt.toISOString() } : {};
    const prior = await db.amuxWorkerHealthSignal.findUnique({
      where: { workerName_source: { workerName, source: input.source } },
      select: { signal: true, observedAt: true, reportedAt: true } });
    // An older reading never replaces a newer one.
    if (prior && prior.observedAt.getTime() > input.observedAt.getTime()) continue;
    const continued = prior?.signal === input.signal;
    const raised = amuxWorkerHealthSignalRaised(input.signal) &&
      (!continued || prior?.reportedAt === null);
    await db.amuxWorkerHealthSignal.upsert({
      where: { workerName_source: { workerName, source: input.source } },
      create: { workerName, source: input.source, signal: input.signal, detail,
        observedAt: input.observedAt, firstSeenAt: now, receivedAt: now,
        reportedAt: raised ? now : null },
      update: continued ? { detail, observedAt: input.observedAt, receivedAt: now,
        ...(raised ? { reportedAt: now } : {}) } :
        { signal: input.signal, detail, observedAt: input.observedAt, firstSeenAt: now,
          receivedAt: now, reportedAt: raised ? now : null } });
    recorded += 1;
    if (raised) raise.push({ source: input.source, signal: input.signal,
      expiresAt: input.expiresAt?.toISOString() ?? null });
  }
  for (const item of raise) {
    try {
      await reportOperationalIncident({
        code: `AMUX_WORKER_${item.signal.toUpperCase()}`,
        title: item.signal === "relogin_soon" ?
          "An AMUX worker's sign-in expires within a day" :
          "An AMUX worker cannot run until its sign-in is renewed",
        error: new Error(`${workerName}: ${item.source} reported ${item.signal}`),
        severity: item.signal === "relogin_soon" ? "warning" : "error",
        cooldownMs: 60 * 60_000,
        context: { component: "amux-worker-health", worker: workerName, source: item.source,
          signal: item.signal, expiresAt: item.expiresAt ?? "unknown",
          admin: "/admin/amux-settings?tab=workers" },
      });
    } catch (error) {
      console.warn(JSON.stringify({ subsystem: "amux", event: "amux_worker_health_report_failed",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    }
  }
  return { recorded };
}

/**
 * Raises the workers whose quarantine is open, once an hour per worker set.
 * Best effort: called from the claim tick with the circuits it already read.
 */
export async function reportOpenAmuxWorkerCircuits(circuits: ReadonlyMap<string, AmuxWorkerCircuit>) {
  const open = [...circuits].filter(([, circuit]) => circuit.state === "open")
    .map(([worker, circuit]) => `${worker}: ${circuit.consecutive}x ${circuit.lastKind ?? "unknown"}`)
    .sort();
  if (open.length === 0) return;
  try {
    await reportOperationalIncident({
      code: "AMUX_WORKER_QUARANTINED",
      title: "AMUX workers are out of assignment after repeated infrastructure failures",
      error: new Error(open.join("; ")),
      severity: "warning",
      cooldownMs: 60 * 60_000,
      context: { component: "amux-v22-claim", count: open.length, workers: open.join("; "),
        admin: "/admin/amux-settings?tab=workers" },
    });
  } catch (error) {
    console.warn(JSON.stringify({ subsystem: "amux", event: "amux_worker_quarantine_report_failed",
      message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
  }
}
