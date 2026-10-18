import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION,
  CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION,
  CHAT_UNIFIED_OPTIMIZER_CONTROLS,
  readChatUnifiedOptimizerCandidateBundle,
} from "@/lib/chatUnifiedOptimizerCandidate";
import {
  CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
  CHAT_UNIFIED_OPTIMIZER_POLICY_VERSION,
  CHAT_UNIFIED_OPTIMIZER_PURPOSE,
  CHAT_UNIFIED_OPTIMIZER_ROLES,
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerClaimSchema,
  chatUnifiedOptimizerQueuedCloseDigest,
  chatUnifiedOptimizerQueuedCloseSchema,
  chatUnifiedOptimizerQueuedJobEvidenceDigest,
  chatUnifiedOptimizerQueuedJobTerminalDigest,
  chatUnifiedOptimizerRegistrationDigest,
  chatUnifiedOptimizerRegistrationSchema,
  chatUnifiedOptimizerTerminalDigest,
  chatUnifiedOptimizerTerminalSchema,
  type ChatUnifiedOptimizerRole,
  type ChatUnifiedOptimizerQueuedCloseReason,
  type ChatUnifiedOptimizerTerminalOutcome,
} from "@/lib/chatUnifiedOptimizerLedgerCore";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { CHAT_UNIFIED_OPTIMIZER_STOP_KEY } from
  "@/lib/chatUnifiedOptimizerStopStore";

const SYSTEM_ACTOR = "chat-unified-optimizer" as const;
const RUN_ADMITTED_ACTION = "chat.unified_optimizer.run_admitted" as const;
const DISPATCH_INTENDED_ACTION =
  "chat.unified_optimizer.dispatch_intended" as const;
const RUN_TERMINAL_ACTION = "chat.unified_optimizer.run_terminal" as const;
const QUEUED_TERMINAL_ACTION =
  "chat.unified_optimizer.queued_before_dispatch_terminal" as const;
const QUEUED_CLOSE_INTENT_ACTION =
  "chat.unified_optimizer.queued_closure_intended" as const;
const DB_STATEMENT_TIMEOUT_MS = 4_000;
const DB_IDLE_TIMEOUT_MS = 4_000;
const DB_TRANSACTION_TIMEOUT_MS = 5_000;
const transactionOptions = { maxWait: 2_000, timeout: 7_000 } as const;

type Db = Pick<typeof prisma, "$transaction" | "$queryRaw">;

export class ChatUnifiedOptimizerLedgerError extends Error {
  constructor(readonly code:
    | "input_invalid"
    | "deadline_elapsed"
    | "registration_conflict"
    | "active_cycle_exists"
    | "job_unavailable"
    | "claim_conflict"
    | "claim_busy"
    | "stop_latched"
    | "terminal_conflict"
    | "claim_authority_invalid"
    | "late_terminal"
    | "close_conflict"
    | "close_intent_required"
    | "close_unavailable"
    | "deadline_not_elapsed"
    | "claimed_readback_required"
    | "database_boundary_unavailable") {
    super(code);
    this.name = "ChatUnifiedOptimizerLedgerError";
  }
}

const refuse = (code: ChatUnifiedOptimizerLedgerError["code"]): never => {
  throw new ChatUnifiedOptimizerLedgerError(code);
};

type RegistrationRow = Readonly<{
  cycleId: string;
  runId: string;
  candidateId: string;
  registrationDigest: string;
  state: string;
  deadlineAt: Date;
}>;

type ClaimRow = Readonly<{
  jobId: string;
  claimRequestDigest: string;
  claimToken: string;
  state: string;
  role: string;
  deadlineAt: Date;
  claimedAt: Date;
}>;

type TerminalRow = Readonly<{
  jobId: string;
  terminalRequestDigest: string;
  terminalOutcome: ChatUnifiedOptimizerTerminalOutcome;
  state: string;
  terminalAt: Date;
  evidenceRef: string | null;
  evidencePayloadDigest: string | null;
}>;

type JobLockRow = Readonly<{
  id: string;
  runId: string;
  cycleId: string;
  candidateId: string;
  role: ChatUnifiedOptimizerRole;
  state: string;
  deadlineAt: Date;
  runState: string;
  cycleState: string;
  claimToken: string | null;
}>;

type QueuedClosureJobRow = JobLockRow & Readonly<{
  claimRequestId: string | null;
  terminalRequestId: string | null;
  terminalRequestDigest: string | null;
  terminalOutcome: string | null;
  terminalAt: Date | null;
  terminalAuditAction: string | null;
  closeRequestDigest: string | null;
  closeReason: string | null;
  evidenceRef: string | null;
  evidencePayloadDigest: string | null;
}>;

const deterministicUuid = (scope: string, value: string): string => {
  const hex = createHash("sha256").update(`${scope}\0${value}`, "utf8")
    .digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
};

