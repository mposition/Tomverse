import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { before, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
import {
  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
  PROMPT_REFINER_EXECUTION_MODEL_PIN,
} from "@/lib/promptRefinerExecutionContract";
import {
  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  PROMPT_REFINER_RESERVATION_STAGE_ID,
  PROMPT_REFINER_RESERVATION_TTL_MS,
} from "@/lib/promptRefinerReservationCore";
import {
  consumePromptRefinerReservation,
  reservePromptRefinerExecution,
} from "@/lib/promptRefinerReservationAuthority";
import {
  createPromptRefinerReservationStage,
  loadPromptRefinerStageAdmissionFacts,
} from "@/lib/promptRefinerStageAdmission";
import {
  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
  PROMPT_REFINER_STAGE_REASON,
  buildPromptRefinerStagePreviewBinding,
  promptRefinerStagePreviewBindingDigest,
} from "@/lib/promptRefinerStageAdmissionCore";

process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
process.env.RAILWAY_GIT_COMMIT_SHA = "b".repeat(40);
process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test";
const AUDIT_FIXTURE_KEY = "prompt-refiner-reservation-strong-fixture-key";
process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_FIXTURE_KEY;

const session = {
  user: {
    id: "mposition",
    email: "owner@example.com",
    authenticatedAt: new Date().toISOString(),
  },
} as Session;

const request = () =>
  new Request("http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage", {
    method: "POST",
    headers: { "user-agent": "db-integration" },
  });

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PromptRefinerShadowAttempt",
      "PromptRefinerShadowRun",
      "PromptRefinerReservation",
      "PromptRefinerReservationStage",
      "AmuxReviewDecision",
      "AdminAuditLog"
    RESTART IDENTITY
  `);
};

const ensureRuntimeModel = async () => {
  const row = staticModelRegistrySeedRows().find(
    (candidate) => candidate.id === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId
  );
  assert.ok(row);
  await prisma.modelRegistryEntry.upsert({
    where: { id: row.id },
    create: row,
    update: row,
  });
};

const expected = async () => {
  const facts = await loadPromptRefinerStageAdmissionFacts();
  return {
    proposalDigest: facts.proposalDigest,
    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
    executionManifestDigest: facts.executionManifestDigest,
    previewBindingDigest: promptRefinerStagePreviewBindingDigest(
      buildPromptRefinerStagePreviewBinding(facts)
    ),
  };
};

const create = async () =>
  createPromptRefinerReservationStage({
    session,
    request: request(),
    expected: await expected(),
  });

const seedFutureAuditHead = async (offsetMs: number) => {
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  assert.ok(clock);
  const createdAt = new Date(clock.now.getTime() + offsetMs);
  const entryHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
  await prisma.adminAuditLog.create({
    data: {
      action: "test.audit_head.seeded",
      targetType: "PromptRefinerReservationStageTest",
      summary: "Seeded a deterministic audit-chain head for stage timestamp coverage.",
      previousHash: null,
      entryHash,
      createdAt,
    },
  });
  return { createdAt, entryHash };
};

before(async () => {
  await ensureRuntimeModel();
});

beforeEach(async () => {
  process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test";
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_FIXTURE_KEY;
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  await reset();
});

test("migration has no seed and the writer atomically binds provenance to one audit", async () => {
  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
  const migration = readFileSync(
    "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
    "utf8"
  );
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"PromptRefinerReservationStage"/i);
  assert.match(
    migration,
    /IF EXISTS \(SELECT 1 FROM "PromptRefinerReservationStage"\)[\s\S]*RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row'/
  );

  const created = await create();
  assert.equal(created.created, true);
  assert.equal(created.replayed, false);
  assert.equal(created.stage.reservationCount, 0);
  assert.equal(created.stage.allocatedCostMicroUsd, BigInt(0));
  assert.equal(created.stage.runtimeEnvironment, "staging");
  assert.equal(created.stage.approvalExpiresAt.getTime() - created.stage.approvedAt.getTime(), 60 * 60 * 1_000);
  assert.equal(await prisma.promptRefinerReservation.count(), 0);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: created.stage.authorizationAuditLogId },
  });
  assert.equal(audit.actorUserId, "mposition");
  assert.equal(audit.action, "prompt_refiner.shadow_stage.activated");
  assert.equal(audit.entryHash?.length, 64);
  await assert.rejects(
    prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "PromptRefinerReservationStage") THEN
          RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row';
        END IF;
      END;
      $$;
    `),
    /unexpected pre-admission row/i
  );
});

