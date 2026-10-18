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
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET,
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
  commitAmuxIdeaSessionSubmission as commitPinnedSessionSubmission,
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
import { readAmuxSessionReferencePin } from
  "@/lib/amux/ideaSessionReferencePinRead";
import { readAmuxSessionCheckoutReferenceInTx } from
  "@/lib/amux/ideaSessionCheckoutReferenceRead";
import { commitAmuxSessionBudgetClaim, readAmuxSessionBudgetClaimReceipt,
  AmuxSessionBudgetClaimError } from
  "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { GET as readMaxClaimRoute, POST as postMaxClaimRoute } from
  "@/app/api/internal/amux/v19/analysis-budget/claim/route";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { signAmuxV19MaxClaimAttestation } from
  "@/lib/amux/ideaSessionMaxLauncherAttestation.mjs";
import { readAmuxSessionAnalysisStopState,
  AmuxSessionAnalysisStopReadError } from
  "@/lib/amux/ideaSessionAnalysisStopRead";
import { AmuxSessionBudgetSettlementError,
  commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
import { AmuxSessionBudgetResolutionError,
  commitAmuxSessionBudgetUnknownResolution,
  readAmuxSessionBudgetResolution } from
  "@/lib/amux/ideaSessionAnalysisBudgetResolutionService";
import { commitAmuxIdeaAnalysisPriceApproval } from
  "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { readAmuxIdeaAnalysisFailureStreak } from
  "@/lib/amux/ideaAnalysisFailureStreakService";
import { commitAnalysisBudgetSetting, readAnalysisBudgetSnapshot } from
  "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { encodeAmuxSessionAnalysisQueueCursor,
  parseAmuxSessionAnalysisQueueCursor } from
  "@/lib/amux/ideaSessionAnalysisQueueCursorCore";
import { buildAmuxSessionAnalysisQueueWhere } from
  "@/lib/amux/ideaSessionAnalysisQueueWhereCore";
import { prisma } from "@/lib/prisma";

const commitAmuxIdeaSessionSubmission = (
  tx: Parameters<typeof commitPinnedSessionSubmission>[0],
  input: Omit<Parameters<typeof commitPinnedSessionSubmission>[1], "pinnedCommitShas">,
) => commitPinnedSessionSubmission(tx, { ...input,
  pinnedCommitShas: Array(input.inspected.counts.repositoryCount +
    input.inspected.counts.pullRequestCount).fill("a".repeat(40)) });

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
  const progress = (await readAmuxIdeaProgressForOwner(ownerId)).find((item) =>
    item.ideaId === committedIdeaId);
  assert.deepEqual(progress?.referencePins, [{ referenceOrdinal: 0,
    pinnedCommitSha: "a".repeat(40) }]);
  assert.deepEqual(progress?.checkoutEvidence, []);
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
  assert.deepEqual(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: 0,
  }), { referenceCount: 1, pinnedCommitSha: "a".repeat(40) });
  assert.equal(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: 1,
  }), null);
  assert.equal(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: -1,
  }), null);
  assert.equal(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: randomUUID(),
    referenceOrdinal: 0,
  }), null);
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

