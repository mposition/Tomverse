import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";
import { codeTaskLimit, CODE_MAX_OUTPUT_TOKENS, type CodeManagedRequest } from "@/lib/codeManagedCore";
import { handleCodeManaged } from "@/lib/codeManagedService";
import { deleteR2Object, readOwnR2ObjectBytes, writeR2Object } from "@/lib/r2";
import {
  CODE_CLOUD_LIMITS, cleanCloudLogLine, codeCloudBilling, codeCloudBundleKey, codeCloudPatchKey, codeCloudTerminal,
  looksLikeGitBundle,
  type CodeCloudBilling, type CodeCloudCreateRequest, type CodeCloudJobStatus, type CodeCloudJobView, type CodeCloudRequest,
  type CodeCloudRunnerRequest,
} from "@/lib/codeCloudContract";
import { codeCloudRunnerSecret, desktopCloudExecutionEnabled } from "@/lib/desktopCloudExecutionSwitch";

/**
 * Desktop cloud execution, server side (docs/ops/desktop-cloud-execution.md).
 *
 * Money: a job never prices anything itself. Its model calls are the managed Code path's `reserve`, `complete`,
 * `heartbeat` and `release` (lib/codeManagedService.ts), called with the job owner's id, the person's approved credit
 * cap and the job's id as the reservation's task id. The reservation is made when a runner claims the job, so a queued
 * job holds no credits, and released when the job ends; the managed lease returns unused credits if the runner and this
 * server both go away. Compute time has no price: it is not charged.
 *
 * Code: the runner never receives the owner's session or any Tomverse credential beyond a per-claim job token, which
 * only reads that job's bundle, reports on it and asks for its model calls. Results come back as a patch for the person
 * to apply on their own computer.
 */

type JobRow = {
  id: string; userId: string; clientTaskId: string; status: CodeCloudJobStatus; instruction: string;
  catalogVersion: number; contentHash: string; executorModelId: string; reviewerModelId: string; approvedCredits: number;
  bundleBytes: number; bundleSha256: string; baseCommit: string; bundleObjectKey: string | null;
  reservationId: string | null; billing: unknown; runnerId: string | null; runnerTokenHash: string | null;
  runnerLeaseExpiresAt: Date | null; cancelRequestedAt: Date | null; logs: Array<{ seq: number; text: string }>; logSeq: number;
  failureCode: string | null; summary: string | null; patchObjectKey: string | null; patchBytes: number | null; patchSha256: string | null;
  createdAt: Date; updatedAt: Date; startedAt: Date | null; finishedAt: Date | null; expiresAt: Date;
};

export class CodeCloudError extends ApiSecurityError {
  constructor(status: number, code: string, readonly dispatchState: "not_dispatched" | "dispatched" = "not_dispatched", readonly billing?: CodeCloudBilling) {
    super(status, code, "The cloud Code request could not be completed.");
  }
}
const fail = (status: number, code: string): never => { throw new CodeCloudError(status, code); };

export type CodeCloudStorage = {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<Buffer>;
  remove(key: string): Promise<void>;
};
type Db = Pick<typeof prisma, "$queryRaw" | "$executeRaw" | "$transaction">;
type Tx = Pick<typeof prisma, "$queryRaw" | "$executeRaw">;
export type CodeCloudDeps = {
  db: Db;
  managed: (userId: string, request: CodeManagedRequest) => Promise<unknown>;
  storage: CodeCloudStorage;
  now: () => Date;
  env: Record<string, string | undefined>;
  operationalAccess: (userId: string) => Promise<void>;
};

const r2Storage: CodeCloudStorage = {
  put: (key, bytes, type) => writeR2Object(key, bytes, type),
  get: (key, maxBytes) => readOwnR2ObjectBytes(key, { maxBytes }),
  remove: (key) => deleteR2Object(key),
};