test("stage audit freshness uses UTC under a non-UTC database session", async () => {
  const facts = await loadPromptRefinerStageAdmissionFacts();
  const auditId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Australia/Brisbane'`);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    assert.ok(clock);
    const approvedAt = clock.now;
    const approvalExpiresAt = new Date(
      approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
    );
    await tx.adminAuditLog.create({
      data: {
        id: auditId,
        actorUserId: "mposition",
        actorEmail: "owner@example.com",
        action: "prompt_refiner.shadow_stage.activated",
        targetType: "PromptRefinerReservationStage",
        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
        metadata: {
          admissionVersion: facts.admissionVersion,
          proposalDigest: facts.proposalDigest,
          evidenceBundleDigest: facts.evidenceBundleDigest,
          runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
          executionManifestDigest: facts.executionManifestDigest,
          environment: facts.runtimeEnvironment,
          deploymentId: facts.runtimeDeploymentId,
          commitSha: facts.runtimeCommitSha,
          perRequestCostMicroUsd: 24_916,
          maxReservations: 100,
          costCeilingMicroUsd: 2_491_600,
          approvalTtlMinutes: 60,
          approvedAt: approvedAt.toISOString(),
          approvalExpiresAt: approvalExpiresAt.toISOString(),
          reason: PROMPT_REFINER_STAGE_REASON,
        },
        previousHash: null,
        entryHash: "e".repeat(64),
        createdAt: approvedAt,
      },
    });
    await tx.promptRefinerReservationStage.create({
      data: {
        id: PROMPT_REFINER_RESERVATION_STAGE_ID,
        contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
        status: "approved",
        perRequestCostMicroUsd: BigInt(24_916),
        maxReservations: 100,
        costCeilingMicroUsd: BigInt(2_491_600),
        reservationCount: 0,
        allocatedCostMicroUsd: BigInt(0),
        admissionVersion: facts.admissionVersion,
        proposalVersion: facts.proposalVersion,
        proposalDigest: facts.proposalDigest,
        evidenceBundleDigest: facts.evidenceBundleDigest,
        evidenceManifestSha256: facts.evidenceManifestSha256,
        historicalSourceRef: facts.historicalSourceRef,
        historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
        corpusDigest: facts.corpusDigest,
        runtimeCommitSha: facts.runtimeCommitSha,
        runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
        runtimeSourceManifest: facts.runtimeSourceManifest,
        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
        runtimeEnvironment: facts.runtimeEnvironment,
        runtimeDeploymentId: facts.runtimeDeploymentId,
        executionManifest: facts.executionManifest,
        executionManifestDigest: facts.executionManifestDigest,
        approvedBy: "mposition",
        approvedAt,
        approvalExpiresAt,
        authorizationAuditLogId: auditId,
        createdAt: approvedAt,
      },
    });
  });

  const stored = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
  });
  assert.ok(stored.createdAt.getTime() >= stored.approvedAt.getTime());
  assert.ok(stored.createdAt.getTime() - stored.approvedAt.getTime() < 1_000);
  assert.equal(
    stored.approvalExpiresAt.getTime() - stored.approvedAt.getTime(),
    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
  );
});