test("session claims share the monthly ledger, settle known usage and hold unknown usage", async () => {
  const priceVersionId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, approval: {
      id: priceVersionId, provider: "openai", modelId,
      mode: "subscription_cli", expectedPreviousVersion: 0,
      inputTokensCap: 1_000, outputTokensCap: 2_000,
      inputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      evidenceDigest: randomBytes(32).toString("hex"),
      ownerConfirmedWorstTier: true,
      verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  }));
  const runner = { tokenCapsEnforceable: true, billableToolsDisabled: true };
  const firstClaimId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: firstClaimId, requestId: randomUUID(),
      reservationId: committedReservationId, invocationOrdinal: 0, priceVersionId,
      runner: { ...runner, tokenCapsEnforceable: false },
    })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "budget_hold");
  const first = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: firstClaimId, requestId: randomUUID(),
      reservationId: committedReservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    }));
  assert.equal(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: 0,
  }), null, "a claimed reservation is no longer a preflight read target");
  assert.deepEqual(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: 0, claimId: first.claimId,
  }), { referenceCount: 1, pinnedCommitSha: "a".repeat(40) });
  const checkoutIdentity = { reservationId: committedReservationId,
    ideaId: committedIdeaId, referenceOrdinal: 0, claimId: first.claimId };
  const checkoutPin = { referenceCount: 1, pinnedCommitSha: "a".repeat(40) };
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxSessionCheckoutReferenceInTx(tx, checkoutIdentity,
      checkoutPin, keysFor(committedIdeaId))), {
    referenceCount: 1, kind: "repository", repository: "mposition/Tomverse",
    pullRequestNumber: null, pinnedCommitSha: "a".repeat(40),
  });
  assert.equal(await prisma.$transaction((tx) =>
    readAmuxSessionCheckoutReferenceInTx(tx,
      { ...checkoutIdentity, claimId: randomUUID() },
      checkoutPin, keysFor(committedIdeaId))), null);
  assert.equal(await prisma.$transaction((tx) =>
    readAmuxSessionCheckoutReferenceInTx(tx, checkoutIdentity,
      { ...checkoutPin, pinnedCommitSha: "b".repeat(40) },
      keysFor(committedIdeaId))), null);
  assert.equal(await readAmuxSessionReferencePin({
    reservationId: committedReservationId, ideaId: committedIdeaId,
    referenceOrdinal: 0, claimId: randomUUID(),
  }), null, "a different claim cannot reveal an in-flight pin");
  assert.equal(first.reservedMicroUsd, "5000");
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxSessionBudgetClaimReceipt(tx, {
      requestId: first.requestId, reservationId: first.reservationId,
      invocationOrdinal: 0,
    })), { status: "committed", claimId: first.claimId,
    claimStatus: "in_flight" });
  const ownerReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, { claimId: first.claimId, session }));
  assert.equal(ownerReadback.status, "in_flight");
  assert.equal(ownerReadback.reservedMicroUsd, first.reservedMicroUsd);
  const windowBefore = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace: "agent/amux-intake",
      monthStart: new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z") } },
  });
  assert.equal(windowBefore.reservedMicroUsd, BigInt(5000));
  assert.equal((await listAmuxSessionAnalysisCandidates(null)).candidates.some(
    (candidate) => candidate.reservationId === committedReservationId), false);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: committedReservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "not_ready");

  const secondIdeaId = randomUUID();
  const secondInspected = inspect(secondIdeaId);
  const second = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: secondInspected, expectedAuthority: authority,
      ideaId: secondIdeaId, keys: keysFor(secondIdeaId),
    });
    return commitAmuxSessionAnalysisReservation(tx, {
      ideaId: secondIdeaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
  });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: second.reservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "not_ready");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetOutcome(tx, {
      claimId: first.claimId, outcome: "outcome_unknown",
      inputTokens: null, outputTokens: null,
      exactAgentClaim: { requestId: first.requestId,
        reservationId: first.reservationId, ideaId: secondIdeaId,
        invocationOrdinal: 0 },
    })), (error: unknown) => error instanceof AmuxSessionBudgetSettlementError &&
      error.code === "not_settleable");
  const settled = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetOutcome(tx, {
      claimId: first.claimId, outcome: "verified_success",
      inputTokens: 10, outputTokens: 20,
      exactAgentClaim: { requestId: first.requestId,
        reservationId: first.reservationId, ideaId: committedIdeaId,
        invocationOrdinal: 0 },
    }));
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.settledMicroUsd, "50");
  const settledReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: first.claimId, session }));
  assert.equal(settledReadback.status, "succeeded");
  assert.equal(settledReadback.settledMicroUsd, "50");
  assert.match(settledReadback.readbackDigest, /^[a-f0-9]{64}$/);
  const secondClaim = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: second.reservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    }));
  const unknown = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetOutcome(tx, {
      claimId: secondClaim.claimId, outcome: "outcome_unknown",
      inputTokens: null, outputTokens: null,
      exactAgentClaim: { requestId: secondClaim.requestId,
        reservationId: secondClaim.reservationId, ideaId: secondIdeaId,
        invocationOrdinal: 0 },
    }));
  assert.equal(unknown.status, "outcome_unknown");
  const secondReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: secondClaim.claimId, session }));
  assert.equal(secondReadback.status, "outcome_unknown");
  assert.match(secondReadback.readbackDigest, /^[a-f0-9]{64}$/);
  const windowAfter = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace: "agent/amux-intake",
      monthStart: windowBefore.monthStart } },
  });
  assert.equal(windowAfter.reservedMicroUsd, BigInt(5000));
  assert.equal(windowAfter.spentMicroUsd, BigInt(50));
  const unresolved = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
    where: { id: secondClaim.claimId }, select: { closedAt: true,
      settledMicroUsd: true },
  });
  assert.equal(unresolved.closedAt, null);
  assert.equal(unresolved.settledMicroUsd, null);
  const thirdIdeaId = randomUUID();
  const thirdInspected = inspect(thirdIdeaId);
  const third = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: thirdInspected, expectedAuthority: authority,
      ideaId: thirdIdeaId, keys: keysFor(thirdIdeaId),
    });
    return commitAmuxSessionAnalysisReservation(tx, {
      ideaId: thirdIdeaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
  });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: third.reservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "budget_hold" && error.reason === "usage_unknown");
  const released = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetUnknownResolution(tx, {
      claimId: secondClaim.claimId, session, request,
      verification: "proven_not_started",
      localEvidenceDigest: sha256("synthetic no-start read-back"),
      readbackDigest: secondReadback.readbackDigest,
      ownerConfirmed: true,
    }));
  assert.equal(released.status, "released");
  assert.equal(released.settledMicroUsd, "0");
  assert.equal((await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: secondClaim.claimId, session }))).status, "released");
  const thirdClaim = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: third.reservationId, invocationOrdinal: 0,
      priceVersionId, runner,
    }));
  await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: thirdClaim.claimId, outcome: "outcome_unknown",
    inputTokens: null, outputTokens: null,
  }));
  const thirdReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: thirdClaim.claimId, session }));
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetUnknownResolution(tx, {
      claimId: thirdClaim.claimId, session, request,
      verification: "not_proven",
      localEvidenceDigest: sha256("synthetic inconclusive local read-back"),
      readbackDigest: "0".repeat(64), ownerConfirmed: true,
    })), (error: unknown) => error instanceof AmuxSessionBudgetResolutionError &&
      error.code === "not_resolvable");
  const consumed = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetUnknownResolution(tx, {
      claimId: thirdClaim.claimId, session, request,
      verification: "not_proven",
      localEvidenceDigest: sha256("synthetic inconclusive local read-back"),
      readbackDigest: thirdReadback.readbackDigest,
      ownerConfirmed: true,
    }));
  assert.equal(consumed.status, "owner_consumed");
  assert.equal(consumed.settledMicroUsd, "5000");
  const consumedReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: thirdClaim.claimId, session }));
  assert.equal(consumedReadback.status, "owner_consumed");
  assert.equal(consumedReadback.settledMicroUsd, "5000");
  assert.match(consumedReadback.readbackDigest, /^[a-f0-9]{64}$/);
  const finalWindow = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace: "agent/amux-intake",
      monthStart: windowBefore.monthStart } },
  });
  assert.equal(finalWindow.reservedMicroUsd, BigInt(0));
  assert.equal(finalWindow.spentMicroUsd, BigInt(5050));
});