const lockLedger = async (tx: Prisma.TransactionClient): Promise<void> => {
  await takeAuditChainLock(tx);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('chat-unified-optimizer-ledger-v1'))
  `;
};

/** The owner stop writer takes the same audit-chain lock, so an admission
 * cannot cross a committed stop between this read and its claim/write. */
const requireStopUnlatched = async (tx: Prisma.TransactionClient):
Promise<void> => {
  const row = await tx.appSetting.findUnique({
    where: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY },
    select: { value: true },
  });
  if (row?.value === "true") return refuse("stop_latched");
  if (row) return refuse("database_boundary_unavailable");
};

/**
 * Arms database-local ceilings before either global lock. PostgreSQL 17's
 * transaction timeout begins here; 16 retains the shorter statement and idle
 * ceilings but cannot provide a transaction occupancy bound. A pre-armed
 * transaction timer is refused because changing its displayed value does not
 * reschedule the timer that already started at BEGIN.
 */
const armLedgerTransaction = async (
  tx: Prisma.TransactionClient,
): Promise<void> => {
  const settings = await tx.$queryRaw<Array<{
    serverVersionNum: number;
    transactionTimeout: string | null;
  }>>`
    SELECT current_setting('server_version_num')::int AS "serverVersionNum",
      current_setting('transaction_timeout', true) AS "transactionTimeout"
  `;
  const setting = settings[0];
  if (!setting) return refuse("database_boundary_unavailable");
  if (setting.serverVersionNum >= 170000) {
    if (setting.transactionTimeout !== "0" &&
        setting.transactionTimeout !== "0ms") {
      return refuse("database_boundary_unavailable");
    }
    await tx.$executeRaw`
      SELECT set_config('transaction_timeout',
        ${String(DB_TRANSACTION_TIMEOUT_MS)}, true)
    `;
  }
  await tx.$executeRaw`
    SELECT set_config('statement_timeout',
      ${String(DB_STATEMENT_TIMEOUT_MS)}, true)
  `;
  await tx.$executeRaw`
    SELECT set_config('idle_in_transaction_session_timeout',
      ${String(DB_IDLE_TIMEOUT_MS)}, true)
  `;
};

const registrationRead = async (
  db: Pick<typeof prisma, "$queryRaw">,
  requestId: string,
): Promise<RegistrationRow | null> => {
  const rows = await db.$queryRaw<RegistrationRow[]>`
    SELECT c."id"::text AS "cycleId", r."id"::text AS "runId",
      k."id"::text AS "candidateId", c."registrationDigest",
      c."state", c."deadlineAt"
    FROM "ChatUnifiedOptimizerCycle" c
    JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
    JOIN "ChatUnifiedOptimizerRun" r ON r."cycleId" = c."id" AND r."ordinal" = 1
    WHERE c."registrationRequestId" = ${requestId}::uuid
  `;
  return rows[0] ?? null;
};

export async function readChatUnifiedOptimizerRegistration(
  input: Readonly<{ requestId: string; registrationDigest: string }>,
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<Readonly<{ outcome: "committed"; cycleId: string; runId: string;
  candidateId: string; state: string; deadlineAt: Date }> |
  Readonly<{ outcome: "not_found" | "conflict" }>> {
  if (!chatUnifiedOptimizerRegistrationSchema.shape.requestId.safeParse(
    input.requestId,
  ).success || !/^[0-9a-f]{64}$/.test(input.registrationDigest)) {
    return { outcome: "not_found" };
  }
  const row = await registrationRead(db, input.requestId);
  if (!row) return { outcome: "not_found" };
  if (row.registrationDigest !== input.registrationDigest) {
    return { outcome: "conflict" };
  }
  return { outcome: "committed", cycleId: row.cycleId, runId: row.runId,
    candidateId: row.candidateId, state: row.state,
    deadlineAt: row.deadlineAt };
}

/**
 * Registers one synthetic-only validation cycle and its six closed role jobs.
 * The validated public proposal is stored separately from the content-free
 * ledger. Neither its bytes nor its registration grant runtime authority.
 */
export async function registerChatUnifiedOptimizerCycle(input: Readonly<{
  requestId: string;
  candidateBundleJson: string;
  expectedBundleDigest: string;
  sourceCommitSha: string;
  sourceRepositoryId?: number;
  sourceBlobSha?: string;
  sourceSha256?: string;
  deadlineAt: Date;
}>, db: Db = prisma): Promise<Readonly<{
  outcome: "created" | "replayed";
  cycleId: string;
  runId: string;
  candidateId: string;
  jobIds: Readonly<Record<ChatUnifiedOptimizerRole, string>>;
  registrationDigest: string;
  deadlineAt: Date;
}>> {
  const parsed = chatUnifiedOptimizerRegistrationSchema.safeParse({
    requestId: input.requestId,
    expectedBundleDigest: input.expectedBundleDigest,
    sourceCommitSha: input.sourceCommitSha,
    sourceRepositoryId: input.sourceRepositoryId,
    sourceBlobSha: input.sourceBlobSha,
    sourceSha256: input.sourceSha256,
    deadlineAt: input.deadlineAt,
  });
  if (!parsed.success) return refuse("input_invalid");
  let bundle: ReturnType<typeof readChatUnifiedOptimizerCandidateBundle>;
  try {
    bundle = readChatUnifiedOptimizerCandidateBundle(
      input.candidateBundleJson,
      parsed.data.expectedBundleDigest,
    );
  } catch {
    return refuse("input_invalid");
  }
  const bundleJson = canonicalBenchmarkJson(bundle);
  const bodySha256 = createHash("sha256").update(bundleJson, "utf8")
    .digest("hex");
  const registrationDigest = chatUnifiedOptimizerRegistrationDigest({
    requestId: parsed.data.requestId,
    candidateDigest: bundle.candidateDigest,
    bundleDigest: bundle.bundleDigest,
    controlsDigest: bundle.candidate.controlsDigest,
    schemaVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.schemaVersion,
    promptVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.promptVersion,
    stageCandidateDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.stageCandidateDigest,
    adapterConfigDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.adapterConfigDigest,
    pricePinDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.pricePinDigest,
    sourceCommitSha: parsed.data.sourceCommitSha,
    sourceRepositoryId: parsed.data.sourceRepositoryId,
    sourceBlobSha: parsed.data.sourceBlobSha,
    sourceSha256: parsed.data.sourceSha256,
    deadlineAt: parsed.data.deadlineAt,
  });

  return db.$transaction(async tx => {
    await armLedgerTransaction(tx);
    await lockLedger(tx);
    const existing = await registrationRead(tx, parsed.data.requestId);
    if (existing) {
      if (existing.registrationDigest !== registrationDigest) {
        return refuse("registration_conflict");
      }
      const payload = await tx.chatUnifiedOptimizerCandidatePayload.findUnique({
        where: { candidateId: existing.candidateId },
        select: { bundleDigest: true, bodySha256: true, bundleJson: true },
      });
      if (!payload || payload.bundleDigest !== bundle.bundleDigest ||
          payload.bodySha256 !== bodySha256 ||
          payload.bundleJson !== bundleJson) {
        return refuse("registration_conflict");
      }
      const jobs = await tx.$queryRaw<Array<{ id: string;
        role: ChatUnifiedOptimizerRole }>>`
        SELECT "id"::text AS "id", "role"
        FROM "ChatUnifiedOptimizerRoleJob"
        WHERE "runId" = ${existing.runId}::uuid
        ORDER BY "role"
      `;
      return { outcome: "replayed", cycleId: existing.cycleId,
        runId: existing.runId, candidateId: existing.candidateId,
        jobIds: Object.freeze(Object.fromEntries(jobs.map(job =>
          [job.role, job.id])) as Record<ChatUnifiedOptimizerRole, string>),
        registrationDigest, deadlineAt: existing.deadlineAt } as const;
    }

    await requireStopUnlatched(tx);

    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock || parsed.data.deadlineAt.getTime() <= clock.now.getTime()) {
      return refuse("deadline_elapsed");
    }
    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text AS "id" FROM "ChatUnifiedOptimizerCycle"
      WHERE "state" IN ('active', 'outcome_unknown') LIMIT 1
    `;
    if (active.length !== 0) return refuse("active_cycle_exists");

    const cycleId = randomUUID();
    const candidateId = randomUUID();
    const runId = randomUUID();
    const roleJobs = CHAT_UNIFIED_OPTIMIZER_ROLES.map(role => ({
      role,
      id: randomUUID(),
    }));
    const admissionAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: SYSTEM_ACTOR,
      action: RUN_ADMITTED_ACTION,
      targetType: "ChatUnifiedOptimizerRun",
      targetId: runId,
      summary: "Admitted one provider-free unified optimizer validation run.",
      metadata: {
        ledgerVersion: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
        policyVersion: CHAT_UNIFIED_OPTIMIZER_POLICY_VERSION,
        purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
        registrationDigest,
        candidateDigest: bundle.candidateDigest,
        bundleDigest: bundle.bundleDigest,
        roleCount: CHAT_UNIFIED_OPTIMIZER_ROLES.length,
        externalDispatchAuthorized: false,
        paidAuthorized: false,
        promotionAuthorized: false,
      },
    });
    await tx.$executeRaw`
      INSERT INTO "ChatUnifiedOptimizerCycle" (
        "id", "ledgerVersion", "policyVersion", "purpose",
        "registrationRequestId", "registrationDigest", "state",
        "externalDispatchAuthorized", "paidAuthorized",
        "promotionAuthorized", "deadlineAt", "createdAt")
      VALUES (${cycleId}::uuid, ${CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION},
        ${CHAT_UNIFIED_OPTIMIZER_POLICY_VERSION},
        ${CHAT_UNIFIED_OPTIMIZER_PURPOSE}, ${parsed.data.requestId}::uuid,
        ${registrationDigest}, 'active', FALSE, FALSE, FALSE,
        ${parsed.data.deadlineAt}, clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "ChatUnifiedOptimizerCandidate" (
        "id", "cycleId", "candidateVersion", "bundleVersion",
        "candidateDigest", "bundleDigest", "controlsDigest",
        "schemaVersion", "promptVersion", "stageCandidateDigest",
        "adapterConfigDigest", "pricePinDigest", "sourceCommitSha",
        "sourceRepositoryId", "sourceBlobSha", "sourceSha256",
        "runtimeAuthorized", "createdAt")
      VALUES (${candidateId}::uuid, ${cycleId}::uuid,
        ${CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION},
        ${CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION}, ${bundle.candidateDigest},
        ${bundle.bundleDigest}, ${bundle.candidate.controlsDigest},
        ${CHAT_UNIFIED_OPTIMIZER_CONTROLS.schemaVersion},
        ${CHAT_UNIFIED_OPTIMIZER_CONTROLS.promptVersion},
        ${CHAT_UNIFIED_OPTIMIZER_CONTROLS.stageCandidateDigest},
        ${CHAT_UNIFIED_OPTIMIZER_CONTROLS.adapterConfigDigest},
        ${CHAT_UNIFIED_OPTIMIZER_CONTROLS.pricePinDigest},
        ${parsed.data.sourceCommitSha},
        ${parsed.data.sourceRepositoryId === undefined ? null :
          BigInt(parsed.data.sourceRepositoryId)},
        ${parsed.data.sourceBlobSha ?? null},
        ${parsed.data.sourceSha256 ?? null}, FALSE, clock_timestamp())
    `;
    await tx.chatUnifiedOptimizerCandidatePayload.create({ data: {
      candidateId, bundleDigest: bundle.bundleDigest, bodySha256,
      bundleJson,
    } });
    await tx.$executeRaw`
      INSERT INTO "ChatUnifiedOptimizerRun" (
        "id", "cycleId", "ordinal", "purpose", "state",
        "externalDispatchAuthorized", "paidAuthorized", "deadlineAt",
        "admissionAuditLogId", "createdAt")
      VALUES (${runId}::uuid, ${cycleId}::uuid, 1,
        ${CHAT_UNIFIED_OPTIMIZER_PURPOSE}, 'active', FALSE, FALSE,
        ${parsed.data.deadlineAt}, ${admissionAuditLogId}, clock_timestamp())
    `;
    for (const job of roleJobs) {
      await tx.$executeRaw`
        INSERT INTO "ChatUnifiedOptimizerRoleJob" (
          "id", "runId", "role", "purpose", "state",
          "externalDispatchAuthorized", "paidAuthorized", "deadlineAt",
          "createdAt")
        VALUES (${job.id}::uuid, ${runId}::uuid, ${job.role},
          ${CHAT_UNIFIED_OPTIMIZER_PURPOSE}, 'queued', FALSE, FALSE,
          ${parsed.data.deadlineAt}, clock_timestamp())
      `;
    }
    return { outcome: "created", cycleId, runId, candidateId,
      jobIds: Object.freeze(Object.fromEntries(roleJobs.map(job =>
        [job.role, job.id])) as Record<ChatUnifiedOptimizerRole, string>),
      registrationDigest, deadlineAt: parsed.data.deadlineAt } as const;
  }, transactionOptions);
}