/** A managed refusal carries its code and whether a provider call may have gone out (lib/codeManagedService.ts). */
type ManagedFailure = { status: number; code: string; dispatchState: "not_dispatched" | "dispatched"; receipt?: unknown };
const managedFailure = (error: unknown): ManagedFailure | null => {
  const e = error as Partial<ManagedFailure> | null;
  return e && typeof e.code === "string" && typeof e.status === "number" && (e.dispatchState === "dispatched" || e.dispatchState === "not_dispatched")
    ? (e as ManagedFailure) : null;
};
const billingOf = (receipt: unknown): CodeCloudBilling | null => {
  const parsed = codeCloudBilling.safeParse((receipt as { billing?: unknown } | null)?.billing);
  return parsed.success ? parsed.data : null;
};
const digest = (value: string) => createHash("sha256").update(value).digest();
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));
const tokenHash = (token: string) => digest(token).toString("hex");
/**
 * A bundle or a patch is written to storage only inside a transaction that holds its job's row lock. An account
 * deletion (lib/codeCloudDeletion.ts) queues both object keys of every job and then removes the rows; removing this row
 * waits for the lock, so its tombstones commit after the write and the cleanup drain cannot run before the object
 * exists. A deletion that came first leaves no row, and nothing is written. Long enough for an 8 MiB write.
 */
const WRITE_TRANSACTION = { maxWait: 15_000, timeout: 120_000 };

export function codeCloudJobView(row: JobRow, logs: "all" | "none" | number = "all"): CodeCloudJobView {
  const billing = codeCloudBilling.safeParse(row.billing);
  return {
    jobId: row.id, taskId: row.clientTaskId, status: row.status, instruction: row.instruction,
    executorModelId: row.executorModelId, reviewerModelId: row.reviewerModelId, approvedCredits: row.approvedCredits,
    cancelRequested: row.cancelRequestedAt !== null, failureCode: row.failureCode, summary: row.summary,
    billing: billing.success ? billing.data : null,
    patch: row.patchObjectKey && row.patchSha256 && row.patchBytes !== null ? { bytes: row.patchBytes, sha256: row.patchSha256 } : null,
    logs: logs === "none" ? [] : logs === "all" ? row.logs : row.logs.filter((line) => line.seq > logs),
    logSeq: row.logSeq, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString(),
  };
}

