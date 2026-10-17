import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_SESSION_IDEA_SUBMITTED_ACTION,
  AMUX_SESSION_IDEA_SUBMITTED_SCOPE,
  AMUX_SESSION_IDEA_SUBMITTED_TARGET,
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
  auditRowActorKind,
} from "@/lib/adminAuditSystemActors";
import { openAmuxContent, sealAmuxContent } from "@/lib/amux/ideaCrypto";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import {
  commitAmuxOperatingScope,
  readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority,
} from "@/lib/amux/ideaOperatingScopeStore";
import { commitAmuxDueRawIdeaPurge } from "@/lib/amux/ideaRawRetentionService";
import { readAmuxIdeaProgressForOwner } from "@/lib/amux/ideaProgressRead";
import { commitAmuxIdeaSessionCancellation,
  readAmuxIdeaSessionCancellationReceipt,
  AmuxIdeaSessionCancellationError } from
  "@/lib/amux/ideaSessionCancellationService";
import {
  commitAmuxIdeaSessionSubmission,
  readAmuxIdeaSessionSubmissionRequest,
  AmuxIdeaSessionSubmissionError,
  type CommittedAmuxIdeaSessionSubmission,
} from "@/lib/amux/ideaSessionSubmissionService";
import {
  inspectAmuxIdeaSessionSubmission,
  type AmuxIdeaSessionSubmissionInspection,
} from "@/lib/amux/ideaSessionSubmissionCore";
import { prepareIdeaSubmissionStorage } from "@/lib/amux/ideaSubmissionService";
import { AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
  amuxSessionAnalysisReservationAuditMetadata } from
  "@/lib/amux/ideaSessionAnalysisReservationCore";
import {
  commitAmuxSessionAnalysisReservation,
  AmuxSessionAnalysisReservationError,
} from "@/lib/amux/ideaSessionAnalysisReservationStore";
import { listAmuxSessionAnalysisCandidates } from
  "@/lib/amux/ideaSessionAnalysisQueueService";
import { encodeAmuxSessionAnalysisQueueCursor,
  parseAmuxSessionAnalysisQueueCursor } from
  "@/lib/amux/ideaSessionAnalysisQueueCursorCore";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v19 session submission test requires a dedicated loopback test database");
}

const ownerId = "synthetic-session-owner-" + randomUUID();
const ownerEmail = "amux-session-owner@example.test";
process.env.ADMIN_USER_IDS = ownerId;
process.env.ADMIN_EMAILS = ownerEmail;
process.env.ADMIN_OWNER_EMAILS = ownerEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = {
  user: { id: ownerId, email: ownerEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/internal/amux/session-intake", {
  method: "POST",
});
const modelId = "synthetic-session-model-" + randomUUID();
const scope = {
  repositories: ["mposition/Tomverse", "mposition/tomverse-private-docs"],
  model: { provider: "openai", modelId, reasoningEffort: "high" },
};
const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const oversizedIdeaTail = "i".repeat(1024 * 1024 + 257);
const oversizedSessionDisplay =
  "AMUX v19 synthetic DB test " + "s".repeat(1024 * 1024 + 257);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1,
  masterKey,
  digestKeyId: "synthetic-session-digest",
  digestKey,
});
const inspect = (
  ideaId: string,
  repositories = ["mposition/Tomverse"],
  content?: { idea: string; sessionDisplay: string },
): Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }> => {
  const result = inspectAmuxIdeaSessionSubmission({
    version: 1,
    requestId: ideaId,
    input: { version: 1, idea: content?.idea ?? "Synthetic session idea " + ideaId,
      repositories, pullRequests: [] },
    source: { toolName: "Codex", modelProvider: "OpenAI",
      sessionDisplay: content?.sessionDisplay ?? "AMUX v19 synthetic DB test" },
  });
  if (!result.ok) throw new Error("Synthetic session input rejected: " + result.code);
  return result;
};
const auditMetadata = (
  inspected: Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }>,
  authority: AmuxOperatingScopeAuthority,
  rawDigest: string,
  rawDigestKeyId: string,
  sourceDigest: string,
  sourceDigestKeyId: string,
) => ({
  policyVersion: 19,
  requestId: inspected.requestId,
  rawDigest,
  rawDigestKeyId,
  sourceProvenanceDigest: sourceDigest,
  sourceProvenanceDigestKeyId: sourceDigestKeyId,
  operatingScopeSettingId: authority.settingId,
  operatingScopeVersion: authority.version,
  modelProvider: authority.scope.model.provider,
  modelId: authority.scope.model.modelId,
  reasoningEffort: authority.scope.model.reasoningEffort,
  ideaBytes: inspected.counts.ideaBytes,
  repositoryCount: inspected.counts.repositoryCount,
  pullRequestCount: inspected.counts.pullRequestCount,
});
const sqlState = (error: unknown): string | null => {
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: {
      cause?: { code?: unknown; originalCode?: unknown };
    } };
  };
  const cause = candidate?.meta?.driverAdapterError?.cause;
  for (const code of [cause?.originalCode, cause?.code, candidate?.code]) {
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
};