const claimRead = async (
  db: Pick<typeof prisma, "$queryRaw">,
  requestId: string,
): Promise<ClaimRow | null> => {
  const rows = await db.$queryRaw<ClaimRow[]>`
    SELECT "id"::text AS "jobId", "claimRequestDigest", "claimToken"::text,
      "state", "role", "deadlineAt", "claimedAt"
    FROM "ChatUnifiedOptimizerRoleJob"
    WHERE "claimRequestId" = ${requestId}::uuid
  `;
  return rows[0] ?? null;
};

export async function readChatUnifiedOptimizerClaim(
  input: Readonly<{ requestId: string; claimDigest: string }>,
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<Readonly<{ outcome: "committed"; jobId: string; role: string;
  state: string; claimToken: string | null; deadlineAt: Date;
  claimedAt: Date }> | Readonly<{ outcome: "not_found" | "conflict" }>> {
  if (!chatUnifiedOptimizerClaimSchema.shape.requestId.safeParse(
    input.requestId,
  ).success || !/^[0-9a-f]{64}$/.test(input.claimDigest)) {
    return { outcome: "not_found" };
  }
  const row = await claimRead(db, input.requestId);
  if (!row) return { outcome: "not_found" };
  if (row.claimRequestDigest !== input.claimDigest) {
    return { outcome: "conflict" };
  }
  return { outcome: "committed", jobId: row.jobId, role: row.role,
    state: row.state, claimToken: row.state === "claimed" ? row.claimToken : null,
    deadlineAt: row.deadlineAt, claimedAt: row.claimedAt };
}

export async function claimChatUnifiedOptimizerRoleJob(input: Readonly<{
  requestId: string;
  jobId: string;
}>, db: Db = prisma): Promise<Readonly<{
  outcome: "claimed" | "replayed";
  jobId: string;
  role: ChatUnifiedOptimizerRole;
  claimToken: string;
  claimDigest: string;
  deadlineAt: Date;
  claimedAt: Date;
}>> {
  const parsed = chatUnifiedOptimizerClaimSchema.safeParse(input);
  if (!parsed.success) return refuse("input_invalid");
  const claimDigest = chatUnifiedOptimizerClaimDigest(parsed.data);
  return db.$transaction(async tx => {
    await armLedgerTransaction(tx);
    await lockLedger(tx);
    const existing = await claimRead(tx, parsed.data.requestId);
    if (existing) {
      if (existing.claimRequestDigest !== claimDigest ||
          existing.jobId !== parsed.data.jobId) return refuse("claim_conflict");
      if (existing.state !== "claimed") return refuse("job_unavailable");
      return { outcome: "replayed", jobId: existing.jobId,
        role: existing.role as ChatUnifiedOptimizerRole,
        claimToken: existing.claimToken, claimDigest,
        deadlineAt: existing.deadlineAt, claimedAt: existing.claimedAt } as const;
    }
    await requireStopUnlatched(tx);
    const jobs = await tx.$queryRaw<JobLockRow[]>`
      SELECT j."id"::text AS "id", j."runId"::text AS "runId",
        r."cycleId"::text AS "cycleId", k."id"::text AS "candidateId",
        j."role", j."state", j."deadlineAt", r."state" AS "runState",
        c."state" AS "cycleState", j."claimToken"::text AS "claimToken"
      FROM "ChatUnifiedOptimizerRoleJob" j
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = j."runId"
      JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
      JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
      WHERE j."id" = ${parsed.data.jobId}::uuid
      FOR UPDATE OF j, r, c
    `;
    const job = jobs[0];
    if (!job || job.state !== "queued" || job.runState !== "active" ||
        job.cycleState !== "active") return refuse("job_unavailable");
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock || clock.now.getTime() >= job.deadlineAt.getTime()) {
      return refuse("deadline_elapsed");
    }
    const busy = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text AS "id" FROM "ChatUnifiedOptimizerRoleJob"
      WHERE "state" = 'claimed' LIMIT 1
    `;
    if (busy.length !== 0) return refuse("claim_busy");
    const claimToken = randomUUID();
    const claimAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: SYSTEM_ACTOR,
      action: DISPATCH_INTENDED_ACTION,
      targetType: "ChatUnifiedOptimizerRoleJob",
      targetId: job.id,
      summary: "Claimed one provider-free unified optimizer role job.",
      metadata: {
        ledgerVersion: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
        purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
        role: job.role,
        claimRequestDigest: claimDigest,
        externalDispatchAuthorized: false,
        paidAuthorized: false,
      },
    });
    const updated = await tx.$queryRaw<Array<{ claimedAt: Date }>>`
      UPDATE "ChatUnifiedOptimizerRoleJob"
      SET "state" = 'claimed',
        "claimRequestId" = ${parsed.data.requestId}::uuid,
        "claimRequestDigest" = ${claimDigest},
        "claimToken" = ${claimToken}::uuid,
        "claimAuditLogId" = ${claimAuditLogId},
        "claimedAt" = clock_timestamp()
      WHERE "id" = ${job.id}::uuid AND "state" = 'queued'
      RETURNING "claimedAt"
    `;
    if (!updated[0]) return refuse("job_unavailable");
    return { outcome: "claimed", jobId: job.id, role: job.role,
      claimToken, claimDigest, deadlineAt: job.deadlineAt,
      claimedAt: updated[0].claimedAt } as const;
  }, transactionOptions);
}

const queuedClosureRows = async (
  tx: Prisma.TransactionClient,
  cycleId: string,
): Promise<QueuedClosureJobRow[]> => tx.$queryRaw<QueuedClosureJobRow[]>`
  SELECT j."id"::text AS "id", j."runId"::text AS "runId",
    r."cycleId"::text AS "cycleId", k."id"::text AS "candidateId",
    j."role", j."state", j."deadlineAt", r."state" AS "runState",
    c."state" AS "cycleState", j."claimToken"::text AS "claimToken",
    j."claimRequestId"::text AS "claimRequestId",
    j."terminalRequestId"::text AS "terminalRequestId",
    j."terminalRequestDigest", j."terminalOutcome", j."terminalAt",
    a."action" AS "terminalAuditAction",
    a."metadata"->>'closeRequestDigest' AS "closeRequestDigest",
    a."metadata"->>'closeReason' AS "closeReason",
    e."evidenceRef", e."payloadDigest" AS "evidencePayloadDigest"
  FROM "ChatUnifiedOptimizerCycle" c
  JOIN "ChatUnifiedOptimizerRun" r
    ON r."cycleId" = c."id" AND r."ordinal" = 1
  JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
  JOIN "ChatUnifiedOptimizerRoleJob" j ON j."runId" = r."id"
  LEFT JOIN "AdminAuditLog" a ON a."id" = j."terminalAuditLogId"
  LEFT JOIN "ChatUnifiedOptimizerEvidence" e ON e."jobId" = j."id"
  WHERE c."id" = ${cycleId}::uuid
  ORDER BY j."role"
  FOR UPDATE OF c, r, j
`;

const queuedClosureFacts = (
  job: QueuedClosureJobRow,
  closeRequestDigest: string,
  reason: ChatUnifiedOptimizerQueuedCloseReason,
) => {
  const evidenceRef = `optimizer:queued:${reason}:${job.id}`;
  const evidencePayloadDigest = chatUnifiedOptimizerQueuedJobEvidenceDigest({
    closeRequestDigest,
    cycleId: job.cycleId,
    runId: job.runId,
    candidateId: job.candidateId,
    jobId: job.id,
    role: job.role,
    reason,
  });
  const terminalRequestDigest = chatUnifiedOptimizerQueuedJobTerminalDigest({
    closeRequestDigest,
    cycleId: job.cycleId,
    runId: job.runId,
    jobId: job.id,
    role: job.role,
    reason,
    evidenceRef,
    evidencePayloadDigest,
  });
  return Object.freeze({
    evidenceRef,
    evidencePayloadDigest,
    terminalRequestDigest,
    terminalRequestId: deterministicUuid(
      "chat-unified-optimizer-queued-terminal-v1",
      `${closeRequestDigest}:${job.id}`,
    ),
  });
};

/** A committed intent is the durable boundary for the sole closure attempt.
 * Its absence authorizes only a first attempt, never a retry after uncertainty. */
export async function readChatUnifiedOptimizerQueuedClosureIntent(input: Readonly<{
  requestId: string; cycleId: string; reason: ChatUnifiedOptimizerQueuedCloseReason;
}>, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<
  Readonly<{ outcome: "not_found" | "intended" | "conflict" }>
> {
  const parsed = chatUnifiedOptimizerQueuedCloseSchema.safeParse(input);
  if (!parsed.success) return { outcome: "conflict" };
  const digest = chatUnifiedOptimizerQueuedCloseDigest(parsed.data);
  const rows = await db.$queryRaw<Array<{ requestId: string;
    closeRequestDigest: string }>>`
    SELECT "requestId"::text AS "requestId", "closeRequestDigest"
    FROM "ChatUnifiedOptimizerQueuedCloseIntent"
    WHERE "cycleId" = ${parsed.data.cycleId}::uuid
  `;
  if (!rows[0]) return { outcome: "not_found" };
  return rows[0].requestId === parsed.data.requestId &&
    rows[0].closeRequestDigest === digest
    ? { outcome: "intended" } : { outcome: "conflict" };
}

/** Reserve exactly one expired closure attempt before its terminal writer.
 * A committed reservation is never cleared, including when the writer fails. */
export async function intendChatUnifiedOptimizerQueuedClosure(input: Readonly<{
  requestId: string; cycleId: string; reason: ChatUnifiedOptimizerQueuedCloseReason;
}>, db: Db = prisma): Promise<Readonly<{ outcome: "intended" | "already_intended" }>> {
  const parsed = chatUnifiedOptimizerQueuedCloseSchema.safeParse(input);
  if (!parsed.success || parsed.data.reason !== "expired_before_dispatch")
    return refuse("input_invalid");
  const closeRequestDigest = chatUnifiedOptimizerQueuedCloseDigest(parsed.data);
  return db.$transaction(async tx => {
    await armLedgerTransaction(tx);
    await lockLedger(tx);
    const prior = await readChatUnifiedOptimizerQueuedClosureIntent(parsed.data, tx);
    if (prior.outcome === "intended") return { outcome: "already_intended" };
    if (prior.outcome === "conflict") return refuse("close_conflict");
    const jobs = await queuedClosureRows(tx, parsed.data.cycleId);
    if (jobs.length !== CHAT_UNIFIED_OPTIMIZER_ROLES.length ||
        jobs.some(job => job.cycleState !== "active" ||
          job.runState !== "active" ||
          job.cycleId !== parsed.data.cycleId ||
          job.runId !== jobs[0]!.runId ||
          !["queued", "succeeded"].includes(job.state)) ||
        !jobs.some(job => job.state === "queued"))
      return refuse("close_unavailable");
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock || jobs.some(job => job.deadlineAt.getTime() !==
        jobs[0]!.deadlineAt.getTime())) return refuse("close_conflict");
    if (clock.now.getTime() < jobs[0]!.deadlineAt.getTime())
      return refuse("deadline_not_elapsed");
    const auditLogId = await writeSystemAuditLog({
      tx, systemActor: SYSTEM_ACTOR, action: QUEUED_CLOSE_INTENT_ACTION,
      targetType: "ChatUnifiedOptimizerQueuedCloseIntent",
      targetId: parsed.data.cycleId,
      summary: "Reserved the sole expired optimizer queued closure attempt.",
      metadata: { purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
        cycleId: parsed.data.cycleId, closeRequestDigest,
        externalDispatchAuthorized: false, paidAuthorized: false,
        promotionAuthorized: false },
    });
    await tx.$executeRaw`
      INSERT INTO "ChatUnifiedOptimizerQueuedCloseIntent"
        ("cycleId", "requestId", "closeRequestDigest", "auditLogId")
      VALUES (${parsed.data.cycleId}::uuid, ${parsed.data.requestId}::uuid,
        ${closeRequestDigest}, ${auditLogId})
    `;
    return { outcome: "intended" } as const;
  }, transactionOptions);
}

/**
 * Closes only jobs whose provider-free role work was never dispatched. An
 * expiry is valid only once the DB deadline has elapsed; an explicit cancel
 * must commit before it. A claimed job is never guessed failed here: it keeps
 * the cycle latched for terminal read-back through the claimed-job writer.
 */
export async function closeChatUnifiedOptimizerQueuedJobs(input: Readonly<{
  requestId: string;
  cycleId: string;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
}>, db: Db = prisma): Promise<Readonly<{
  outcome: "closed" | "replayed";
  cycleId: string;
  runId: string;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
  closeRequestDigest: string;
  closedJobIds: readonly string[];
  cycleState: "failed";
  terminalAt: Date;
}>> {
  const parsed = chatUnifiedOptimizerQueuedCloseSchema.safeParse(input);
  if (!parsed.success) return refuse("input_invalid");
  const closeRequestDigest = chatUnifiedOptimizerQueuedCloseDigest(parsed.data);
  return db.$transaction(async tx => {
    await armLedgerTransaction(tx);
    await lockLedger(tx);
    const jobs = await queuedClosureRows(tx, parsed.data.cycleId);
    if (jobs.length !== CHAT_UNIFIED_OPTIMIZER_ROLES.length) {
      return refuse("close_unavailable");
    }
    const runId = jobs[0]!.runId;
    if (jobs.some(job => job.runId !== runId ||
        job.cycleId !== parsed.data.cycleId)) {
      return refuse("close_conflict");
    }

    if (jobs[0]!.cycleState === "failed" && jobs[0]!.runState === "failed") {
      const closed = jobs.filter(job => job.claimRequestId === null &&
        job.state === "failed");
      if (closed.length === 0 || jobs.some(job => {
        if (job.state === "succeeded" && job.claimRequestId !== null) {
          return false;
        }
        if (job.claimRequestId !== null || job.state !== "failed" ||
            job.terminalAuditAction !== QUEUED_TERMINAL_ACTION ||
            job.closeRequestDigest !== closeRequestDigest ||
            job.closeReason !== parsed.data.reason) return true;
        const facts = queuedClosureFacts(job, closeRequestDigest,
          parsed.data.reason);
        return job.terminalRequestId !== facts.terminalRequestId ||
          job.terminalRequestDigest !== facts.terminalRequestDigest ||
          job.evidenceRef !== facts.evidenceRef ||
          job.evidencePayloadDigest !== facts.evidencePayloadDigest;
      })) return refuse("close_conflict");
      const terminalAt = closed.reduce((latest, job) =>
        !latest || (job.terminalAt && job.terminalAt > latest)
          ? job.terminalAt : latest, null as Date | null);
      if (!terminalAt) return refuse("close_conflict");
      return { outcome: "replayed", cycleId: parsed.data.cycleId, runId,
        reason: parsed.data.reason, closeRequestDigest,
        closedJobIds: Object.freeze(closed.map(job => job.id)),
        cycleState: "failed", terminalAt } as const;
    }

    if (jobs[0]!.cycleState !== "active" || jobs[0]!.runState !== "active") {
      return refuse("close_unavailable");
    }
    if (jobs.some(job => job.state === "claimed" ||
        job.state === "outcome_unknown")) {
      return refuse("claimed_readback_required");
    }
    if (jobs.some(job => job.state !== "queued" &&
        job.state !== "succeeded")) return refuse("close_conflict");
    const queued = jobs.filter(job => job.state === "queued");
    if (queued.length === 0) return refuse("close_unavailable");
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) return refuse("close_unavailable");
    const deadline = jobs[0]!.deadlineAt;
    if (jobs.some(job => job.deadlineAt.getTime() !== deadline.getTime())) {
      return refuse("close_conflict");
    }
    if (parsed.data.reason === "expired_before_dispatch" &&
        clock.now.getTime() < deadline.getTime()) {
      return refuse("deadline_not_elapsed");
    }
    if (parsed.data.reason === "cancelled_before_dispatch" &&
        clock.now.getTime() >= deadline.getTime()) {
      return refuse("deadline_elapsed");
    }
    if (parsed.data.reason === "expired_before_dispatch") {
      const intent = await readChatUnifiedOptimizerQueuedClosureIntent(
        parsed.data, tx);
      if (intent.outcome !== "intended")
        return refuse(intent.outcome === "conflict"
          ? "close_conflict" : "close_intent_required");
    }

    let terminalAt: Date | null = null;
    for (const job of queued) {
      const facts = queuedClosureFacts(job, closeRequestDigest,
        parsed.data.reason);
      const terminalAuditLogId = await writeSystemAuditLog({
        tx,
        systemActor: SYSTEM_ACTOR,
        action: QUEUED_TERMINAL_ACTION,
        targetType: "ChatUnifiedOptimizerRoleJob",
        targetId: job.id,
        summary: "Closed one queued, untransmitted provider-free optimizer role job.",
        metadata: {
          ledgerVersion: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
          purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
          role: job.role,
          outcome: "failed",
          closeReason: parsed.data.reason,
          closeRequestDigest,
          terminalRequestDigest: facts.terminalRequestDigest,
          cycleId: job.cycleId,
          runId: job.runId,
          evidenceRef: facts.evidenceRef,
          evidencePayloadDigest: facts.evidencePayloadDigest,
          externalDispatchAuthorized: false,
          paidAuthorized: false,
          promotionAuthorized: false,
        },
      });
      const updated = await tx.$queryRaw<Array<{ terminalAt: Date }>>`
        UPDATE "ChatUnifiedOptimizerRoleJob"
        SET "state" = 'failed',
          "terminalRequestId" = ${facts.terminalRequestId}::uuid,
          "terminalRequestDigest" = ${facts.terminalRequestDigest},
          "terminalOutcome" = 'failed',
          "terminalAuditLogId" = ${terminalAuditLogId},
          "terminalAt" = clock_timestamp()
        WHERE "id" = ${job.id}::uuid AND "state" = 'queued'
          AND "claimRequestId" IS NULL
        RETURNING "terminalAt"
      `;
      if (!updated[0]) return refuse("close_conflict");
      terminalAt = updated[0].terminalAt;
      await tx.$executeRaw`
        INSERT INTO "ChatUnifiedOptimizerEvidence" (
          "id", "jobId", "runId", "cycleId", "candidateId", "outcome",
          "evidenceRef", "payloadDigest", "terminalAuditLogId", "createdAt")
        VALUES (${randomUUID()}::uuid, ${job.id}::uuid, ${job.runId}::uuid,
          ${job.cycleId}::uuid, ${job.candidateId}::uuid, 'failed',
          ${facts.evidenceRef}, ${facts.evidencePayloadDigest},
          ${terminalAuditLogId}, clock_timestamp())
      `;
    }
    const runUpdated = await tx.$executeRaw`
      UPDATE "ChatUnifiedOptimizerRun"
      SET "state" = 'failed', "terminalAt" = clock_timestamp()
      WHERE "id" = ${runId}::uuid AND "state" = 'active'
    `;
    if (runUpdated !== 1) return refuse("close_conflict");
    const cycleUpdated = await tx.$executeRaw`
      UPDATE "ChatUnifiedOptimizerCycle"
      SET "state" = 'failed', "terminalAt" = clock_timestamp()
      WHERE "id" = ${parsed.data.cycleId}::uuid AND "state" = 'active'
    `;
    if (cycleUpdated !== 1) return refuse("close_conflict");
    if (!terminalAt) return refuse("close_conflict");
    return { outcome: "closed", cycleId: parsed.data.cycleId, runId,
      reason: parsed.data.reason, closeRequestDigest,
      closedJobIds: Object.freeze(queued.map(job => job.id)),
      cycleState: "failed", terminalAt } as const;
  }, transactionOptions);
}

/** Read-only resolution of an expiry/cancel write whose response was lost.
 * The exact request and per-job audit/evidence must match; absence does not
 * authorize a retry because the original transaction may still be in flight. */
export async function readChatUnifiedOptimizerQueuedClosure(input: Readonly<{
  requestId: string;
  cycleId: string;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
}>, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<
  Readonly<{ outcome: "committed"; cycleId: string; runId: string;
    closeRequestDigest: string; closedJobIds: readonly string[];
    terminalAt: Date }> |
  Readonly<{ outcome: "not_found" | "conflict" }>
> {
  const parsed = chatUnifiedOptimizerQueuedCloseSchema.safeParse(input);
  if (!parsed.success) return { outcome: "conflict" };
  const closeRequestDigest = chatUnifiedOptimizerQueuedCloseDigest(parsed.data);
  const jobs = await db.$queryRaw<QueuedClosureJobRow[]>`
    SELECT j."id"::text AS "id", j."runId"::text AS "runId",
      r."cycleId"::text AS "cycleId", k."id"::text AS "candidateId",
      j."role", j."state", j."deadlineAt", r."state" AS "runState",
      c."state" AS "cycleState", j."claimToken"::text AS "claimToken",
      j."claimRequestId"::text AS "claimRequestId",
      j."terminalRequestId"::text AS "terminalRequestId",
      j."terminalRequestDigest", j."terminalOutcome", j."terminalAt",
      a."action" AS "terminalAuditAction",
      a."metadata"->>'closeRequestDigest' AS "closeRequestDigest",
      a."metadata"->>'closeReason' AS "closeReason",
      e."evidenceRef", e."payloadDigest" AS "evidencePayloadDigest"
    FROM "ChatUnifiedOptimizerCycle" c
    JOIN "ChatUnifiedOptimizerRun" r
      ON r."cycleId" = c."id" AND r."ordinal" = 1
    JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
    JOIN "ChatUnifiedOptimizerRoleJob" j ON j."runId" = r."id"
    LEFT JOIN "AdminAuditLog" a ON a."id" = j."terminalAuditLogId"
    LEFT JOIN "ChatUnifiedOptimizerEvidence" e ON e."jobId" = j."id"
    WHERE c."id" = ${parsed.data.cycleId}::uuid
    ORDER BY j."role"
  `;
  if (jobs.length === 0) return { outcome: "not_found" };
  if (jobs.length !== CHAT_UNIFIED_OPTIMIZER_ROLES.length ||
      new Set(jobs.map(job => job.role)).size !==
        CHAT_UNIFIED_OPTIMIZER_ROLES.length ||
      jobs.some(job => !CHAT_UNIFIED_OPTIMIZER_ROLES.includes(job.role) ||
        job.cycleId !== parsed.data.cycleId ||
        job.runId !== jobs[0]!.runId)) return { outcome: "conflict" };
  if (jobs[0]!.cycleState === "active" &&
      jobs[0]!.runState === "active") return { outcome: "not_found" };
  if (jobs.some(job => job.cycleState !== "failed" ||
      job.runState !== "failed")) return { outcome: "conflict" };
  const closed = jobs.filter(job => job.claimRequestId === null &&
    job.state === "failed");
  if (closed.length === 0 || jobs.some(job => {
    if (job.state === "succeeded" && job.claimRequestId !== null)
      return false;
    if (job.claimRequestId !== null || job.state !== "failed" ||
        job.terminalAuditAction !== QUEUED_TERMINAL_ACTION ||
        job.closeRequestDigest !== closeRequestDigest ||
        job.closeReason !== parsed.data.reason) return true;
    const facts = queuedClosureFacts(job, closeRequestDigest,
      parsed.data.reason);
    return job.terminalRequestId !== facts.terminalRequestId ||
      job.terminalRequestDigest !== facts.terminalRequestDigest ||
      job.terminalOutcome !== "failed" ||
      job.evidenceRef !== facts.evidenceRef ||
      job.evidencePayloadDigest !== facts.evidencePayloadDigest ||
      !(job.terminalAt instanceof Date) ||
      !Number.isFinite(job.terminalAt.getTime());
  })) return { outcome: "conflict" };
  const terminalAt = closed.reduce((latest, job) =>
    !latest || (job.terminalAt && job.terminalAt > latest)
      ? job.terminalAt : latest, null as Date | null);
  if (!terminalAt) return { outcome: "conflict" };
  return { outcome: "committed", cycleId: parsed.data.cycleId,
    runId: jobs[0]!.runId, closeRequestDigest,
    closedJobIds: Object.freeze(closed.map(job => job.id)), terminalAt };
}

const terminalRead = async (
  db: Pick<typeof prisma, "$queryRaw">,
  requestId: string,
): Promise<TerminalRow | null> => {
  const rows = await db.$queryRaw<TerminalRow[]>`
    SELECT j."id"::text AS "jobId", j."terminalRequestDigest",
      j."terminalOutcome", j."state", j."terminalAt",
      e."evidenceRef", e."payloadDigest" AS "evidencePayloadDigest"
    FROM "ChatUnifiedOptimizerRoleJob" j
    LEFT JOIN "ChatUnifiedOptimizerEvidence" e ON e."jobId" = j."id"
    WHERE j."terminalRequestId" = ${requestId}::uuid
  `;
  return rows[0] ?? null;
};

export async function readChatUnifiedOptimizerTerminal(
  input: Readonly<{ requestId: string; terminalDigest: string }>,
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<Readonly<{ outcome: "committed"; jobId: string;
  terminalOutcome: ChatUnifiedOptimizerTerminalOutcome; terminalAt: Date;
  evidenceRef: string | null; evidencePayloadDigest: string | null }> |
  Readonly<{ outcome: "not_found" | "conflict" }>> {
  if (!chatUnifiedOptimizerTerminalSchema.shape.requestId.safeParse(
    input.requestId,
  ).success || !/^[0-9a-f]{64}$/.test(input.terminalDigest)) {
    return { outcome: "not_found" };
  }
  const row = await terminalRead(db, input.requestId);
  if (!row) return { outcome: "not_found" };
  if (row.terminalRequestDigest !== input.terminalDigest) {
    return { outcome: "conflict" };
  }
  return { outcome: "committed", jobId: row.jobId,
    terminalOutcome: row.terminalOutcome, terminalAt: row.terminalAt,
    evidenceRef: row.evidenceRef,
    evidencePayloadDigest: row.evidencePayloadDigest };
}

export async function recordChatUnifiedOptimizerRoleJobTerminal(input: Readonly<{
  requestId: string;
  jobId: string;
  claimToken: string;
  outcome: ChatUnifiedOptimizerTerminalOutcome;
  evidenceRef: string | null;
  evidencePayloadDigest: string | null;
}>, db: Db = prisma): Promise<Readonly<{
  outcome: "recorded" | "replayed";
  jobId: string;
  terminalOutcome: ChatUnifiedOptimizerTerminalOutcome;
  terminalDigest: string;
  terminalAt: Date;
  runState: "active" | ChatUnifiedOptimizerTerminalOutcome;
  cycleState: "active" | ChatUnifiedOptimizerTerminalOutcome;
}>> {
  const parsed = chatUnifiedOptimizerTerminalSchema.safeParse(input);
  if (!parsed.success) return refuse("input_invalid");
  const terminalDigest = chatUnifiedOptimizerTerminalDigest(parsed.data);
  return db.$transaction(async tx => {
    await armLedgerTransaction(tx);
    await lockLedger(tx);
    const existing = await terminalRead(tx, parsed.data.requestId);
    if (existing) {
      if (existing.terminalRequestDigest !== terminalDigest ||
          existing.jobId !== parsed.data.jobId) return refuse("terminal_conflict");
      const states = await tx.$queryRaw<Array<{ runState: string;
        cycleState: string }>>`
        SELECT r."state" AS "runState", c."state" AS "cycleState"
        FROM "ChatUnifiedOptimizerRoleJob" j
        JOIN "ChatUnifiedOptimizerRun" r ON r."id" = j."runId"
        JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
        WHERE j."id" = ${existing.jobId}::uuid
      `;
      return { outcome: "replayed", jobId: existing.jobId,
        terminalOutcome: existing.terminalOutcome, terminalDigest,
        terminalAt: existing.terminalAt,
        runState: states[0]?.runState as "active" | ChatUnifiedOptimizerTerminalOutcome,
        cycleState: states[0]?.cycleState as "active" | ChatUnifiedOptimizerTerminalOutcome } as const;
    }
    // A role may finish after the owner stops the cycle. The shared audit
    // lock serializes this read with the stop writer; only an unknown outcome
    // may be recorded after stop so a late success cannot become evidence.
    if (parsed.data.outcome !== "outcome_unknown") {
      await requireStopUnlatched(tx);
    }
    const jobs = await tx.$queryRaw<JobLockRow[]>`
      SELECT j."id"::text AS "id", j."runId"::text AS "runId",
        r."cycleId"::text AS "cycleId", k."id"::text AS "candidateId",
        j."role", j."state", j."deadlineAt", r."state" AS "runState",
        c."state" AS "cycleState", j."claimToken"::text AS "claimToken"
      FROM "ChatUnifiedOptimizerRoleJob" j
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = j."runId"
      JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
      JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
      WHERE j."id" = ${parsed.data.jobId}::uuid
      FOR UPDATE OF j, r, c
    `;
    const job = jobs[0];
    if (!job || job.state !== "claimed" || job.runState !== "active" ||
        job.cycleState !== "active") return refuse("job_unavailable");
    if (job.claimToken !== parsed.data.claimToken) {
      return refuse("claim_authority_invalid");
    }
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) return refuse("job_unavailable");
    if (parsed.data.outcome !== "outcome_unknown" &&
        clock.now.getTime() >= job.deadlineAt.getTime()) {
      return refuse("late_terminal");
    }
    const terminalAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: SYSTEM_ACTOR,
      action: RUN_TERMINAL_ACTION,
      targetType: "ChatUnifiedOptimizerRoleJob",
      targetId: job.id,
      summary: "Recorded one provider-free unified optimizer role outcome.",
      metadata: {
        ledgerVersion: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
        purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
        role: job.role,
        outcome: parsed.data.outcome,
        terminalRequestDigest: terminalDigest,
        ...(parsed.data.evidenceRef === null ? {} : {
          evidenceRef: parsed.data.evidenceRef,
          evidencePayloadDigest: parsed.data.evidencePayloadDigest!,
        }),
        externalDispatchAuthorized: false,
        paidAuthorized: false,
        promotionAuthorized: false,
      },
    });
    const updated = await tx.$queryRaw<Array<{ terminalAt: Date }>>`
      UPDATE "ChatUnifiedOptimizerRoleJob"
      SET "state" = ${parsed.data.outcome},
        "terminalRequestId" = ${parsed.data.requestId}::uuid,
        "terminalRequestDigest" = ${terminalDigest},
        "terminalOutcome" = ${parsed.data.outcome},
        "terminalAuditLogId" = ${terminalAuditLogId},
        "terminalAt" = clock_timestamp()
      WHERE "id" = ${job.id}::uuid AND "state" = 'claimed'
        AND "claimToken" = ${parsed.data.claimToken}::uuid
      RETURNING "terminalAt"
    `;
    if (!updated[0]) return refuse("claim_authority_invalid");
    if (parsed.data.outcome !== "outcome_unknown") {
      await tx.$executeRaw`
        INSERT INTO "ChatUnifiedOptimizerEvidence" (
          "id", "jobId", "runId", "cycleId", "candidateId", "outcome",
          "evidenceRef", "payloadDigest", "terminalAuditLogId", "createdAt")
        VALUES (${randomUUID()}::uuid, ${job.id}::uuid, ${job.runId}::uuid,
          ${job.cycleId}::uuid, ${job.candidateId}::uuid,
          ${parsed.data.outcome}, ${parsed.data.evidenceRef!},
          ${parsed.data.evidencePayloadDigest!}, ${terminalAuditLogId},
          clock_timestamp())
      `;
    }

    let nextState: "active" | ChatUnifiedOptimizerTerminalOutcome = "active";
    if (parsed.data.outcome === "outcome_unknown") {
      nextState = "outcome_unknown";
    } else if (parsed.data.outcome === "failed") {
      nextState = "failed";
    } else {
      const remaining = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS "count"
        FROM "ChatUnifiedOptimizerRoleJob"
        WHERE "runId" = ${job.runId}::uuid AND "state" <> 'succeeded'
      `;
      if (remaining[0]?.count === BigInt(0)) nextState = "succeeded";
    }
    if (nextState !== "active") {
      await tx.$executeRaw`
        UPDATE "ChatUnifiedOptimizerRun"
        SET "state" = ${nextState}, "terminalAt" = clock_timestamp()
        WHERE "id" = ${job.runId}::uuid AND "state" = 'active'
      `;
      await tx.$executeRaw`
        UPDATE "ChatUnifiedOptimizerCycle"
        SET "state" = ${nextState}, "terminalAt" = clock_timestamp()
        WHERE "id" = ${job.cycleId}::uuid AND "state" = 'active'
      `;
    }
    return { outcome: "recorded", jobId: job.id,
      terminalOutcome: parsed.data.outcome, terminalDigest,
      terminalAt: updated[0].terminalAt, runState: nextState,
      cycleState: nextState } as const;
  }, transactionOptions);
}