test("database refuses a second CLI claim while the idea remains submitted", async () => {
  const prior = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findFirstOrThrow({
    where: { reservationId: committedReservationId, invocationOrdinal: 0 },
  });
  const nextId = randomUUID();
  const requestId = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    const auditId = await writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: nextId,
      summary: "Synthetic next-chunk claim with no accepted result.",
      metadata: { reservationId: committedReservationId,
        invocationOrdinal: 1, requestId,
        priceVersionId: prior.priceVersionId,
        reservedMicroUsd: prior.reservedMicroUsd.toString() },
    });
    await tx.amuxIdeaAnalysisBudgetWindow.update({
      where: { namespace_monthStart: {
        namespace: prior.namespace, monthStart: prior.monthStart,
      } },
      data: { reservedMicroUsd: { increment: prior.reservedMicroUsd } },
    });
    await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
      id: nextId, requestId, reservationId: committedReservationId,
      invocationOrdinal: 1, namespace: prior.namespace,
      monthStart: prior.monthStart, priceVersionId: prior.priceVersionId,
      provider: prior.provider, modelId: prior.modelId,
      inputTokensCap: prior.inputTokensCap,
      outputTokensCap: prior.outputTokensCap,
      inputMicroUsdPerMillion: prior.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: prior.outputMicroUsdPerMillion,
      reservedMicroUsd: prior.reservedMicroUsd,
      status: "in_flight", claimAuditLogId: auditId,
    } });
  }), (error: unknown) => sqlState(error) === "23514");
  assert.equal(await prisma.amuxIdeaSessionAnalysisBudgetClaim.count({
    where: { reservationId: committedReservationId },
  }), 1);
});