let authority: AmuxOperatingScopeAuthority;
let committedIdeaId: string;
let committedRequestId: string;
let committedAuditId: string;
let committedReservationId: string;
let committedReservationAuditId: string;

before(async () => {
  assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), 0,
    "use the fresh DB runner before any persistent scope fixture");
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1,
    action: "approve",
    approvalId: randomUUID(),
    provider: "openai",
    modelId,
    allowedEfforts: ["high"],
    expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontier.ok) throw new Error("Synthetic Frontier input rejected: " + frontier.code);
  await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: 0,
    scope, ownerConfirmed: true,
  }));
  const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  if (!current) throw new Error("Synthetic operating scope was not stored");
  authority = current;
  committedIdeaId = randomUUID();
  const inspected = inspect(committedIdeaId, undefined, {
    idea: "Synthetic session idea " + committedIdeaId + oversizedIdeaTail,
    sessionDisplay: oversizedSessionDisplay,
  });
  committedRequestId = inspected.requestId;
  const committed = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected, expectedAuthority: authority, ideaId: committedIdeaId,
      keys: keysFor(committedIdeaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId: submission.ideaId,
      requestId: submission.requestId,
      submissionAuditId: submission.auditId,
      authority,
    });
    return { submission, reservation };
  });
  committedAuditId = committed.submission.auditId;
  committedReservationId = committed.reservation.reservationId;
  committedReservationAuditId = committed.reservation.reservationAuditId;
});

after(async () => {
  masterKey.fill(0);
  digestKey.fill(0);
  await prisma.$disconnect();
});