test("the shared audit writer's monotonic +1ms timestamp remains stage-admissible", async () => {
  const binding = await expected();
  const head = await seedFutureAuditHead(30_000);

  const created = await createPromptRefinerReservationStage({
    session,
    request: request(),
    expected: binding,
  });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: created.stage.authorizationAuditLogId },
  });
  assert.equal(audit.previousHash, head.entryHash);
  assert.equal(audit.createdAt.getTime(), head.createdAt.getTime() + 1);
  assert.equal(
    created.stage.approvalExpiresAt.getTime() - created.stage.approvedAt.getTime(),
    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
  );
  assert.equal(
    (await reservePromptRefinerExecution({ requestId: "monotonic_audit_stage_reserve" })).ok,
    true
  );
});

test("the stage trigger rejects a shared-writer audit more than one minute in the future", async () => {
  const binding = await expected();
  const head = await seedFutureAuditHead(120_000);

  await assert.rejects(
    createPromptRefinerReservationStage({
      session,
      request: request(),
      expected: binding,
    }),
    /authorization audit binding is invalid/i
  );
  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
  assert.equal(await prisma.adminAuditLog.count(), 1);
  assert.equal(
    await prisma.adminAuditLog.count({ where: { entryHash: head.entryHash } }),
    1
  );
});

test("the actual writer creates a verifiable stage when the database session default is non-UTC", async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  databaseUrl.searchParams.set("options", "-c timezone=Australia/Brisbane");
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "tests/fixtures/prompt-refiner-non-utc-writer-child.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.toString(),
        DIRECT_DATABASE_URL: databaseUrl.toString(),
      },
    }
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /"timeZone":"Australia\/Brisbane"/);

  const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
  });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: stage.authorizationAuditLogId },
  });
  assert.ok(audit.createdAt.getTime() >= stage.approvedAt.getTime());
  assert.ok(audit.createdAt.getTime() - stage.approvedAt.getTime() < 1_000);
  const reserved = await reservePromptRefinerExecution({
    requestId: "non_utc_writer_reserve",
  });
  assert.equal(reserved.ok, true);
  if (reserved.ok) assert.equal(reserved.value.created, true);
});

test("direct service callers cannot override the fixed audit reason", async () => {
  const result = await createPromptRefinerReservationStage({
    session,
    request: request(),
    expected: await expected(),
    reason: "caller_controlled_reason",
  } as Parameters<typeof createPromptRefinerReservationStage>[0] & { reason: string });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: result.stage.authorizationAuditLogId },
  });
  assert.equal(
    (audit.metadata as { reason?: unknown } | null)?.reason,
    "bounded_staging_shadow_cost_approval"
  );
});

test("stage authorization accepts its audit after an integrity-key rotation", async () => {
  await create();
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "rotated-prompt-refiner-audit-key";
  process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS = AUDIT_FIXTURE_KEY;

  const reserved = await reservePromptRefinerExecution({
    requestId: "previous_audit_key_reserve",
  });
  assert.equal(reserved.ok, true);
});