async function readCapped(body: ReadableStream<Uint8Array> | null, exact: number) {
  if (!body) return fail(400, "CODE_CLOUD_BUNDLE_INVALID");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > exact) {
        await reader.cancel().catch(() => undefined);
        return fail(413, "CODE_CLOUD_BUNDLE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function createCodeCloudService(overrides: Partial<CodeCloudDeps> = {}) {
  const deps: CodeCloudDeps = {
    db: prisma, managed: handleCodeManaged, storage: r2Storage, now: () => new Date(), env: process.env,
    operationalAccess: assertUserOperationalAccess, ...overrides,
  };
  const { db } = deps;
  const enabled = () => desktopCloudExecutionEnabled(deps.env);
  const later = (ms: number) => new Date(deps.now().getTime() + ms);

  const owned = async (tx: Tx, userId: string, jobId: string, lock = false) =>
    (lock
      ? await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${jobId} AND "userId"=${userId} FOR UPDATE`
      : await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${jobId} AND "userId"=${userId}`)[0];
  const byId = async (tx: Tx, jobId: string) => (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${jobId}`)[0];

  /** Best effort; a failed delete leaves the key on the row and the sweep tries again. */
  async function dropBundle(jobId: string) {
    try {
      await deps.storage.remove(codeCloudBundleKey(jobId));
      await db.$executeRaw`UPDATE "CodeCloudJob" SET "bundleObjectKey"=NULL WHERE "id"=${jobId}`;
    } catch {
      console.warn(JSON.stringify({ event: "code_cloud_bundle_delete_deferred" }));
    }
  }

  /** Ends a reservation; an unknown outcome is left to the managed lease, which returns unused credits on its own. */
  async function release(row: Pick<JobRow, "userId" | "reservationId">, reason: "completed" | "failed" | "cancelled" | "interrupted") {
    if (!row.reservationId) return null;
    try {
      return billingOf(await deps.managed(row.userId, { action: "release", reservationId: row.reservationId, terminalReason: reason }));
    } catch (error) {
      return billingOf(managedFailure(error)?.receipt);
    }
  }

  async function create(userId: string, body: CodeCloudCreateRequest) {
    if (!enabled()) return fail(503, "CODE_CLOUD_DISABLED");
    await deps.operationalAccess(userId).catch(() => fail(403, "CODE_ACCOUNT_UNAVAILABLE"));
    const now = deps.now();
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`code-cloud:${userId}`}))`;
      const prior = (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "userId"=${userId} AND "clientTaskId"=${body.taskId}`)[0];
      if (prior) {
        const same = prior.instruction === body.instruction && prior.catalogVersion === body.catalogVersion && prior.contentHash === body.contentHash &&
          prior.executorModelId === body.executorModelId && prior.reviewerModelId === body.reviewerModelId &&
          prior.approvedCredits === body.approvedCredits && prior.bundleBytes === body.bundleBytes &&
          prior.bundleSha256 === body.bundleSha256 && prior.baseCommit === body.baseCommit;
        return same ? codeCloudJobView(prior, "none") : fail(409, "CODE_CLOUD_IDEMPOTENCY_CONFLICT");
      }
      // The same per-account task limit the managed path holds (docs/policy/code-concurrency.md); a job counts from creation.
      const active = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM "CodeCloudJob"
        WHERE "userId"=${userId} AND "status" IN ('uploading','queued','starting','running')`;
      if (Number(active[0].count) >= codeTaskLimit()) return fail(429, "CODE_CLOUD_CONCURRENCY_EXCEEDED");
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO "CodeCloudJob" ("id","userId","clientTaskId","status","instruction","catalogVersion","contentHash",
        "executorModelId","reviewerModelId","approvedCredits","bundleBytes","bundleSha256","baseCommit","createdAt","updatedAt","expiresAt")
        VALUES (${id},${userId},${body.taskId},'uploading',${body.instruction},${body.catalogVersion},${body.contentHash},
        ${body.executorModelId},${body.reviewerModelId},${body.approvedCredits},${body.bundleBytes},${body.bundleSha256},${body.baseCommit},
        ${now},${now},${later(CODE_CLOUD_LIMITS.uploadWindowMs)})`;
      return codeCloudJobView((await owned(tx, userId, id))!, "none");
    });
  }

  async function uploadBundle(userId: string, jobId: string, body: ReadableStream<Uint8Array> | null) {
    if (!enabled()) return fail(503, "CODE_CLOUD_DISABLED");
    const job = await owned(db, userId, jobId);
    if (!job) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    // A repeat after the bundle was accepted answers with the job; a job that ended before its bundle arrived refuses it.
    if (job.status !== "uploading") return ["failed", "cancelled"].includes(job.status) ? fail(409, "CODE_CLOUD_BUNDLE_NOT_EXPECTED") : codeCloudJobView(job, "none");
    const bytes = await readCapped(body, job.bundleBytes);
    if (bytes.byteLength !== job.bundleBytes || createHash("sha256").update(bytes).digest("hex") !== job.bundleSha256 || !looksLikeGitBundle(bytes))
      return fail(400, "CODE_CLOUD_BUNDLE_INVALID");
    const key = codeCloudBundleKey(job.id);
    await db.$transaction(async (tx) => {
      // Written only while the job's row is locked (see WRITE_TRANSACTION); a job cancelled or queued by an identical
      // repeat in the meantime keeps what it has.
      const locked = (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${job.id} AND "userId"=${userId} FOR UPDATE`)[0];
      if (!locked) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
      if (locked.status !== "uploading") return;
      await deps.storage.put(key, bytes, "application/x-git-bundle");
      await tx.$executeRaw`UPDATE "CodeCloudJob" SET "status"='queued',"bundleObjectKey"=${key},"updatedAt"=${deps.now()},
        "expiresAt"=${later(CODE_CLOUD_LIMITS.queueWindowMs)} WHERE "id"=${job.id}`;
    }, WRITE_TRANSACTION);
    const now = await owned(db, userId, jobId);
    if (!now) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    return codeCloudJobView(now, "none");
  }

  async function cancel(userId: string, jobId: string) {
    const outcome = await db.$transaction(async (tx) => {
      const job = await owned(tx, userId, jobId, true);
      if (!job) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
      const now = deps.now();
      if (job.status === "uploading" || job.status === "queued") {
        await tx.$executeRaw`UPDATE "CodeCloudJob" SET "status"='cancelled',"cancelRequestedAt"=${now},"finishedAt"=${now},"updatedAt"=${now},
          "expiresAt"=${later(CODE_CLOUD_LIMITS.retentionMs)} WHERE "id"=${job.id}`;
        return { drop: job.bundleObjectKey !== null };
      }
      // A running job is stopped by its runner, which reads this on its next heartbeat; the managed lease is the backstop.
      if (!codeCloudTerminal(job.status) && !job.cancelRequestedAt)
        await tx.$executeRaw`UPDATE "CodeCloudJob" SET "cancelRequestedAt"=${now},"updatedAt"=${now} WHERE "id"=${job.id}`;
      return { drop: false };
    });
    if (outcome.drop) await dropBundle(jobId);
    return codeCloudJobView((await owned(db, userId, jobId))!, "none");
  }

  async function handle(userId: string, request: CodeCloudRequest) {
    if (request.action === "create") return create(userId, request);
    if (request.action === "cancel") return cancel(userId, request.jobId);
    if (request.action === "list") {
      const rows = await db.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "userId"=${userId} ORDER BY "createdAt" DESC LIMIT 20`;
      return { jobs: rows.map((row) => codeCloudJobView(row, "none")) };
    }
    const job = await owned(db, userId, request.jobId);
    if (!job) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    return codeCloudJobView(job, request.afterLog ?? "all");
  }

  async function readPatch(userId: string, jobId: string) {
    const job = await owned(db, userId, jobId);
    if (!job) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    if (job.status !== "completed" || !job.patchObjectKey || !job.patchSha256 || job.patchBytes === null) return fail(409, "CODE_CLOUD_PATCH_UNAVAILABLE");
    const bytes = await deps.storage.get(job.patchObjectKey, CODE_CLOUD_LIMITS.patchMaxBytes);
    if (bytes.byteLength !== job.patchBytes || createHash("sha256").update(bytes).digest("hex") !== job.patchSha256) return fail(503, "CODE_CLOUD_PATCH_UNAVAILABLE");
    return { bytes, sha256: job.patchSha256 };
  }

  // --- runner side -------------------------------------------------------------------------------------------------

  function assertRunner(secret: string | null) {
    const expected = codeCloudRunnerSecret(deps.env);
    if (!enabled() || !expected) return fail(503, "CODE_CLOUD_DISABLED");
    if (!secret || !sameSecret(secret, expected)) return fail(401, "CODE_CLOUD_RUNNER_FORBIDDEN");
  }

  async function runnerJob(jobId: string, token: string | null, tx: Tx = db, lock = false) {
    const job = lock ? (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${jobId} FOR UPDATE`)[0] : await byId(tx, jobId);
    // One answer for "no such job" and "not your claim", so a token cannot probe for job ids.
    if (!job || !token || !job.runnerTokenHash || !sameSecret(tokenHash(token), job.runnerTokenHash)) return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    return job;
  }
  const live = (job: JobRow) => job.status === "running" && job.startedAt !== null &&
    deps.now().getTime() - job.startedAt.getTime() <= CODE_CLOUD_LIMITS.maxRuntimeMs;

  async function failClaimed(jobId: string, code: string) {
    const now = deps.now();
    await db.$executeRaw`UPDATE "CodeCloudJob" SET "status"='failed',"failureCode"=${code},"runnerTokenHash"=NULL,"runnerLeaseExpiresAt"=NULL,
      "finishedAt"=${now},"updatedAt"=${now},"expiresAt"=${later(CODE_CLOUD_LIMITS.retentionMs)} WHERE "id"=${jobId} AND "status"='starting'`;
    await dropBundle(jobId);
  }

  async function claim(runnerId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = randomBytes(32).toString("base64url");
      const job = await db.$transaction(async (tx) => {
        const next = (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "status"='queued' AND "expiresAt">${deps.now()}
          ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];
        if (!next) return null;
        const now = deps.now();
        await tx.$executeRaw`UPDATE "CodeCloudJob" SET "status"='starting',"runnerId"=${runnerId},"runnerTokenHash"=${tokenHash(token)},
          "runnerLeaseExpiresAt"=${later(CODE_CLOUD_LIMITS.runnerLeaseMs)},"updatedAt"=${now},
          "expiresAt"=${later(CODE_CLOUD_LIMITS.maxRuntimeMs + CODE_CLOUD_LIMITS.runnerLeaseMs)} WHERE "id"=${next.id}`;
        return next;
      });
      if (!job) return { job: null };
      let receipt: unknown;
      try {
        // Idempotent on the job id with this same body (lib/codeManagedService.ts), and checked again for every call.
        receipt = await deps.managed(job.userId, { action: "reserve", taskId: job.id, catalogVersion: job.catalogVersion, contentHash: job.contentHash,
          executorModelId: job.executorModelId, reviewerModelId: job.reviewerModelId, approvedCredits: job.approvedCredits });
      } catch (error) {
        // A reservation this failure may have left behind has no heartbeat; its lease ends it and returns the credits.
        await failClaimed(job.id, managedFailure(error)?.code ?? "CODE_CLOUD_RESERVATION_UNAVAILABLE");
        continue;
      }
      const reservation = receipt as { reservationId?: string; state?: string; modelPair?: { executor?: { modelId?: string; name?: string; provider?: string;
        capabilities?: { maxOutputTokens?: number; maxContextTokens?: number } } } };
      const executor = reservation.modelPair?.executor;
      if (!reservation.reservationId || reservation.state !== "active" || executor?.modelId !== job.executorModelId) {
        await release({ userId: job.userId, reservationId: reservation.reservationId ?? null }, "failed");
        await failClaimed(job.id, "CODE_CLOUD_RESERVATION_UNAVAILABLE");
        continue;
      }
      const now = deps.now();
      const started = await db.$executeRaw`UPDATE "CodeCloudJob" SET "status"='running',"reservationId"=${reservation.reservationId},
        "billing"=${JSON.stringify(billingOf(receipt))}::jsonb,"startedAt"=${now},"updatedAt"=${now} WHERE "id"=${job.id} AND "status"='starting'`;
      if (started !== 1) {
        // The account or the job went away in between (deletion); hand the credits back.
        await release({ userId: job.userId, reservationId: reservation.reservationId }, "cancelled");
        continue;
      }
      const row = (await byId(db, job.id))!;
      return {
        job: {
          jobId: job.id, token, instruction: job.instruction, baseCommit: job.baseCommit, bundleBytes: job.bundleBytes, bundleSha256: job.bundleSha256,
          cancelRequested: row.cancelRequestedAt !== null,
          executor: {
            modelId: executor.modelId, name: String(executor.name ?? executor.modelId), provider: String(executor.provider ?? "unknown"),
            maxOutputTokens: Math.min(Number(executor.capabilities?.maxOutputTokens) || CODE_MAX_OUTPUT_TOKENS, CODE_MAX_OUTPUT_TOKENS),
            maxContextTokens: Number(executor.capabilities?.maxContextTokens) || 0,
          },
          limits: { maxRuntimeMs: CODE_CLOUD_LIMITS.maxRuntimeMs, heartbeatMs: CODE_CLOUD_LIMITS.runnerHeartbeatMs, leaseMs: CODE_CLOUD_LIMITS.runnerLeaseMs },
        },
      };
    }
    return { job: null };
  }

  async function runnerBundle(jobId: string, token: string | null) {
    const job = await runnerJob(jobId, token);
    if (!live(job) || !job.bundleObjectKey) return fail(409, "CODE_CLOUD_JOB_NOT_RUNNING");
    return deps.storage.get(job.bundleObjectKey, job.bundleBytes);
  }

  async function appendLogs(tx: Tx, job: JobRow, lines: readonly string[]) {
    let seq = job.logSeq;
    const added = lines.map((text) => ({ seq: ++seq, text: cleanCloudLogLine(text) })).filter((line) => line.text.length > 0);
    if (!added.length) return;
    const logs = [...job.logs, ...added].slice(-CODE_CLOUD_LIMITS.logKeepLines);
    await tx.$executeRaw`UPDATE "CodeCloudJob" SET "logs"=${JSON.stringify(logs)}::jsonb,"logSeq"=${added.at(-1)!.seq} WHERE "id"=${job.id}`;
  }

  async function heartbeat(jobId: string, token: string | null, lines: readonly string[]) {
    const first = await runnerJob(jobId, token);
    if (first.status !== "running") return { stop: true, reason: first.status };
    let reservationActive = true, billing: CodeCloudBilling | null = null;
    if (first.reservationId) {
      try {
        const receipt = await deps.managed(first.userId, { action: "heartbeat", reservationId: first.reservationId });
        billing = billingOf(receipt);
        reservationActive = (receipt as { state?: string }).state === "active";
      } catch (error) {
        // A passing database or lock failure is not the end of the job; a missing reservation is.
        if (managedFailure(error)?.code === "CODE_RESERVATION_NOT_FOUND") reservationActive = false;
      }
    }
    return db.$transaction(async (tx) => {
      const locked = await runnerJob(jobId, token, tx, true);
      if (locked.status !== "running") return { stop: true, reason: locked.status };
      await appendLogs(tx, locked, lines);
      const now = deps.now();
      await tx.$executeRaw`UPDATE "CodeCloudJob" SET "runnerLeaseExpiresAt"=${later(CODE_CLOUD_LIMITS.runnerLeaseMs)},"updatedAt"=${now} WHERE "id"=${locked.id}`;
      if (billing) await tx.$executeRaw`UPDATE "CodeCloudJob" SET "billing"=${JSON.stringify(billing)}::jsonb WHERE "id"=${locked.id}`;
      const overTime = !live(locked);
      return {
        stop: !reservationActive || overTime, reason: !reservationActive ? "reservation_ended" : overTime ? "time_limit" : null,
        cancel: locked.cancelRequestedAt !== null, billing,
      };
    });
  }

  async function model(jobId: string, token: string | null, request: Extract<CodeCloudRunnerRequest, { action: "model" }>) {
    const job = await runnerJob(jobId, token);
    if (!live(job) || job.cancelRequestedAt || !job.reservationId) return fail(409, "CODE_CLOUD_JOB_NOT_RUNNING");
    const save = (billing: CodeCloudBilling | null) => billing
      ? db.$executeRaw`UPDATE "CodeCloudJob" SET "billing"=${JSON.stringify(billing)}::jsonb WHERE "id"=${job.id}`.catch(() => 0) : 0;
    let result: { value?: unknown; usage?: unknown; callCredits?: number };
    try {
      // The model is the one pinned on the reservation; the runner cannot name another or another reservation.
      result = await deps.managed(job.userId, { action: "complete", reservationId: job.reservationId, callId: request.callId, role: "executor",
        modelId: job.executorModelId, prompt: request.prompt, schema: request.schema, maxOutputTokens: request.maxOutputTokens }) as typeof result;
    } catch (error) {
      const refusal = managedFailure(error);
      const billing = billingOf(refusal?.receipt);
      await save(billing);
      // Anything else may have reached the provider: the runner must treat it as unknown and never send it again.
      if (!refusal) throw new CodeCloudError(503, "CODE_CLOUD_MODEL_OUTCOME_UNKNOWN", "dispatched");
      throw new CodeCloudError(refusal.status, refusal.code, refusal.dispatchState, billing ?? undefined);
    }
    const billing = billingOf(result);
    await save(billing);
    return { value: result.value, usage: result.usage ?? null, callCredits: result.callCredits ?? 0, billing };
  }

  async function finish(jobId: string, token: string | null, request: Extract<CodeCloudRunnerRequest, { action: "finish" }>) {
    const job = await runnerJob(jobId, token);
    if (job.status !== "running") return fail(409, "CODE_CLOUD_JOB_NOT_RUNNING");
    let patch: { key: string; bytes: number; sha256: string; body: Buffer } | null = null;
    if (request.outcome === "completed" && request.patchBase64 !== undefined) {
      const bytes = Buffer.from(request.patchBase64, "base64");
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength > CODE_CLOUD_LIMITS.patchMaxBytes || bytes.toString("base64") !== request.patchBase64 || sha !== request.patchSha256)
        return fail(400, "CODE_CLOUD_PATCH_INVALID");
      if (bytes.byteLength > 0) patch = { key: codeCloudPatchKey(job.id), bytes: bytes.byteLength, sha256: sha, body: bytes };
    }
    // The end is recorded first and the reservation released only by the request that recorded it, so a runner-lost
    // sweep and a late finish never both release, and neither releases a job the other left running. The patch is
    // written under the same row lock (WRITE_TRANSACTION), and only for a job that is still running.
    const ended = await db.$transaction(async (tx) => {
      const locked = (await tx.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "id"=${job.id} FOR UPDATE`)[0];
      if (!locked) return "gone" as const;
      if (locked.status !== "running") return "other" as const;
      if (patch) await deps.storage.put(patch.key, patch.body, "text/x-diff");
      await appendLogs(tx, locked, request.logs ?? []);
      const now = deps.now();
      const failureCode = request.outcome === "failed" ? request.failureCode ?? "CODE_CLOUD_RUN_FAILED" : null;
      await tx.$executeRaw`UPDATE "CodeCloudJob" SET "status"=${request.outcome},"failureCode"=${failureCode},"summary"=${request.summary ?? null},
        "patchObjectKey"=${patch?.key ?? null},"patchBytes"=${patch?.bytes ?? null},"patchSha256"=${patch?.sha256 ?? null},
        "runnerTokenHash"=NULL,"runnerLeaseExpiresAt"=NULL,"finishedAt"=${now},"updatedAt"=${now},"expiresAt"=${later(CODE_CLOUD_LIMITS.retentionMs)}
        WHERE "id"=${job.id}`;
      return "ended" as const;
    }, WRITE_TRANSACTION);
    if (ended === "gone") return fail(404, "CODE_CLOUD_JOB_NOT_FOUND");
    if (ended === "other") return fail(409, "CODE_CLOUD_JOB_NOT_RUNNING");
    const billing = await release(job, request.outcome === "completed" ? "completed" : request.outcome === "cancelled" ? "cancelled" : "failed");
    if (billing) await db.$executeRaw`UPDATE "CodeCloudJob" SET "billing"=${JSON.stringify(billing)}::jsonb WHERE "id"=${job.id}`;
    await dropBundle(job.id);
    return { ok: true };
  }

  async function handleRunner(secret: string | null, jobToken: string | null, request: CodeCloudRunnerRequest) {
    assertRunner(secret);
    if (request.action === "claim") return claim(request.runnerId);
    if (request.action === "heartbeat") return heartbeat(request.jobId, jobToken, request.logs);
    if (request.action === "model") return model(request.jobId, jobToken, request);
    return finish(request.jobId, jobToken, request);
  }

  async function readRunnerBundle(secret: string | null, jobToken: string | null, jobId: string) {
    assertRunner(secret);
    return runnerBundle(jobId, jobToken);
  }

  /**
   * The fifteen-minute maintenance pass. Never calls a model. It ends jobs whose runner stopped reporting (and their
   * reservations, which also end on their own lease), fails uploads and queue waits that ran out, removes bundles of
   * finished jobs, and deletes finished jobs past retention together with their objects.
   */
  async function sweep(limit = 50) {
    const now = deps.now();
    let lost = 0, expired = 0, purged = 0, deferred = 0;
    const stale = await db.$queryRaw<JobRow[]>`SELECT * FROM "CodeCloudJob" WHERE "status" IN ('starting','running')
      AND "runnerLeaseExpiresAt"<${now} ORDER BY "runnerLeaseExpiresAt" LIMIT ${limit}`;
    for (const job of stale) {
      const status = job.cancelRequestedAt ? "cancelled" : "failed";
      // The end is recorded only if the claim is still expired now (a heartbeat in between keeps the job), and only
      // then is the reservation released; the cleared token refuses any later report or model call of that runner.
      // The reservation is the one on the row as it was ended, not on the earlier read: a claim may have saved it since.
      const [ended] = await db.$queryRaw<Array<Pick<JobRow, "userId" | "reservationId">>>`UPDATE "CodeCloudJob" SET "status"=${status},
        "failureCode"=${status === "failed" ? "CODE_CLOUD_RUNNER_LOST" : null},
        "runnerTokenHash"=NULL,"runnerLeaseExpiresAt"=NULL,"finishedAt"=${now},"updatedAt"=${now},"expiresAt"=${later(CODE_CLOUD_LIMITS.retentionMs)}
        WHERE "id"=${job.id} AND "status" IN ('starting','running') AND "runnerLeaseExpiresAt"<${now} RETURNING "userId","reservationId"`;
      if (!ended) continue;
      lost += 1;
      const billing = await release(ended, "interrupted");
      if (billing) await db.$executeRaw`UPDATE "CodeCloudJob" SET "billing"=${JSON.stringify(billing)}::jsonb WHERE "id"=${job.id}`;
      await dropBundle(job.id);
    }
    expired = await db.$executeRaw`UPDATE "CodeCloudJob" SET "status"='failed',
      "failureCode"=CASE WHEN "status"='uploading' THEN 'CODE_CLOUD_UPLOAD_EXPIRED' ELSE 'CODE_CLOUD_QUEUE_EXPIRED' END,
      "finishedAt"=${now},"updatedAt"=${now},"expiresAt"=${later(CODE_CLOUD_LIMITS.retentionMs)}
      WHERE "status" IN ('uploading','queued') AND "expiresAt"<=${now}`;
    const finished = await db.$queryRaw<Array<{ id: string; expiresAt: Date }>>`SELECT "id","expiresAt" FROM "CodeCloudJob"
      WHERE "status" IN ('completed','failed','cancelled') AND ("bundleObjectKey" IS NOT NULL OR "expiresAt"<=${now})
      ORDER BY "expiresAt" LIMIT ${limit}`;
    for (const job of finished) {
      try {
        // Keys derive from the id, so an upload that landed after its row turned terminal is removed too.
        await deps.storage.remove(codeCloudBundleKey(job.id));
        if (job.expiresAt <= now) {
          await deps.storage.remove(codeCloudPatchKey(job.id));
          purged += await db.$executeRaw`DELETE FROM "CodeCloudJob" WHERE "id"=${job.id} AND "expiresAt"<=${now}`;
        } else await db.$executeRaw`UPDATE "CodeCloudJob" SET "bundleObjectKey"=NULL WHERE "id"=${job.id}`;
      } catch {
        deferred++;
      }
    }
    return { lost, expired, purged, deferred };
  }

  return { handle, uploadBundle, readPatch, handleRunner, readRunnerBundle, sweep };
}

/** The maintenance ride-along. Never throws: it cannot turn a successful reconciliation into a failed one. */
export async function sweepCodeCloudJobsQuietly() {
  try {
    return await createCodeCloudService().sweep();
  } catch {
    console.warn(JSON.stringify({ event: "code_cloud_sweep_deferred" }));
    return { deferred: true };
  }
}