test("session submission encrypts idea and provenance under the scope owner with system audit", async () => {
  const [row, audit] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: committedIdeaId } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: committedAuditId } }),
  ]);
  assert.equal(row.submissionOrigin, "session");
  assert.equal(row.actorUserId, ownerId);
  assert.equal(row.sessionOperatingScopeSettingId, authority.settingId);
  assert.equal(row.submissionAuditLogId, audit.id);
  assert.equal(row.sourceProvenanceKeyId, row.rawKeyId);
  assert.equal(row.sourceProvenanceKeyVersion, row.rawKeyVersion);
  assert.notEqual(row.sourceProvenanceDigest, row.rawDigest);
  assert.ok((row.rawCiphertext?.byteLength ?? 0) > 1024 * 1024);
  assert.ok((row.sourceProvenanceCiphertext?.byteLength ?? 0) > 1024 * 1024);
  const keys = keysFor(committedIdeaId);
  const raw = openAmuxContent({
    ciphertext: Buffer.from(row.rawCiphertext ?? []),
    keyId: row.rawKeyId ?? "",
    keyVersion: row.rawKeyVersion ?? 0,
  }, "idea_raw", committedIdeaId, keys);
  const source = openAmuxContent({
    ciphertext: Buffer.from(row.sourceProvenanceCiphertext ?? []),
    keyId: row.sourceProvenanceKeyId ?? "",
    keyVersion: row.sourceProvenanceKeyVersion ?? 0,
  }, "idea_raw", committedIdeaId, keys);
  const openedIdea = JSON.parse(raw.toString("utf8"));
  const expectedIdea = "Synthetic session idea " + committedIdeaId + oversizedIdeaTail;
  assert.ok(Buffer.byteLength(openedIdea.idea, "utf8") > 1024 * 1024);
  assert.equal(sha256(openedIdea.idea), sha256(expectedIdea));
  const openedSource = JSON.parse(source.toString("utf8"));
  assert.equal(openedSource.toolName, "Codex");
  assert.equal(openedSource.modelProvider, "OpenAI");
  assert.ok(Buffer.byteLength(openedSource.sessionDisplay, "utf8") > 1024 * 1024);
  assert.equal(sha256(openedSource.sessionDisplay), sha256(oversizedSessionDisplay));
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.actorEmail, null);
  assert.equal(audit.ipAddress, null);
  assert.equal(audit.userAgent, null);
  assert.equal(auditRowActorKind(audit), "system");
  assert.equal(JSON.stringify(audit.metadata).includes("Codex"), false);
  assert.equal(JSON.stringify(audit.metadata).includes("synthetic DB test"), false);
  assert.deepEqual(await readAmuxIdeaSessionSubmissionRequest(committedRequestId), {
    requestId: committedRequestId,
    status: "committed",
    ideaId: committedIdeaId,
    reservationId: committedReservationId,
    hasExternalSources: true,
  });
});