test("session claim insert binds its audit to the exact UTC budget month", async () => {
  const previous = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findFirstOrThrow({
    where: { reservationId: committedReservationId, invocationOrdinal: 0 },
  });
  const tryClaim = (auditMonth: Date) => prisma.$transaction(async (tx) => {
    const ideaId = randomUUID();
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(ideaId), expectedAuthority: authority,
      ideaId, keys: keysFor(ideaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
    const claimId = randomUUID();
    const requestId = randomUUID();
    const auditId = await writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claimId,
      summary: "Synthetic claim to test exact budget-month audit binding.",
      metadata: { reservationId: reservation.reservationId,
        invocationOrdinal: 0, requestId,
        namespace: previous.namespace,
        monthStart: auditMonth.toISOString(),
        priceVersionId: previous.priceVersionId,
        reservedMicroUsd: previous.reservedMicroUsd.toString() },
    });
    await tx.amuxIdeaAnalysisBudgetWindow.update({
      where: { namespace_monthStart: {
        namespace: previous.namespace, monthStart: previous.monthStart,
      } },
      data: { reservedMicroUsd: { increment: previous.reservedMicroUsd } },
    });
    await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
      id: claimId, requestId, reservationId: reservation.reservationId,
      invocationOrdinal: 0, namespace: previous.namespace,
      monthStart: previous.monthStart, priceVersionId: previous.priceVersionId,
      provider: previous.provider, modelId: previous.modelId,
      inputTokensCap: previous.inputTokensCap,
      outputTokensCap: previous.outputTokensCap,
      inputMicroUsdPerMillion: previous.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: previous.outputMicroUsdPerMillion,
      reservedMicroUsd: previous.reservedMicroUsd,
      status: "in_flight", claimAuditLogId: auditId,
    } });
    throw new Error("valid month control rolled back");
  });
  await assert.rejects(tryClaim(previous.monthStart),
    (error: unknown) => error instanceof Error &&
      error.message === "valid month control rolled back");
  const nextMonth = new Date(Date.UTC(previous.monthStart.getUTCFullYear(),
    previous.monthStart.getUTCMonth() + 1, 1));
  await assert.rejects(tryClaim(nextMonth),
    (error: unknown) => sqlState(error) === "23514");
});

test("known session outcome cannot settle at zero even with lifecycle trigger bypassed", async () => {
  const known = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findFirstOrThrow({
    where: { reservationId: committedReservationId, status: "succeeded" },
  });
  const trySettlement = (status: "succeeded" | "failed",
    settledMicroUsd: bigint) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" DISABLE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_guard"');
      await tx.amuxIdeaSessionAnalysisBudgetClaim.update({
        where: { id: known.id },
        data: { status, settledMicroUsd },
      });
      throw new Error("positive settlement control rolled back");
    });
  for (const status of ["succeeded", "failed"] as const) {
    await assert.rejects(trySettlement(status, BigInt(1)),
      (error: unknown) => error instanceof Error &&
        error.message === "positive settlement control rolled back");
    await assert.rejects(trySettlement(status, BigInt(0)),
      (error: unknown) => sqlState(error) === "23514");
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

test("session claim normalizes a non-UTC transaction before price admission", async () => {
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  const rollback = new Error("rollback non-UTC claim");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Australia/Brisbane'");
    const ideaId = randomUUID();
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(ideaId), expectedAuthority: authority,
      ideaId, keys: keysFor(ideaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
    const claim = await commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservation.reservationId,
      invocationOrdinal: 0, priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    });
    assert.equal(claim.reservationId, reservation.reservationId);
    throw rollback;
  }), (error: unknown) => error === rollback);
});

