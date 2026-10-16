import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AdminAuditLog, Prisma, PrismaClient } from "@prisma/client";

import {
  adminAuditIntegrityKeys,
  computeAdminAuditEntryHash,
} from "@/lib/adminAuditIntegrityCore";
import {
  createChatUnifiedOptimizerCandidate,
} from "@/lib/chatUnifiedOptimizerCandidate";
import { CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE } from
  "@/lib/chatUnifiedRouterRefinerPrompt";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const EVIDENCE_DIGEST = "e".repeat(64);
const SOURCE_SHA = "1".repeat(40);

const output = {
  schemaVersion: "unified-router-refiner-v1",
  analysis: { kind: "writing", difficulty: "simple",
    expectedOutputLength: "short", needsCurrentInformation: false },
  rewrite: { decision: "keep_original", text: null },
};

const bundle = (suffix: string) => createChatUnifiedOptimizerCandidate(
  JSON.stringify({
    taskGuidance: `${CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE}\n${suffix}`,
    publicExamples: [{ fixtureRef: `public:optimizer-ledger-${suffix}`,
      sourceText: `Synthetic source ${suffix}.`, output }],
  }),
);

const assertCanonicalAuditRows = async (
  prisma: PrismaClient,
  rows: readonly AdminAuditLog[],
) => {
  const activeKey = adminAuditIntegrityKeys(process.env)[0];
  assert.ok(activeKey);
  for (const row of rows) {
    const previous = await prisma.adminAuditLog.findFirst({
      where: {
        entryHash: { not: null },
        OR: [
          { createdAt: { lt: row.createdAt } },
          { createdAt: row.createdAt, id: { lt: row.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { entryHash: true },
    });
    assert.equal(row.previousHash, previous?.entryHash ?? null);
    assert.equal(row.entryHash, computeAdminAuditEntryHash({
      previousHash: row.previousHash,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      metadata: row.metadata || null,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    }, activeKey));
  }
};

test("provider-free optimizer ledger enforces frozen identity, CAS and unknown stop", {
  skip: !rawUrl,
}, async t => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  process.env.DATABASE_URL = rawUrl;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.NEXTAUTH_SECRET ||= "chat-unified-optimizer-synthetic-audit-key";

  const { prisma } = await import("@/lib/prisma");
  const ledger = await import("@/lib/chatUnifiedOptimizerLedgerStore");

  const firstBundle = bundle("first");
  const firstRequestId = randomUUID();
  const first = await ledger.registerChatUnifiedOptimizerCycle({
    requestId: firstRequestId,
    candidateBundleJson: JSON.stringify(firstBundle),
    expectedBundleDigest: firstBundle.bundleDigest,
    sourceCommitSha: SOURCE_SHA,
    deadlineAt: new Date(Date.now() + 60_000),
  });

  await t.test("registration stores identity only and exact replay is read-only", async () => {
    assert.equal(first.outcome, "created");
    assert.equal(Object.keys(first.jobIds).length, 6);
    const replay = await ledger.registerChatUnifiedOptimizerCycle({
      requestId: firstRequestId,
      candidateBundleJson: JSON.stringify(firstBundle),
      expectedBundleDigest: firstBundle.bundleDigest,
      sourceCommitSha: SOURCE_SHA,
      deadlineAt: first.deadlineAt,
    });
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.cycleId, first.cycleId);
    await assert.rejects(ledger.registerChatUnifiedOptimizerCycle({
      requestId: firstRequestId,
      candidateBundleJson: JSON.stringify(firstBundle),
      expectedBundleDigest: firstBundle.bundleDigest,
      sourceCommitSha: SOURCE_SHA,
      deadlineAt: new Date(first.deadlineAt.getTime() + 1),
    }), (error: unknown) => error instanceof ledger.ChatUnifiedOptimizerLedgerError &&
      error.code === "registration_conflict");

    const [stored] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "ChatUnifiedOptimizerCandidate"
      WHERE "id" = ${first.candidateId}::uuid
    `;
    const persisted = JSON.stringify(stored);
    assert.equal(persisted.includes("Synthetic source first."), false);
    assert.equal(persisted.includes(CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE), false);
    assert.equal(persisted.includes("runtimeAuthorized\":true"), false);
    const columns = await prisma.$queryRaw<Array<{ columnName: string }>>`
      SELECT column_name AS "columnName" FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('ChatUnifiedOptimizerCycle',
          'ChatUnifiedOptimizerCandidate', 'ChatUnifiedOptimizerRun',
          'ChatUnifiedOptimizerRoleJob', 'ChatUnifiedOptimizerEvidence')
    `;
    for (const forbidden of ["body", "sourceText", "promptText", "hiddenCase",
      "rubric", "providerProse"]) {
      assert.equal(columns.some(column => column.columnName === forbidden), false);
    }
    const readback = await ledger.readChatUnifiedOptimizerRegistration({
      requestId: firstRequestId, registrationDigest: first.registrationDigest,
    });
    assert.equal(readback.outcome, "committed");
    assert.equal((await ledger.readChatUnifiedOptimizerRegistration({
      requestId: firstRequestId, registrationDigest: "f".repeat(64),
    })).outcome, "conflict");
  });

  await t.test("one concurrent claim wins and a forged capability cannot close it", async () => {
    const [candidateAuthor, caseAuthor] = [
      first.jobIds.candidate_author,
      first.jobIds.case_author,
    ];
    const results = await Promise.allSettled([
      ledger.claimChatUnifiedOptimizerRoleJob({
        requestId: randomUUID(), jobId: candidateAuthor,
      }),
      ledger.claimChatUnifiedOptimizerRoleJob({
        requestId: randomUUID(), jobId: caseAuthor,
      }),
    ]);
    const claimed = results.find((result): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof ledger.claimChatUnifiedOptimizerRoleJob>>> =>
      result.status === "fulfilled");
    const refused = results.find(result => result.status === "rejected");
    assert.ok(claimed);
    assert.ok(refused);
    assert.equal((refused as PromiseRejectedResult).reason.code, "claim_busy");
    await assert.rejects(ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: randomUUID(), jobId: claimed.value.jobId,
      claimToken: randomUUID(), outcome: "succeeded",
      evidenceRef: "synthetic:forged", evidencePayloadDigest: EVIDENCE_DIGEST,
    }), (error: unknown) => error instanceof ledger.ChatUnifiedOptimizerLedgerError &&
      error.code === "claim_authority_invalid");
    const terminalRequestId = randomUUID();
    const terminal = await ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: terminalRequestId, jobId: claimed.value.jobId,
      claimToken: claimed.value.claimToken, outcome: "succeeded",
      evidenceRef: `synthetic:${claimed.value.role}`,
      evidencePayloadDigest: EVIDENCE_DIGEST,
    });
    assert.equal(terminal.outcome, "recorded");
    assert.equal(terminal.runState, "active");
    const replay = await ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: terminalRequestId, jobId: claimed.value.jobId,
      claimToken: claimed.value.claimToken, outcome: "succeeded",
      evidenceRef: `synthetic:${claimed.value.role}`,
      evidencePayloadDigest: EVIDENCE_DIGEST,
    });
    assert.equal(replay.outcome, "replayed");
    assert.equal((await ledger.readChatUnifiedOptimizerTerminal({
      requestId: terminalRequestId, terminalDigest: terminal.terminalDigest,
    })).outcome, "committed");
  });

  await t.test("all six known role facts close only the provider-free run", async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string; role: string;
      state: string }>>`
      SELECT "id"::text AS "id", "role", "state"
      FROM "ChatUnifiedOptimizerRoleJob"
      WHERE "runId" = ${first.runId}::uuid ORDER BY "role"
    `;
    for (const job of rows.filter(row => row.state === "queued")) {
      const claim = await ledger.claimChatUnifiedOptimizerRoleJob({
        requestId: randomUUID(), jobId: job.id,
      });
      await ledger.recordChatUnifiedOptimizerRoleJobTerminal({
        requestId: randomUUID(), jobId: job.id,
        claimToken: claim.claimToken, outcome: "succeeded",
        evidenceRef: `synthetic:${job.role}`,
        evidencePayloadDigest: EVIDENCE_DIGEST,
      });
    }
    const aggregate = await prisma.$queryRaw<Array<{ cycleState: string;
      runState: string; runtimeAuthorized: boolean }>>`
      SELECT c."state" AS "cycleState", r."state" AS "runState",
        k."runtimeAuthorized"
      FROM "ChatUnifiedOptimizerCycle" c
      JOIN "ChatUnifiedOptimizerRun" r ON r."cycleId" = c."id"
      JOIN "ChatUnifiedOptimizerCandidate" k ON k."cycleId" = c."id"
      WHERE c."id" = ${first.cycleId}::uuid
    `;
    assert.deepEqual(aggregate, [{ cycleState: "succeeded",
      runState: "succeeded", runtimeAuthorized: false }]);
  });

  await t.test("deferred DB clock rejects late success and unknown closes", async () => {
    const secondBundle = bundle("second");
    const second = await ledger.registerChatUnifiedOptimizerCycle({
      requestId: randomUUID(), candidateBundleJson: JSON.stringify(secondBundle),
      expectedBundleDigest: secondBundle.bundleDigest,
      sourceCommitSha: "2".repeat(40),
      deadlineAt: new Date(Date.now() + 2_500),
    });
    for (const [role, jobId] of Object.entries(second.jobIds)) {
      if (role === "case_author") continue;
      const priorClaim = await ledger.claimChatUnifiedOptimizerRoleJob({
        requestId: randomUUID(), jobId,
      });
      await ledger.recordChatUnifiedOptimizerRoleJobTerminal({
        requestId: randomUUID(), jobId,
        claimToken: priorClaim.claimToken, outcome: "succeeded",
        evidenceRef: `synthetic:${role}`,
        evidencePayloadDigest: EVIDENCE_DIGEST,
      });
    }
    const claim = await ledger.claimChatUnifiedOptimizerRoleJob({
      requestId: randomUUID(), jobId: second.jobIds.case_author,
    });
    let armed: { transactionMs: number; statementMs: number;
      idleMs: number } | undefined;
    const delayedCommitDb = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      $transaction: async (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: { maxWait?: number; timeout?: number },
      ) => prisma.$transaction(async tx => {
        const result = await work(tx);
        [armed] = await tx.$queryRaw<Array<{ transactionMs: number;
          statementMs: number; idleMs: number }>>`
          SELECT
            (SELECT setting::int FROM pg_settings
              WHERE name = 'transaction_timeout') AS "transactionMs",
            (SELECT setting::int FROM pg_settings
              WHERE name = 'statement_timeout') AS "statementMs",
            (SELECT setting::int FROM pg_settings
              WHERE name = 'idle_in_transaction_session_timeout') AS "idleMs"
        `;
        await tx.$executeRaw`
          SELECT pg_sleep(GREATEST(0.05,
            EXTRACT(EPOCH FROM (${second.deadlineAt}::timestamptz -
              clock_timestamp())) + 0.05))
        `;
        return result;
      }, options),
    } as unknown as NonNullable<Parameters<
      typeof ledger.recordChatUnifiedOptimizerRoleJobTerminal
    >[1]>;

    await assert.rejects(ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: randomUUID(), jobId: claim.jobId,
      claimToken: claim.claimToken, outcome: "succeeded",
      evidenceRef: "synthetic:late", evidencePayloadDigest: EVIDENCE_DIGEST,
    }, delayedCommitDb), /chat_unified_optimizer_deadline_elapsed/);
    assert.deepEqual(armed, { transactionMs: 5_000, statementMs: 4_000,
      idleMs: 4_000 });
    const [rolledBack] = await prisma.$queryRaw<Array<{ state: string;
      terminalAt: Date | null; evidenceCount: bigint; auditCount: bigint }>>`
      SELECT j."state", j."terminalAt",
        (SELECT COUNT(*)::bigint FROM "ChatUnifiedOptimizerEvidence" e
          WHERE e."jobId" = j."id") AS "evidenceCount",
        (SELECT COUNT(*)::bigint FROM "AdminAuditLog" a
          WHERE a."action" = 'chat.unified_optimizer.run_terminal'
            AND a."targetType" = 'ChatUnifiedOptimizerRoleJob'
            AND a."targetId" = j."id"::text) AS "auditCount"
      FROM "ChatUnifiedOptimizerRoleJob" j
      WHERE j."id" = ${claim.jobId}::uuid
    `;
    assert.deepEqual(rolledBack, { state: "claimed", terminalAt: null,
      evidenceCount: BigInt(0), auditCount: BigInt(0) });
    await assert.rejects(ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: randomUUID(), jobId: claim.jobId,
      claimToken: claim.claimToken, outcome: "succeeded",
      evidenceRef: "synthetic:late", evidencePayloadDigest: EVIDENCE_DIGEST,
    }), (error: unknown) => error instanceof ledger.ChatUnifiedOptimizerLedgerError &&
      error.code === "late_terminal");
    const unknown = await ledger.recordChatUnifiedOptimizerRoleJobTerminal({
      requestId: randomUUID(), jobId: claim.jobId,
      claimToken: claim.claimToken, outcome: "outcome_unknown",
      evidenceRef: null, evidencePayloadDigest: null,
    });
    assert.equal(unknown.runState, "outcome_unknown");
    assert.equal(unknown.cycleState, "outcome_unknown");
    assert.equal((await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count" FROM "ChatUnifiedOptimizerEvidence"
      WHERE "jobId" = ${claim.jobId}::uuid
    `)[0]?.count, BigInt(0));
    await assert.rejects(ledger.claimChatUnifiedOptimizerRoleJob({
      requestId: randomUUID(), jobId: second.jobIds.coordinator,
    }), (error: unknown) => error instanceof ledger.ChatUnifiedOptimizerLedgerError &&
      error.code === "job_unavailable");
    const thirdBundle = bundle("third");
    await assert.rejects(ledger.registerChatUnifiedOptimizerCycle({
      requestId: randomUUID(), candidateBundleJson: JSON.stringify(thirdBundle),
      expectedBundleDigest: thirdBundle.bundleDigest,
      sourceCommitSha: "3".repeat(40), deadlineAt: new Date(Date.now() + 60_000),
    }), (error: unknown) => error instanceof ledger.ChatUnifiedOptimizerLedgerError &&
      error.code === "active_cycle_exists");
  });

  await t.test("database guards roll back forged authority and audit is canonical", async () => {
    await assert.rejects(prisma.$executeRaw`
      UPDATE "ChatUnifiedOptimizerCandidate" SET "runtimeAuthorized" = TRUE
      WHERE "id" = ${first.candidateId}::uuid
    `, /chat_unified_optimizer_immutable/);
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRaw`
        UPDATE "ChatUnifiedOptimizerCycle" SET "state" = 'failed',
          "terminalAt" = clock_timestamp()
        WHERE "id" = ${first.cycleId}::uuid
      `;
    }), /chat_unified_optimizer|aggregate_state_invalid/);
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: { in: [
        "chat.unified_optimizer.run_admitted",
        "chat.unified_optimizer.dispatch_intended",
        "chat.unified_optimizer.run_terminal",
      ] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    assert.ok(audits.length >= 16);
    for (const audit of audits) {
      const metadata = audit.metadata as Record<string, unknown>;
      assert.equal(metadata.systemActor, "chat-unified-optimizer");
      assert.equal(metadata.purpose, "provider_free_validation");
      assert.equal(metadata.externalDispatchAuthorized, false);
      assert.equal(metadata.paidAuthorized, false);
      assert.equal(JSON.stringify(metadata).includes("Synthetic source"), false);
      assert.equal(JSON.stringify(metadata).includes(CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE), false);
    }
    await assertCanonicalAuditRows(prisma, audits);
  });
});