test("a structurally exact but forged audit and stage cannot reserve or consume", async () => {
  const facts = await loadPromptRefinerStageAdmissionFacts();
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  assert.ok(clock);
  const approvedAt = clock.now;
  const approvalExpiresAt = new Date(
    approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
  );
  const previous = await prisma.adminAuditLog.findFirst({
    where: { entryHash: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { entryHash: true },
  });
  const auditId = randomUUID();
  await prisma.adminAuditLog.create({
    data: {
      id: auditId,
      actorUserId: "mposition",
      actorEmail: "owner@example.com",
      action: "prompt_refiner.shadow_stage.activated",
      targetType: "PromptRefinerReservationStage",
      targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
      summary: "Approved the bounded Prompt Refiner staging shadow stage.",
      metadata: {
        admissionVersion: facts.admissionVersion,
        proposalDigest: facts.proposalDigest,
        evidenceBundleDigest: facts.evidenceBundleDigest,
        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
        executionManifestDigest: facts.executionManifestDigest,
        environment: facts.runtimeEnvironment,
        deploymentId: facts.runtimeDeploymentId,
        commitSha: facts.runtimeCommitSha,
        perRequestCostMicroUsd: 24_916,
        maxReservations: 100,
        costCeilingMicroUsd: 2_491_600,
        approvalTtlMinutes: 60,
        approvedAt: approvedAt.toISOString(),
        approvalExpiresAt: approvalExpiresAt.toISOString(),
        reason: PROMPT_REFINER_STAGE_REASON,
      },
      previousHash: previous?.entryHash ?? null,
      entryHash: "f".repeat(64),
      createdAt: approvedAt,
    },
  });
  await prisma.promptRefinerReservationStage.create({
    data: {
      id: PROMPT_REFINER_RESERVATION_STAGE_ID,
      contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
      status: "approved",
      perRequestCostMicroUsd: BigInt(24_916),
      maxReservations: 100,
      costCeilingMicroUsd: BigInt(2_491_600),
      reservationCount: 0,
      allocatedCostMicroUsd: BigInt(0),
      admissionVersion: facts.admissionVersion,
      proposalVersion: facts.proposalVersion,
      proposalDigest: facts.proposalDigest,
      evidenceBundleDigest: facts.evidenceBundleDigest,
      evidenceManifestSha256: facts.evidenceManifestSha256,
      historicalSourceRef: facts.historicalSourceRef,
      historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
      corpusDigest: facts.corpusDigest,
      runtimeCommitSha: facts.runtimeCommitSha,
      runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
      runtimeSourceManifest: facts.runtimeSourceManifest,
      runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
      runtimeEnvironment: facts.runtimeEnvironment,
      runtimeDeploymentId: facts.runtimeDeploymentId,
      executionManifest: facts.executionManifest,
      executionManifestDigest: facts.executionManifestDigest,
      approvedBy: "mposition",
      approvedAt,
      approvalExpiresAt,
      authorizationAuditLogId: auditId,
      createdAt: approvedAt,
    },
  });

  assert.deepEqual(
    await reservePromptRefinerExecution({ requestId: "forged_stage_reserve" }),
    { ok: false, reason: "stage_authorization_invalid" }
  );
  await assert.rejects(
    create(),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
      )
  );

  const reservationId = randomUUID();
  await prisma.promptRefinerReservation.create({
    data: {
      id: reservationId,
      stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
      requestId: "forged_stage_consume",
      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
      status: "reserved",
      reservedCostMicroUsd: BigInt(24_916),
      createdAt: approvedAt,
      expiresAt: new Date(approvedAt.getTime() + PROMPT_REFINER_RESERVATION_TTL_MS),
    },
  });
  assert.deepEqual(
    await consumePromptRefinerReservation({
      reservationId,
      requestId: "forged_stage_consume",
      stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    }),
    { ok: false, reason: "stage_authorization_invalid" }
  );
});

test("concurrent exact writes leave one immutable stage and one success audit", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => create()));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.filter((result) => result.replayed).length, 7);
  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
  assert.equal(
    await prisma.adminAuditLog.count({
      where: { action: "prompt_refiner.shadow_stage.activated" },
    }),
    1
  );
});

test("deployment mismatch is a 409 conflict and cannot add an audit", async () => {
  await create();
  process.env.RAILWAY_DEPLOYMENT_ID = "different-deployment";
  await assert.rejects(
    create(),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
      )
  );
  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: "prompt_refiner.shadow_stage.activated" } }),
    1
  );
});

test("an exact replay by another actor is a 409 conflict and cannot add an audit", async () => {
  await create();
  const otherActor = {
    user: {
      id: "different-owner",
      email: "different-owner@example.com",
      authenticatedAt: new Date().toISOString(),
    },
  } as Session;
  await assert.rejects(
    createPromptRefinerReservationStage({
      session: otherActor,
      request: request(),
      expected: await expected(),
    }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
      )
  );
  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
  assert.equal(
    await prisma.adminAuditLog.count({
      where: { action: "prompt_refiner.shadow_stage.activated" },
    }),
    1
  );
});