test("session stop poll follows the exact active claim and stops after settlement", async () => {
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  const rollback = new Error("rollback synthetic session stop poll");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const ideaId = randomUUID();
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(ideaId), expectedAuthority: authority,
      ideaId, keys: keysFor(ideaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
    const claim = await commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservation.reservationId,
      invocationOrdinal: 0, priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    });
    assert.deepEqual(await readAmuxSessionAnalysisStopState(tx,
      claim.claimId, reservation.reservationId, ideaId), {
      claimId: claim.claimId, reservationId: reservation.reservationId, stop: false,
    });
    await assert.rejects(readAmuxSessionAnalysisStopState(tx,
      claim.claimId, randomUUID(), ideaId),
    (error: unknown) => error instanceof AmuxSessionAnalysisStopReadError &&
      error.code === "not_found");
    await assert.rejects(readAmuxSessionAnalysisStopState(tx,
      claim.claimId, reservation.reservationId, randomUUID()),
    (error: unknown) => error instanceof AmuxSessionAnalysisStopReadError &&
      error.code === "not_found");
    await commitAmuxSessionBudgetOutcome(tx, {
      claimId: claim.claimId, outcome: "verified_success",
      inputTokens: 10, outputTokens: 1,
    });
    assert.equal((await readAmuxSessionAnalysisStopState(tx,
      claim.claimId, reservation.reservationId, ideaId)).stop, true);
    throw rollback;
  }), (error: unknown) => error === rollback);
});

test("a verified first chunk remains eligible for a second budgeted invocation", async () => {
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  const rollback = new Error("rollback synthetic next chunk");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const ideaId = randomUUID();
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(ideaId), expectedAuthority: authority,
      ideaId, keys: keysFor(ideaId),
    });
    const reservation = await commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
    const claimed = await commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservation.reservationId,
      invocationOrdinal: 0, priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    });
    await commitAmuxSessionBudgetOutcome(tx, {
      claimId: claimed.claimId, outcome: "verified_success",
      inputTokens: 10, outputTokens: 1,
    });
    await tx.amuxIdeaSubmission.update({ where: { id: ideaId },
      data: { state: "analyzing" } });
    const candidates = await tx.amuxIdeaSessionAnalysisReservation.findMany({
      where: buildAmuxSessionAnalysisQueueWhere(new Date(), null),
      select: { id: true },
    });
    assert.ok(candidates.some((row) => row.id === reservation.reservationId));
    throw rollback;
  }), (error: unknown) => error === rollback);
});

test("three session CLI failures stop the shared Agent-wide claim breaker", async () => {
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  const rollback = new Error("rollback synthetic failure streak");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const reservations: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const ideaId = randomUUID();
      const submission = await commitAmuxIdeaSessionSubmission(tx, {
        inspected: inspect(ideaId), expectedAuthority: authority,
        ideaId, keys: keysFor(ideaId),
      });
      const reservation = await commitAmuxSessionAnalysisReservation(tx, {
        ideaId, requestId: submission.requestId,
        submissionAuditId: submission.auditId, authority,
      });
      reservations.push(reservation.reservationId);
    }
    for (const reservationId of reservations.slice(0, 3)) {
      const claimed = await commitAmuxSessionBudgetClaim(tx, {
        claimId: randomUUID(), requestId: randomUUID(),
        reservationId, invocationOrdinal: 0, priceVersionId: price.id,
        runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
      });
      const outcome = await commitAmuxSessionBudgetOutcome(tx, {
        claimId: claimed.claimId, outcome: "invocation_failed",
        inputTokens: 10, outputTokens: 1,
      });
      assert.equal(outcome.status, "failed");
    }
    assert.equal(await readAmuxIdeaAnalysisFailureStreak(tx), "stopped");
    await assert.rejects(commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservations[3]!, invocationOrdinal: 0,
      priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    }), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "not_ready");
    throw rollback;
  }), (error: unknown) => error === rollback);
});

