import "server-only";

import { randomUUID } from "node:crypto";

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
  chatUnifiedOptimizerRegistrationDigest,
  chatUnifiedOptimizerRegistrationSchema,
  chatUnifiedOptimizerTerminalDigest,
  chatUnifiedOptimizerTerminalSchema,
  type ChatUnifiedOptimizerRole,
  type ChatUnifiedOptimizerTerminalOutcome,
} from "@/lib/chatUnifiedOptimizerLedgerCore";
import { prisma } from "@/lib/prisma";

const SYSTEM_ACTOR = "chat-unified-optimizer" as const;
const RUN_ADMITTED_ACTION = "chat.unified_optimizer.run_admitted" as const;
const DISPATCH_INTENDED_ACTION =
  "chat.unified_optimizer.dispatch_intended" as const;
const RUN_TERMINAL_ACTION = "chat.unified_optimizer.run_terminal" as const;
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
    | "terminal_conflict"
    | "claim_authority_invalid"
    | "late_terminal"
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

const lockLedger = async (tx: Prisma.TransactionClient): Promise<void> => {
  await takeAuditChainLock(tx);
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('chat-unified-optimizer-ledger-v1'))
  `;
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
 * The candidate body is strictly validated in memory and discarded; only its
 * immutable identity is persisted. This is proposal metadata, never approval.
 */
export async function registerChatUnifiedOptimizerCycle(input: Readonly<{
  requestId: string;
  candidateBundleJson: string;
  expectedBundleDigest: string;
  sourceCommitSha: string;
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
        ${parsed.data.sourceCommitSha}, FALSE, clock_timestamp())
    `;
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