test("session submission queues one content-free analysis reservation in the same transaction", async () => {
  const [reservation, audit] = await Promise.all([
    prisma.amuxIdeaSessionAnalysisReservation.findUniqueOrThrow({
      where: { id: committedReservationId },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({
      where: { id: committedReservationAuditId },
    }),
  ]);
  assert.deepEqual({
    ideaId: reservation.ideaId,
    requestId: reservation.requestId,
    actorUserId: reservation.actorUserId,
    operatingScopeSettingId: reservation.operatingScopeSettingId,
    status: reservation.status,
    modelProvider: reservation.modelProvider,
    modelId: reservation.modelId,
    reasoningEffort: reservation.reasoningEffort,
    reservationAuditLogId: reservation.reservationAuditLogId,
  }, {
    ideaId: committedIdeaId,
    requestId: committedRequestId,
    actorUserId: ownerId,
    operatingScopeSettingId: authority.settingId,
    status: "queued",
    modelProvider: "openai",
    modelId,
    reasoningEffort: "high",
    reservationAuditLogId: committedReservationAuditId,
  });
  assert.equal(auditRowActorKind(audit), "system");
  assert.equal(audit.action, AMUX_SESSION_ANALYSIS_RESERVED_ACTION);
  assert.equal(audit.targetType, AMUX_SESSION_ANALYSIS_RESERVED_TARGET);
  assert.equal(audit.targetId, committedReservationId);
  assert.equal(audit.summary, AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY);
  assert.deepEqual(audit.metadata, {
    policyVersion: 19,
    reservationId: committedReservationId,
    ideaId: committedIdeaId,
    requestId: committedRequestId,
    submissionAuditId: committedAuditId,
    operatingScopeSettingId: authority.settingId,
    dataOwnerUserId: ownerId,
    modelProvider: "openai",
    modelId,
    reasoningEffort: "high",
    systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
    actorScope: "session-analysis-reservation-v1",
  });
  assert.doesNotMatch(JSON.stringify(audit.metadata),
    /mposition\/Tomverse|Codex|sessionDisplay|reservedMicroUsd|ideaText/);
});

test("session analysis queue lists the live reservation and advances past its DB position", async () => {
  const [reservation, idea] = await Promise.all([
    prisma.amuxIdeaSessionAnalysisReservation.findUniqueOrThrow({
      where: { id: committedReservationId }, select: { createdAt: true },
    }),
    prisma.amuxIdeaSubmission.findUniqueOrThrow({
      where: { id: committedIdeaId }, select: { analysisDeadlineAt: true },
    }),
  ]);
  const first = await listAmuxSessionAnalysisCandidates(null);
  assert.deepEqual(first, {
    candidates: [{ reservationId: committedReservationId, ideaId: committedIdeaId,
      modelId, expiresAt: idea.analysisDeadlineAt.toISOString() }],
    hasMore: false, nextCursor: null,
  });
  const cursor = encodeAmuxSessionAnalysisQueueCursor({
    createdAt: reservation.createdAt, reservationId: committedReservationId,
  });
  const parsed = parseAmuxSessionAnalysisQueueCursor(cursor);
  assert.ok(parsed);
  const after = await listAmuxSessionAnalysisCandidates(parsed);
  assert.equal(after.candidates.some((candidate) =>
    candidate.reservationId === committedReservationId), false);

  const switches = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
    "TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ", "TOMVERSE_AMUX_SESSION_INTAKE",
    "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ"];
  const previous = new Map(switches.map((key) => [key, process.env[key]]));
  const secret = "synthetic-amux-session-queue-secret-0123456789";
  try {
    process.env[switches[0]] = secret;
    for (const key of switches.slice(1)) process.env[key] = "enabled";
    const { POST } = await import("@/app/api/internal/amux/v19/analysis-queue/route");
    const poll = (body: object) => POST(new Request(
      "https://tomverse.test/api/internal/amux/v19/analysis-queue", {
        method: "POST", headers: { authorization: `Bearer ${secret}`,
          "x-amux-agent-id": "amux-intake", "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    const response = await poll({});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), first);
    const next = await poll({ after: cursor });
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), after);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("queue guard rejects missing and null system audit identity", async () => {
  const rollbackFixtures = new Error("rollback null audit identity fixtures");
  const ideaIds = Array.from({ length: 5 }, () => randomUUID());
  await assert.rejects(prisma.$transaction(async (tx) => {
    const fixtures: Array<{
      submission: CommittedAmuxIdeaSessionSubmission;
      reservationId: string;
      reservationAuditLogId: string;
    }> = [];
    for (const ideaId of ideaIds) {
      const submission = await commitAmuxIdeaSessionSubmission(tx, {
        inspected: inspect(ideaId), expectedAuthority: authority,
        ideaId, keys: keysFor(ideaId),
      });
      const reservationId = randomUUID();
      const reservationAuditLogId = await writeSystemAuditLog({
        tx,
        systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
        action: AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
        targetType: AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
        targetId: reservationId,
        summary: AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
        metadata: amuxSessionAnalysisReservationAuditMetadata({
          reservationId,
          ideaId,
          requestId: submission.requestId,
          submissionAuditId: submission.auditId,
          operatingScopeSettingId: authority.settingId,
          dataOwnerUserId: ownerId,
          modelProvider: "openai",
          modelId,
          reasoningEffort: "high",
        }),
      });
      fixtures.push({ submission, reservationId, reservationAuditLogId });
    }
    const reservationData = (index: number) => {
      const fixture = fixtures[index];
      return {
        id: fixture.reservationId,
        ideaId: fixture.submission.ideaId,
        requestId: fixture.submission.requestId,
        actorUserId: ownerId,
        operatingScopeSettingId: authority.settingId,
        status: "queued" as const,
        modelProvider: "openai",
        modelId,
        reasoningEffort: "high",
        reservationAuditLogId: fixture.reservationAuditLogId,
      };
    };

    const control = await tx.amuxIdeaSessionAnalysisReservation.create({
      data: reservationData(4),
    });
    assert.equal(control.id, fixtures[4].reservationId);

    // Build otherwise-valid forged evidence behind the append-only boundary.
    // The outer transaction always rolls these fixtures back.
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_is_append_only"');
    try {
      await tx.$executeRaw`
        UPDATE "AdminAuditLog"
        SET "metadata" = "metadata" - 'systemActor'
        WHERE "id" = ${fixtures[0].submission.auditId}
      `;
      await tx.$executeRaw`
        UPDATE "AdminAuditLog"
        SET "metadata" = jsonb_set(
          "metadata", '{actorScope}', 'null'::jsonb, false
        )
        WHERE "id" = ${fixtures[1].submission.auditId}
      `;
      await tx.$executeRaw`
        UPDATE "AdminAuditLog"
        SET "metadata" = jsonb_set(
          "metadata", '{systemActor}', 'null'::jsonb, false
        )
        WHERE "id" = ${fixtures[2].reservationAuditLogId}
      `;
      await tx.$executeRaw`
        UPDATE "AdminAuditLog"
        SET "metadata" = jsonb_set(
          "metadata", '{actorScope}', 'null'::jsonb, false
        )
        WHERE "id" = ${fixtures[3].reservationAuditLogId}
      `;
    } finally {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_is_append_only"');
    }

    for (const [index, expectedMessage] of [
      [0, /session reservation submission audit mismatch/],
      [1, /session reservation submission audit mismatch/],
      [2, /session reservation audit mismatch/],
      [3, /session reservation audit mismatch/],
    ] as const) {
      await tx.$executeRawUnsafe(`SAVEPOINT null_audit_identity_${index}`);
      await assert.rejects(tx.amuxIdeaSessionAnalysisReservation.create({
        data: reservationData(index),
      }), (error: unknown) => {
        assert.equal(sqlState(error), "23514");
        assert.match(String(error), expectedMessage);
        return true;
      });
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT null_audit_identity_${index}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT null_audit_identity_${index}`);
    }
    throw rollbackFixtures;
  }), (error: unknown) => error === rollbackFixtures);
  assert.equal(await prisma.amuxIdeaSubmission.count({
    where: { id: { in: ideaIds } },
  }), 0);
});

test("database refuses late, mutable and forged queue reservations", async () => {
  await assert.rejects(prisma.amuxIdeaSessionAnalysisReservation.update({
    where: { id: committedReservationId }, data: { status: "queued" },
  }), /append only/);
  await assert.rejects(prisma.amuxIdeaSessionAnalysisReservation.delete({
    where: { id: committedReservationId },
  }), /append only/);
  await assert.rejects(prisma.$executeRawUnsafe(
    'TRUNCATE "AmuxIdeaSessionAnalysisReservation" CASCADE'), /append only/);

  const lateIdeaId = randomUUID();
  const late = inspect(lateIdeaId);
  const submission = await prisma.$transaction((tx) =>
    commitAmuxIdeaSessionSubmission(tx, {
      inspected: late, expectedAuthority: authority, ideaId: lateIdeaId,
      keys: keysFor(lateIdeaId),
    }));
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionAnalysisReservation(tx, {
      ideaId: submission.ideaId,
      requestId: submission.requestId,
      submissionAuditId: submission.auditId,
      authority,
    })), (error: unknown) =>
    error instanceof AmuxSessionAnalysisReservationError &&
      error.code === "submission_unavailable");
  assert.deepEqual(await readAmuxIdeaSessionSubmissionRequest(late.requestId), {
    requestId: late.requestId, status: "partial", ideaId: lateIdeaId,
  });

  const forgedIdeaId = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    const forgedSubmission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(forgedIdeaId), expectedAuthority: authority,
      ideaId: forgedIdeaId, keys: keysFor(forgedIdeaId),
    });
    const reservationId = randomUUID();
    const reservationAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
      action: AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
      targetType: AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
      targetId: reservationId,
      summary: AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
      metadata: amuxSessionAnalysisReservationAuditMetadata({
        reservationId,
        ideaId: forgedIdeaId,
        requestId: forgedSubmission.requestId,
        submissionAuditId: forgedSubmission.auditId,
        operatingScopeSettingId: authority.settingId,
        dataOwnerUserId: ownerId,
        modelProvider: "openai",
        modelId,
        reasoningEffort: "low",
      }),
    });
    await tx.amuxIdeaSessionAnalysisReservation.create({ data: {
      id: reservationId,
      ideaId: forgedIdeaId,
      requestId: forgedSubmission.requestId,
      actorUserId: ownerId,
      operatingScopeSettingId: authority.settingId,
      status: "queued",
      modelProvider: "openai",
      modelId,
      reasoningEffort: "high",
      reservationAuditLogId,
    } });
  }), /session reservation audit mismatch/);
  assert.equal(await prisma.amuxIdeaSubmission.count({
    where: { id: forgedIdeaId },
  }), 0);
});

test("reservation store refuses duplicate and superseded-scope attempts", async () => {
  const duplicateIdeaId = randomUUID();
  const duplicate = inspect(duplicateIdeaId);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: duplicate, expectedAuthority: authority, ideaId: duplicateIdeaId,
      keys: keysFor(duplicateIdeaId),
    });
    await commitAmuxSessionAnalysisReservation(tx, {
      ideaId: submission.ideaId,
      requestId: submission.requestId,
      submissionAuditId: submission.auditId,
      authority,
    });
    await commitAmuxSessionAnalysisReservation(tx, {
      ideaId: submission.ideaId,
      requestId: submission.requestId,
      submissionAuditId: submission.auditId,
      authority,
    });
  }), (error: unknown) =>
    error instanceof AmuxSessionAnalysisReservationError &&
      error.code === "already_reserved");
  assert.equal(await prisma.amuxIdeaSubmission.count({
    where: { id: duplicateIdeaId },
  }), 0);

  const supersededIdeaId = randomUUID();
  const superseded = inspect(supersededIdeaId);
  const scopeCount = await prisma.amuxIdeaOperatingScopeSetting.count();
  await assert.rejects(prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: superseded, expectedAuthority: authority, ideaId: supersededIdeaId,
      keys: keysFor(supersededIdeaId),
    });
    await commitAmuxOperatingScope(tx, {
      session, request, id: randomUUID(),
      expectedPreviousVersion: authority.version,
      scope, ownerConfirmed: true,
    });
    await commitAmuxSessionAnalysisReservation(tx, {
      ideaId: submission.ideaId,
      requestId: submission.requestId,
      submissionAuditId: submission.auditId,
      authority,
    });
  }), /session reservation operating scope mismatch/);
  assert.equal(await prisma.amuxIdeaSubmission.count({
    where: { id: supersededIdeaId },
  }), 0);
  assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), scopeCount);
});

test("request collision and references outside the saved scope are read-only refusals", async () => {
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(committedRequestId),
      expectedAuthority: authority,
      ideaId: randomUUID(),
      keys: keysFor(randomUUID()),
    })), (error: unknown) =>
    error instanceof AmuxIdeaSessionSubmissionError &&
    error.code === "request_already_seen");
  const outsideId = randomUUID();
  const auditCount = await prisma.adminAuditLog.count();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(outsideId, ["someone/else"]),
      expectedAuthority: authority,
      ideaId: outsideId,
      keys: keysFor(outsideId),
    })), (error: unknown) =>
    error instanceof AmuxIdeaSessionSubmissionError &&
    error.code === "outside_scope");
  assert.equal(await prisma.amuxIdeaSubmission.count({ where: { id: outsideId } }), 0);
  assert.equal(await prisma.adminAuditLog.count(), auditCount);
});

test("database refuses fake-human, wrong-owner and extra-metadata evidence", async () => {
  const rollbackForgedEvidence = new Error("rollback forged evidence fixtures");
  await assert.rejects(prisma.$transaction(async (tx) => {
    for (const actorKind of ["human", "wrong_owner", "extra_metadata"] as const) {
      const ideaId = randomUUID();
      const inspected = inspect(ideaId);
      const keys = keysFor(ideaId);
      const submittedAt = new Date();
      const prepared = prepareIdeaSubmissionStorage({ inspected, ideaId, keys, submittedAt });
      const source = sealAmuxContent(Buffer.from(JSON.stringify(inspected.source), "utf8"),
        "idea_raw", ideaId, keys);
      const metadata = { ...auditMetadata(inspected, authority,
        prepared.sealed.digest, prepared.sealed.digestKeyId,
        source.digest, source.digestKeyId),
        ...(actorKind === "extra_metadata"
          ? { sessionDisplay: "must never enter canonical audit metadata" }
          : {}),
      };
      const auditId = actorKind === "human"
        ? await writeAdminAuditLog({
          tx, session, request, action: AMUX_SESSION_IDEA_SUBMITTED_ACTION,
          targetType: AMUX_SESSION_IDEA_SUBMITTED_TARGET, targetId: ideaId,
          summary: "Stored one encrypted AMUX session idea under the current owner-approved operating scope.",
          metadata,
        })
        : await writeSystemAuditLog({
          tx, systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
          action: AMUX_SESSION_IDEA_SUBMITTED_ACTION,
          targetType: AMUX_SESSION_IDEA_SUBMITTED_TARGET, targetId: ideaId,
          summary: "Stored one encrypted AMUX session idea under the current owner-approved operating scope.",
          metadata,
        });
      const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: auditId } });
      assert.equal(audit.summary,
        "Stored one encrypted AMUX session idea under the current owner-approved operating scope.");
      if (actorKind === "human") {
        assert.equal(auditRowActorKind(audit), "human");
        assert.equal(audit.actorUserId, ownerId);
        assert.deepEqual(audit.metadata, metadata);
      } else {
        assert.equal(auditRowActorKind(audit), "system");
        assert.equal(audit.actorUserId, null);
        assert.deepEqual(audit.metadata, {
          ...metadata,
          systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
          actorScope: AMUX_SESSION_IDEA_SUBMITTED_SCOPE,
        });
      }
      const sameTransaction = await tx.$queryRaw<Array<{ same: boolean }>>`
        SELECT xmin = pg_current_xact_id()::xid AS same
        FROM "AdminAuditLog" WHERE "id" = ${auditId}
      `;
      assert.deepEqual(sameTransaction, [{ same: true }]);
      await tx.$executeRawUnsafe("SAVEPOINT forged_session");
      await assert.rejects(tx.amuxIdeaSubmission.create({ data: {
        ...prepared.data,
        actorUserId: actorKind === "wrong_owner" ? "not-the-scope-owner" : ownerId,
        submissionOrigin: "session",
        sessionOperatingScopeSettingId: authority.settingId,
        submissionAuditLogId: auditId,
        sourceProvenanceCiphertext: new Uint8Array(source.ciphertext),
        sourceProvenanceKeyId: source.keyId,
        sourceProvenanceKeyVersion: source.keyVersion,
        sourceProvenanceDigest: source.digest,
        sourceProvenanceDigestKeyId: source.digestKeyId,
      } }), /session submission evidence mismatch/);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT forged_session");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT forged_session");
    }
    throw rollbackForgedEvidence;
  }), (error: unknown) => error === rollbackForgedEvidence);
});

test("owner cancellation removes a queued session idea and makes raw purge due", async () => {
  const ideaId = randomUUID();
  const inspected = inspect(ideaId);
  const created = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected, expectedAuthority: authority, ideaId, keys: keysFor(ideaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: inspected.requestId,
      submissionAuditId: submission.auditId, authority,
    });
    return reservation;
  });
  assert.ok((await listAmuxSessionAnalysisCandidates(null)).candidates.some(
    (candidate) => candidate.reservationId === created.reservationId));
  const beforeCancel = (await readAmuxIdeaProgressForOwner(ownerId)).find(
    (row) => row.ideaId === ideaId);
  assert.equal(beforeCancel?.stage, "analysis");
  assert.equal(beforeCancel?.waitingFor, null);
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaSessionCancellationReceipt(tx, session, ideaId)), {
      state: "queued", ideaId, retryWrite: false,
    });
  const cancellation = await prisma.$transaction((tx) =>
    commitAmuxIdeaSessionCancellation(tx, { session, request, ideaId,
      ownerConfirmed: true }));
  const [idea, reservation, audit] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxIdeaSessionAnalysisReservation.findUniqueOrThrow({ where: { ideaId } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: cancellation.auditId } }),
  ]);
  assert.equal(idea.state, "cancelled");
  assert.equal(idea.cancelledAt?.toISOString(), cancellation.cancelledAt);
  assert.equal(idea.rawPurgeAfter?.toISOString(), cancellation.cancelledAt);
  assert.equal(reservation.status, "queued", "append-only queue evidence is retained");
  assert.equal(auditRowActorKind(audit), "human");
  assert.equal(audit.actorUserId, ownerId);
  assert.equal(audit.action, "amux.idea.session_cancelled_before_analysis");
  assert.equal(JSON.stringify(audit.metadata).includes("Synthetic session idea"), false);
  assert.equal((await listAmuxSessionAnalysisCandidates(null)).candidates.some(
    (candidate) => candidate.reservationId === created.reservationId), false);
  assert.equal((await readAmuxIdeaProgressForOwner(ownerId)).find(
    (row) => row.ideaId === ideaId)?.stage, "cancelled");
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaSessionCancellationReceipt(tx, session, ideaId)), {
      state: "cancelled", ideaId, cancelledAt: cancellation.cancelledAt,
      auditId: cancellation.auditId, retryWrite: false,
    });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaSessionCancellation(tx, { session, request, ideaId,
      ownerConfirmed: true })), (error: unknown) =>
    error instanceof AmuxIdeaSessionCancellationError &&
    error.code === "not_cancellable");
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueRawIdeaPurge(tx, ideaId)), "purged");
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaSessionCancellationReceipt(tx, session, ideaId)), {
      state: "cancelled", ideaId, cancelledAt: cancellation.cancelledAt,
      auditId: cancellation.auditId, retryWrite: false,
    });
});

test("audited identity and encrypted bodies are immutable except for one complete raw purge", async () => {
  for (const data of [
    { rawDigest: "f".repeat(64) },
    { sourceProvenanceDigest: "e".repeat(64) },
    { sourceProvenanceCiphertext: Buffer.from("replacement") },
    { submissionOrigin: "owner" },
  ]) {
    await assert.rejects(prisma.amuxIdeaSubmission.update({
      where: { id: committedIdeaId }, data,
    }), /immutable|only during raw purge|session_shape_check/);
  }
  const row = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: committedIdeaId },
  });
  const completedAt = new Date(Math.min(Date.now(), row.analysisDeadlineAt.getTime() - 1));
  await prisma.amuxIdeaSubmission.update({ where: { id: committedIdeaId },
    data: { state: "completed", analysisCompletedAt: completedAt,
      rawPurgeAfter: completedAt } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueRawIdeaPurge(tx, committedIdeaId)), "purged");
  const purged = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: committedIdeaId },
  });
  assert.equal(purged.rawCiphertext, null);
  assert.equal(purged.rawKeyId, null);
  assert.equal(purged.sourceProvenanceCiphertext, null);
  assert.equal(purged.sourceProvenanceKeyId, null);
  assert.ok(purged.sourceProvenanceDigest);
  assert.equal((await listAmuxSessionAnalysisCandidates(null)).candidates.some(
    (candidate) => candidate.reservationId === committedReservationId), false);
  assert.deepEqual(await readAmuxIdeaSessionSubmissionRequest(committedRequestId), {
    requestId: committedRequestId,
    status: "committed",
    ideaId: committedIdeaId,
    reservationId: committedReservationId,
    hasExternalSources: true,
  });
  await assert.rejects(prisma.amuxIdeaSubmission.update({
    where: { id: committedIdeaId },
    data: { sourceProvenanceCiphertext: Buffer.from("restored"),
      sourceProvenanceKeyId: keysFor(committedIdeaId).masterKeyId,
      sourceProvenanceKeyVersion: 1 },
  }), /cannot be restored|session_shape_check/);
});