test("a malformed recent session settlement fails the shared breaker closed", async () => {
  const rollback = new Error("rollback malformed session audit");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET,
      targetId: randomUUID(),
      summary: "Synthetic malformed session settlement audit.",
      metadata: { namespace: "agent/amux-intake", status: "unexpected" },
    });
    assert.equal(await readAmuxIdeaAnalysisFailureStreak(tx),
      "integrity_unavailable");
    throw rollback;
  }), (error: unknown) => error === rollback);
});

test("database rejects a second claim that borrows another claim's reserved balance", async () => {
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  await assert.rejects(prisma.$transaction(async (tx) => {
    const reservations: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const ideaId = randomUUID();
      const submission = await commitAmuxIdeaSessionSubmission(tx, {
        inspected: inspect(ideaId), expectedAuthority: authority,
        ideaId, keys: keysFor(ideaId),
      });
      const reservation = await commitAmuxSessionAnalysisReservation(tx, {
        ideaId, requestId: submission.requestId,
        submissionAuditId: submission.auditId, authority,
      });
      reservations.push(reservation.reservationId);
    }
    const first = await commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservations[0]!, invocationOrdinal: 0,
      priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    });
    const existing = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: first.claimId },
    });
    const secondId = randomUUID();
    const requestId = randomUUID();
    const auditId = await writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: secondId,
      summary: "Synthetic claim without a matching ledger increment.",
      metadata: { reservationId: reservations[1],
        invocationOrdinal: 0, requestId, priceVersionId: price.id,
        reservedMicroUsd: existing.reservedMicroUsd.toString() },
    });
    await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
      id: secondId, requestId, reservationId: reservations[1]!,
      invocationOrdinal: 0, namespace: existing.namespace,
      monthStart: existing.monthStart, priceVersionId: price.id,
      provider: existing.provider, modelId: existing.modelId,
      inputTokensCap: existing.inputTokensCap,
      outputTokensCap: existing.outputTokensCap,
      inputMicroUsdPerMillion: existing.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: existing.outputMicroUsdPerMillion,
      reservedMicroUsd: existing.reservedMicroUsd,
      status: "in_flight", claimAuditLogId: auditId,
    } });
  }), (error: unknown) => sqlState(error) === "23514");
});

test("session claim waits in the queue when the owner monthly limit is insufficient", async () => {
  await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: 0,
    monthlyUsd: "0.01", ownerConfirmed: true,
  }));
  const ideaId = randomUUID();
  const inspected = inspect(ideaId);
  const reservation = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected, expectedAuthority: authority, ideaId, keys: keysFor(ideaId),
    });
    return commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority,
    });
  });
  const price = await prisma.amuxIdeaAnalysisPriceVersion.findFirstOrThrow({
    where: { modelId, mode: "subscription_cli", status: "approved" },
    select: { id: true },
  });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservation.reservationId, invocationOrdinal: 0,
      priceVersionId: price.id,
      runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
      error.code === "budget_hold" && error.reason === "monthly_cap_exceeded");
  assert.equal(await prisma.amuxIdeaSessionAnalysisBudgetClaim.findFirst({
    where: { reservationId: reservation.reservationId },
  }), null);
  assert.equal((await listAmuxSessionAnalysisCandidates(null)).candidates.some(
    (candidate) => candidate.reservationId === reservation.reservationId), true);
});

test("a superseded operating scope removes stale reservations from dispatch hints", async () => {
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: authority.version,
    scope, ownerConfirmed: true,
  }));
  const queue = await listAmuxSessionAnalysisCandidates(null);
  assert.equal(queue.candidates.some((candidate) =>
    candidate.reservationId === committedReservationId), false);
});