test("a preview from the same commit and source but another deployment is stale before transaction writes", async () => {
  const staleExpected = await expected();
  process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test-next";
  await assert.rejects(
    createPromptRefinerReservationStage({
      session,
      request: request(),
      expected: staleExpected,
    }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PROMPT_REFINER_STAGE_PREVIEW_STALE"
      )
  );
  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
  assert.equal(
    await prisma.adminAuditLog.count({
      where: { action: "prompt_refiner.shadow_stage.activated" },
    }),
    0
  );
});

test("audit failure rolls back the stage and direct SQL cannot alter or delete provenance", async () => {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "prompt_refiner_test_reject_activation_audit"()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW."action" = 'prompt_refiner.shadow_stage.activated' THEN
        RAISE EXCEPTION 'forced activation audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER "prompt_refiner_test_reject_activation_audit_trigger"
    BEFORE INSERT ON "AdminAuditLog"
    FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_activation_audit"();
  `);
  try {
    await assert.rejects(create(), /forced activation audit failure/i);
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_activation_audit_trigger" ON "AdminAuditLog";
      DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_activation_audit"();
    `);
  }
  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "prompt_refiner.shadow_stage.activated" } }), 0);

  const created = await create();
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "PromptRefinerReservationStage"
      SET "runtimeDeploymentId" = 'forged'
      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
    `,
    /immutable/i
  );
  await assert.rejects(
    prisma.$executeRaw`
      DELETE FROM "PromptRefinerReservationStage"
      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
    `,
    /cannot be deleted/i
  );
  assert.equal(created.stage.id, PROMPT_REFINER_RESERVATION_STAGE_ID);
});

test("stage insert failure rolls the already-written activation audit back", async () => {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "prompt_refiner_test_reject_stage_insert"()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'forced stage insert failure';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER "prompt_refiner_test_reject_stage_insert_trigger"
    BEFORE INSERT ON "PromptRefinerReservationStage"
    FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_stage_insert"();
  `);
  try {
    await assert.rejects(create(), /forced stage insert failure/i);
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_stage_insert_trigger" ON "PromptRefinerReservationStage";
      DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_stage_insert"();
    `);
  }
  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
  assert.equal(
    await prisma.adminAuditLog.count({
      where: { action: "prompt_refiner.shadow_stage.activated" },
    }),
    0
  );
});

test("expired stage refuses reserve and consume at both service and DB boundaries", async () => {
  await create();
  const reserved = await reservePromptRefinerExecution({ requestId: "before_stage_expiry" });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;

  await prisma.$executeRawUnsafe('ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"');
  try {
    await prisma.$executeRaw`
      UPDATE "PromptRefinerReservationStage"
      SET "approvedAt" = "approvedAt" - INTERVAL '2 hours',
          "approvalExpiresAt" = "approvalExpiresAt" - INTERVAL '2 hours'
      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
    `;
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"');
  }

  assert.deepEqual(
    await reservePromptRefinerExecution({ requestId: "after_stage_expiry" }),
    { ok: false, reason: "stage_authorization_invalid" }
  );
  const binding = {
    reservationId: reserved.value.reservation.reservationId,
    requestId: reserved.value.reservation.requestId,
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  };
  assert.deepEqual(await consumePromptRefinerReservation(binding), {
    ok: false,
    reason: "stage_authorization_invalid",
  });
  await assert.rejects(
    prisma.$executeRaw`
      UPDATE "PromptRefinerReservation"
      SET "status" = 'consumed'
      WHERE "id" = ${binding.reservationId}
    `,
    /approval expired before consume/i
  );
});