test("Max shadow claim records measured overrun while the bounded ledger remains capped", async () => {
  const maxModelId = "synthetic-max-shadow-" + randomUUID();
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: randomUUID(),
    provider: "anthropic", modelId: maxModelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontier.ok) throw new Error("Synthetic Max model rejected: " + frontier.code);
  await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
  const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  assert.ok(current);
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: current.version,
    scope: { ...scope, model: { provider: "anthropic", modelId: maxModelId,
      reasoningEffort: "high" } }, ownerConfirmed: true,
  }));
  const maxAuthority = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  assert.ok(maxAuthority);
  const latestBudget = await prisma.amuxIdeaAnalysisBudgetSetting.findFirst({
    orderBy: { version: "desc" }, select: { version: true },
  });
  await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
    session, request, id: randomUUID(),
    expectedPreviousVersion: latestBudget?.version ?? 0,
    monthlyUsd: "1", ownerConfirmed: true,
  }));
  const ideaId = randomUUID();
  const inspected = inspect(ideaId);
  const reservation = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected, expectedAuthority: maxAuthority, ideaId, keys: keysFor(ideaId),
    });
    return commitAmuxSessionAnalysisReservation(tx, {
      ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority: maxAuthority,
    });
  });
  const priceVersionId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, approval: {
      id: priceVersionId, provider: "anthropic", modelId: maxModelId,
      mode: "subscription_cli", expectedPreviousVersion: 0,
      inputTokensCap: 1, outputTokensCap: 1,
      inputMicroUsdPerMillion: 1_000_000_000,
      outputMicroUsdPerMillion: 1_000_000_000,
      evidenceDigest: randomBytes(32).toString("hex"),
      ownerConfirmedWorstTier: true,
      verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  }));
  const apiPriceVersionId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, approval: {
      id: apiPriceVersionId, provider: "anthropic", modelId: maxModelId,
      mode: "api", expectedPreviousVersion: 0,
      inputTokensCap: 1, outputTokensCap: 1,
      inputMicroUsdPerMillion: 1_000_000_000,
      outputMicroUsdPerMillion: 1_000_000_000,
      evidenceDigest: randomBytes(32).toString("hex"),
      ownerConfirmedWorstTier: true,
      verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  }));
  const maxLauncherIdentity = { ideaId, modelId: maxModelId,
    reasoningEffort: "high",
    authEvidenceDigest: randomBytes(32).toString("hex") };
  await assert.rejects(prisma.$transaction((tx) => commitAmuxSessionBudgetClaim(tx, {
    claimId: randomUUID(), requestId: randomUUID(),
    reservationId: reservation.reservationId, invocationOrdinal: 0,
    priceVersionId,
    runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
      maxSubscriptionAuthenticated: true },
  })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
    error.code === "not_ready", "Max claim requires bound launcher identity");
  await assert.rejects(prisma.$transaction((tx) => commitAmuxSessionBudgetClaim(tx, {
    claimId: randomUUID(), requestId: randomUUID(),
    reservationId: reservation.reservationId, invocationOrdinal: 0,
    priceVersionId,
    maxLauncherIdentity: { ...maxLauncherIdentity, ideaId: randomUUID() },
    runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
      maxSubscriptionAuthenticated: true },
  })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
    error.code === "not_ready", "Max claim rejects a different idea");
  await assert.rejects(prisma.$transaction((tx) => commitAmuxSessionBudgetClaim(tx, {
    claimId: randomUUID(), requestId: randomUUID(),
    reservationId: reservation.reservationId, invocationOrdinal: 0,
    priceVersionId: apiPriceVersionId,
    maxLauncherIdentity,
    runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
      maxSubscriptionAuthenticated: true },
  })), (error: unknown) => error instanceof AmuxSessionBudgetClaimError &&
    error.code === "budget_hold" && error.reason === "price_unverified");
  const launcherSecret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
  const envNames = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE",
    "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
    "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ"] as const;
  const oldEnv = Object.fromEntries(envNames.map((name) =>
    [name, process.env[name]]));
  const claimRequestId = randomUUID();
  const claimId = randomUUID();
  const signedIdentity = { claimId, requestId: claimRequestId,
    reservationId: reservation.reservationId, ideaId,
    invocationOrdinal: 0, priceVersionId, modelId: maxModelId,
    reasoningEffort: "high" };
  const authVerifiedAt = new Date().toISOString();
  const authProof = signAmuxV19MaxClaimAttestation(launcherSecret,
    signedIdentity, authVerifiedAt);
  let claim!: { claimId: string; requestId: string; reservationId: string;
    reservedMicroUsd: string };
  try {
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = launcherSecret;
    process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE = "enabled";
    process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ = "enabled";
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "enabled";
    const headers = { authorization: `Bearer ${launcherSecret}`,
      "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID };
    const response = await postMaxClaimRoute(new Request(
      "https://test.invalid/api/internal/amux/v19/analysis-budget/claim", {
        method: "POST", headers: { ...headers,
          "content-type": "application/json" },
        body: JSON.stringify({ ...signedIdentity, authVerifiedAt,
          authProof }),
      }));
    assert.equal(response.status, 200);
    claim = await response.json();
    const readback = await readMaxClaimRoute(new Request(
      `https://test.invalid/api/internal/amux/v19/analysis-budget/claim?requestId=${claimRequestId}&reservationId=${reservation.reservationId}&invocationOrdinal=0`,
      { headers }));
    assert.equal(readback.status, 200);
    assert.deepEqual(await readback.json(), { status: "committed", claimId,
      claimStatus: "in_flight" });
  } finally {
    for (const name of envNames) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }
  const before = await prisma.$transaction((tx) => readAnalysisBudgetSnapshot(tx));
  assert.equal(BigInt(before.spentMicroUsd) + BigInt(before.reservedMicroUsd),
    BigInt(before.limitMicroUsd));
  const outcome = await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: claim.claimId, outcome: "verified_success",
    inputTokens: 1001, outputTokens: 1,
    exactAgentClaim: { requestId: claim.requestId,
      reservationId: claim.reservationId, ideaId, invocationOrdinal: 0 },
  }));
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.settledMicroUsd, "1002000");
  const row = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
    where: { id: claim.claimId },
  });
  assert.equal(row.budgetMode, "max_shadow");
  assert.equal(row.settledMicroUsd, BigInt("1002000"));
  const after = await prisma.$transaction((tx) => readAnalysisBudgetSnapshot(tx));
  assert.equal(after.reservedMicroUsd, "0");
  assert.equal(after.remainingMicroUsd, "0");
  assert.equal(BigInt(after.shadowOverrunMicroUsd),
    BigInt("1002000") - BigInt(claim.reservedMicroUsd));
  assert.equal(BigInt(after.spentMicroUsd),
    BigInt(before.spentMicroUsd) + BigInt("1002000"));
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.update({
    where: { namespace_monthStart: { namespace: "agent/amux-intake",
      monthStart: new Date(after.monthStart) } },
    data: { shadowOverrunMicroUsd: { increment: BigInt(1) } },
  }), (error: unknown) => sqlState(error) === "23514",
  "shadow overrun cannot be changed without the exact measured audit");

  const raisedBudget = await prisma.amuxIdeaAnalysisBudgetSetting.findFirstOrThrow({
    orderBy: { version: "desc" }, select: { version: true },
  });
  await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
    session, request, id: randomUUID(),
    expectedPreviousVersion: raisedBudget.version,
    monthlyUsd: "10", ownerConfirmed: true,
  }));
  const unknownIdeaId = randomUUID();
  const unknownReservation = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, {
      inspected: inspect(unknownIdeaId), expectedAuthority: maxAuthority,
      ideaId: unknownIdeaId, keys: keysFor(unknownIdeaId),
    });
    return commitAmuxSessionAnalysisReservation(tx, {
      ideaId: unknownIdeaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority: maxAuthority,
    });
  });
  const unknownClaim = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, {
      claimId: randomUUID(), requestId: randomUUID(),
      reservationId: unknownReservation.reservationId, invocationOrdinal: 0,
      priceVersionId,
      maxLauncherIdentity: { ...maxLauncherIdentity, ideaId: unknownIdeaId },
      runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
        maxSubscriptionAuthenticated: true },
    }));
  const unknown = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetOutcome(tx, { claimId: unknownClaim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null }));
  assert.equal(unknown.status, "outcome_unknown");
  const unknownReadback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, {
      claimId: unknownClaim.claimId, session }));
  assert.equal(unknownReadback.status, "outcome_unknown");
  const ownerResolution = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetUnknownResolution(tx, {
      claimId: unknownClaim.claimId, session, request,
      verification: "proven_not_started",
      localEvidenceDigest: sha256("synthetic Max CLI not-started proof"),
      readbackDigest: unknownReadback.readbackDigest, ownerConfirmed: true,
    }));
  assert.equal(ownerResolution.status, "released");
  assert.equal(ownerResolution.settledMicroUsd, "0");
});
