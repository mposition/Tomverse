import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog,
  writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR, AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { analysisBudgetMicroUsdToUsd } from "@/lib/amux/ideaAnalysisBudgetSettingCore";
import { commitAnalysisBudgetSetting,
  readAnalysisBudgetSnapshot } from "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { commitAmuxIdeaAnalysisPriceApproval } from "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import { claimAmuxV19MaxShadowBudgetOnce } from "@/lib/amux/ideaLocalMaxShadowClaimOnce.mjs";
import { commitAmuxOperatingScope, readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from "@/lib/amux/ideaOperatingScopeStore";
import { commitAmuxSessionBudgetClaim } from "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { commitAmuxSessionBudgetUnknownResolution,
  readAmuxSessionBudgetResolution } from "@/lib/amux/ideaSessionAnalysisBudgetResolutionService";
import { AmuxSessionBudgetSettlementError, commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
import { AMUX_V19_SESSION_ANALYSIS_STOP_ACTION } from "@/lib/amux/ideaSessionLateResult";
import { commitAmuxSessionAnalysisReservation } from
  "@/lib/amux/ideaSessionAnalysisReservationStore";
import { signAmuxV19MaxClaimAttestation } from
  "@/lib/amux/ideaSessionMaxLauncherAttestation.mjs";
import { commitAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionService";
import { inspectAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionCore";
import { GET as getMaxClaimRoute, POST as postMaxClaimRoute } from
  "@/app/api/internal/amux/v19/analysis-budget/claim/route";
import { prisma } from "@/lib/prisma";

// AMUX intake v21 (owner decision 2026-10-20): a subscription (max_shadow)
// claim closed without proof that the CLI never started spends no money, so
// it closes at zero. Operator, 2026-11-16: a subscription claim reserves
// nothing, runs beside any other claim, and the system closes its unknown
// outcome at zero in the same transaction; a late result still settles it. A
// bounded claim's closure by the owner is unchanged.

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v19 shadow headroom test requires a dedicated loopback test database");
}

const ownerId = "synthetic-shadow-owner-" + randomUUID();
const ownerEmail = "amux-shadow-owner@example.test";
process.env.ADMIN_USER_IDS = ownerId;
process.env.ADMIN_EMAILS = ownerEmail;
process.env.ADMIN_OWNER_EMAILS = ownerEmail;
// The same key as the other v19 suites in the shared amux lane: the Frontier
// catalog read verifies every approval row's audit, including theirs.
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = {
  user: { id: ownerId, email: ownerEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/admin/amux/shadow-headroom", {
  method: "POST",
});
const origin = "https://synthetic-amux.example.test/";
const launcherSecret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const repositories = ["mposition/Tomverse"];
const modelId = "synthetic-claude-" + randomUUID();
const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1, masterKey, digestKeyId: "synthetic-shadow-digest", digestKey,
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sqlState = (error: unknown): string | null => {
  const candidate = error as { code?: unknown; meta?: { driverAdapterError?: {
    cause?: { code?: unknown; originalCode?: unknown } } } };
  const cause = candidate?.meta?.driverAdapterError?.cause;
  for (const code of [cause?.originalCode, cause?.code, candidate?.code]) {
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
};
const refusedWith = (pattern: RegExp) => (error: unknown) =>
  sqlState(error) === "23514" && pattern.test(String(error));
class Rollback extends Error {}
async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await assert.rejects(prisma.$transaction(async (tx) => {
    await fn(tx);
    throw new Rollback("discard");
  }, { maxWait: 5_000, timeout: 20_000 }), (error: unknown) => error instanceof Rollback);
}

const ENV = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ"] as const;
const oldEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

let priceVersionId = "";
let authority!: AmuxOperatingScopeAuthority;
let priorScope: AmuxOperatingScopeAuthority | null = null;
let restoreLimitMicroUsd: string | null = null;

async function queueIdea() {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1, requestId: ideaId,
    input: { version: 1, idea: "Synthetic shadow idea " + ideaId, repositories, pullRequests: [] },
    source: { toolName: "Claude", modelProvider: "Anthropic", sessionDisplay: "AMUX shadow DB test" } });
  if (!inspected.ok) throw new Error("Synthetic session input rejected: " + inspected.code);
  const reservation = await prisma.$transaction(async (tx) => {
    const submission = await commitAmuxIdeaSessionSubmission(tx, { inspected,
      expectedAuthority: authority, ideaId, keys: keysFor(ideaId),
      pinnedCommitShas: ["a".repeat(40)] });
    return commitAmuxSessionAnalysisReservation(tx, { ideaId, requestId: submission.requestId,
      submissionAuditId: submission.auditId, authority });
  });
  return { ideaId, reservationId: reservation.reservationId };
}

const shadowRunner = { tokenCapsEnforceable: false, billableToolsDisabled: true,
  maxSubscriptionAuthenticated: true };
const boundedRunner = { tokenCapsEnforceable: true, billableToolsDisabled: true };

function claimInput(queued: { ideaId: string; reservationId: string }, shadow: boolean) {
  return { claimId: randomUUID(), requestId: randomUUID(),
    reservationId: queued.reservationId, invocationOrdinal: 0, priceVersionId,
    ...(shadow ? { maxLauncherIdentity: { ideaId: queued.ideaId, provider: "anthropic",
      modelId, reasoningEffort: "high", authEvidenceDigest: randomBytes(32).toString("hex") },
    runner: shadowRunner } : { runner: boundedRunner }) };
}

/** An owner closure written by hand, so a wrong settlement or audit reaches
 * the database guards that the resolution service would never let through. */
async function closeByHand(tx: Prisma.TransactionClient, claimId: string,
  settledMicroUsd: bigint, metadata: Record<string, unknown>) {
  await takeAuditChainLock(tx);
  const auditId = await writeAdminAuditLog({ tx, session, request,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claimId,
    summary: "Synthetic hand-written owner closure.",
    metadata: { status: "owner_consumed", verification: "not_proven",
      settledMicroUsd: settledMicroUsd.toString(), ...metadata } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  await tx.amuxIdeaSessionAnalysisBudgetClaim.update({ where: { id: claimId },
    data: { status: "owner_consumed", settledMicroUsd, resolutionAuditLogId: auditId,
      closedAt: clock[0]!.now } });
}

const windowNow = () => prisma.$transaction((tx) => readAnalysisBudgetSnapshot(tx));

/** The fixed Ubuntu launcher's own claim code against the real claim route.
 * Only its sign-in preflight is replaced by a correctly signed identity. */
async function runnerClaim(queued: { ideaId: string; reservationId: string }) {
  const identity = { claimId: randomUUID(), requestId: randomUUID(),
    reservationId: queued.reservationId, ideaId: queued.ideaId, invocationOrdinal: 0,
    priceVersionId, provider: "anthropic", modelId, reasoningEffort: "high" };
  const calls = { posts: 0, reads: 0 };
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (target: string | URL | Request, options?: RequestInit) => {
      const routed = new Request(String(target), { method: options?.method,
        headers: options?.headers, body: options?.body });
      if (options?.method === "POST") {
        calls.posts++;
        return postMaxClaimRoute(routed);
      }
      calls.reads++;
      return getMaxClaimRoute(routed);
    },
  }, async () => {
    const authVerifiedAt = new Date().toISOString();
    return { kind: "ready", identity, authVerifiedAt,
      authProof: signAmuxV19MaxClaimAttestation(launcherSecret, identity, authVerifiedAt),
      authProfile: "claude-max-oauth" };
  });
  return { result, identity, ...calls };
}

before(async () => {
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = launcherSecret;
  process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "enabled";
  priorScope = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: randomUUID(), provider: "anthropic",
    modelId, allowedEfforts: ["high"], expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontier.ok) throw new Error("Synthetic Frontier input rejected: " + frontier.code);
  await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
  priceVersionId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, requireCurrentFrontierModel: true, approval: {
      id: priceVersionId, provider: "anthropic", modelId, mode: "subscription_cli",
      expectedPreviousVersion: 0, inputTokensCap: 1_000, outputTokensCap: 2_000,
      inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000,
      evidenceDigest: randomBytes(32).toString("hex"), ownerConfirmedWorstTier: true,
      verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    } }));
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: priorScope?.version ?? 0,
    scope: { repositories, model: { provider: "anthropic", modelId, reasoningEffort: "high" } },
    ownerConfirmed: true }));
  const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  assert.ok(current);
  authority = current;
  // Earlier suites in the shared lane may leave this month's window full. Give
  // it USD 10 of headroom if needed; after() puts the previous ceiling back.
  const snapshot = await windowNow();
  if (BigInt(snapshot.remainingMicroUsd) < BigInt(1_000_000)) {
    const raised = BigInt(snapshot.spentMicroUsd) + BigInt(snapshot.reservedMicroUsd) +
      BigInt(10_000_000);
    await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
      session, request, id: randomUUID(), expectedPreviousVersion: snapshot.version,
      monthlyUsd: analysisBudgetMicroUsdToUsd(
        ((raised + BigInt(9_999)) / BigInt(10_000) * BigInt(10_000)).toString()),
      ownerConfirmed: true }));
    restoreLimitMicroUsd = snapshot.limitMicroUsd;
  }
});

after(async () => {
  try {
    if (restoreLimitMicroUsd) {
      // The previous ceiling, or the lowest one the writer accepts if a
      // measured shadow overrun had already put that month above it.
      const snapshot = await windowNow();
      const used = BigInt(snapshot.spentMicroUsd) + BigInt(snapshot.reservedMicroUsd);
      const floor = (used + BigInt(9_999)) / BigInt(10_000) * BigInt(10_000);
      const previous = BigInt(restoreLimitMicroUsd);
      await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
        session, request, id: randomUUID(), expectedPreviousVersion: snapshot.version,
        monthlyUsd: analysisBudgetMicroUsdToUsd((previous > floor ? previous : floor).toString()),
        ownerConfirmed: true }));
    }
    if (priorScope) {
      const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
      await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
        session, request, id: randomUUID(), expectedPreviousVersion: current?.version ?? 0,
        scope: priorScope!.scope, ownerConfirmed: true }));
    }
  } finally {
    for (const name of ENV) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
    masterKey.fill(0);
    digestKey.fill(0);
    await prisma.$disconnect();
  }
});

/** An outcome_unknown hold written by hand, in the system's own audit form,
 * so a subscription claim can be closed by hand: the settlement service now
 * closes such a hold in the same transaction (operator, 2026-11-16). */
async function holdUnknownByHand(tx: Prisma.TransactionClient, claimId: string) {
  await takeAuditChainLock(tx);
  const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
    where: { id: claimId } });
  const auditId = await writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claimId,
    summary: "Synthetic unknown hold.",
    metadata: { reservationId: row.reservationId, namespace: row.namespace,
      monthStart: row.monthStart.toISOString(), status: "outcome_unknown",
      inputTokens: null, outputTokens: null, settledMicroUsd: null,
      reservedMicroUsd: row.reservedMicroUsd.toString(), budgetMode: row.budgetMode } });
  await tx.amuxIdeaSessionAnalysisBudgetClaim.update({ where: { id: claimId },
    data: { status: "outcome_unknown", resolutionAuditLogId: auditId } });
}

/** A system-written resolution audit for a hand-made transition. */
async function systemResolution(tx: Prisma.TransactionClient, claimId: string,
  metadata: Prisma.InputJsonObject) {
  await takeAuditChainLock(tx);
  return writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
    targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claimId,
    summary: "Synthetic system resolution.", metadata });
}

test("subscription claims reserve nothing, run side by side and an unknown one closes at zero", async () => {
  const before = await windowNow();
  const first = await queueIdea();
  const claim = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, claimInput(first, true)));
  assert.equal(claim.reservedMicroUsd, "0", "a subscription claim reserves nothing");
  // While the first is in flight, the runner's next claim is admitted through
  // the real route: one analysis per worker, no system-wide single slot.
  const second = await queueIdea();
  const next = await runnerClaim(second);
  assert.deepEqual(next.result, { kind: "claimed", claimId: next.identity.claimId,
    reservationId: second.reservationId, requestId: next.identity.requestId,
    reservedMicroUsd: "0", recovered: false, retryWrite: false });
  assert.equal(next.reads, 0);

  const closed = await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: claim.claimId, outcome: "outcome_unknown", inputTokens: null,
    outputTokens: null, requiredBudgetMode: "max_shadow" }));
  assert.equal(closed.status, "owner_consumed");
  assert.equal(closed.settledMicroUsd, "0");
  const row = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
    where: { id: claim.claimId } });
  assert.equal(row.status, "owner_consumed");
  assert.equal(row.settledMicroUsd, BigInt(0));
  assert.equal(row.reservedMicroUsd, BigInt(0));
  assert.ok(row.closedAt);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: closed.auditId } });
  assert.equal(audit.actorUserId, null, "the system closes it, not a person");
  assert.equal(audit.summary,
    "System closed one unknown subscription CLI claim at zero; shadow usage unknown, headroom not counted.");
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.systemActor, "amux-v4-intake");
  assert.equal(metadata.closedBy, "system");
  assert.equal(metadata.status, "owner_consumed");
  assert.equal(metadata.verification, "not_proven");
  assert.equal(metadata.settledMicroUsd, "0");
  assert.equal(metadata.budgetMode, "max_shadow");
  assert.equal(metadata.shadowUsage, "unknown");
  assert.equal(metadata.headroomCounted, false);
  const unknownAudit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: metadata.previousResolutionAuditLogId as string } });
  assert.equal((unknownAudit.metadata as Record<string, unknown>).status, "outcome_unknown");
  // The owner's read-back accepts the system closure; the owner list is empty
  // of it, and the owner has nothing left to resolve.
  const readback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, { claimId: claim.claimId, session }));
  assert.equal(readback.status, "owner_consumed");
  assert.equal(readback.settledMicroUsd, "0");
  assert.equal(await prisma.amuxIdeaSessionAnalysisBudgetClaim.count({ where: {
    budgetMode: "max_shadow", status: "outcome_unknown" } }), 0);

  // Close the second the same way so the shared lane keeps no open claim.
  assert.equal((await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: next.identity.claimId, outcome: "outcome_unknown", inputTokens: null,
    outputTokens: null, requiredBudgetMode: "max_shadow" }))).settledMicroUsd, "0");
  const final = await windowNow();
  assert.equal(final.spentMicroUsd, before.spentMicroUsd, "nothing counted as usage");
  assert.equal(final.reservedMicroUsd, before.reservedMicroUsd);
  assert.equal(final.shadowOverrunMicroUsd, before.shadowOverrunMicroUsd);
});

test("a late subscription result settles the claim the system closed, unless the owner stopped it", async () => {
  const queued = await queueIdea();
  await rolledBack(async (tx) => {
    const before = await readAnalysisBudgetSnapshot(tx);
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
    const closed = await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
    assert.equal(closed.status, "owner_consumed");
    const late = await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "verified_success", inputTokens: 10, outputTokens: 2,
      requiredBudgetMode: "max_shadow" });
    assert.equal(late.status, "succeeded");
    // Opus 5.5 profile: 10 input at USD 8 / M and 2 output at USD 20 / M.
    assert.equal(late.settledMicroUsd, "120");
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.settledMicroUsd, BigInt(120));
    const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: late.auditId } });
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.lateAfterUnknown, true);
    assert.equal(metadata.previousResolutionAuditLogId, closed.auditId);
    const after = await readAnalysisBudgetSnapshot(tx);
    assert.equal(BigInt(after.shadowOverrunMicroUsd),
      BigInt(before.shadowOverrunMicroUsd) + BigInt(120));
    assert.equal(after.reservedMicroUsd, before.reservedMicroUsd);
    // Settled once; a second late answer finds nothing open.
    await assert.rejects(commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "verified_success", inputTokens: 1, outputTokens: 1 }),
    (error: unknown) => error instanceof AmuxSessionBudgetSettlementError &&
      error.code === "not_settleable");
  });
  await rolledBack(async (tx) => {
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
    await writeAdminAuditLog({ tx, session, request,
      action: AMUX_V19_SESSION_ANALYSIS_STOP_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: claim.claimId,
      summary: "Synthetic owner stop.", metadata: { ideaId: queued.ideaId } });
    await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
    await assert.rejects(commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "verified_success", inputTokens: 10, outputTokens: 2 }),
    (error: unknown) => error instanceof AmuxSessionBudgetSettlementError &&
      error.code === "not_settleable", "a stopped claim takes no late result");
  });
  // The database refuses a late transition that does not name the closure it
  // follows, even from the system.
  await assert.rejects(prisma.$transaction(async (tx) => {
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
    await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    const auditId = await systemResolution(tx, claim.claimId, {
      reservationId: row.reservationId, namespace: row.namespace,
      monthStart: row.monthStart.toISOString(), status: "succeeded",
      inputTokens: 1, outputTokens: 1, settledMicroUsd: "28",
      reservedMicroUsd: "0", budgetMode: "max_shadow", shadowOverrunMicroUsd: "28" });
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
    await tx.amuxIdeaSessionAnalysisBudgetClaim.update({ where: { id: claim.claimId },
      data: { status: "succeeded", settledMicroUsd: BigInt(28), inputTokens: 1,
        outputTokens: 1, resolutionAuditLogId: auditId, closedAt: clock[0]!.now } });
  }, { maxWait: 5_000, timeout: 20_000 }), refusedWith(/late session result refused/));
});

test("the database refuses a subscription closure that counts usage or does not say why", async () => {
  const queued = await queueIdea();
  const shadowAudit = { budgetMode: "max_shadow", shadowUsage: "unknown",
    headroomCounted: false };
  for (const [label, metadata] of [
    ["no shadowUsage", { budgetMode: "max_shadow", headroomCounted: false }],
    ["headroomCounted true", { ...shadowAudit, headroomCounted: true }],
    ["headroomCounted as text", { ...shadowAudit, headroomCounted: "false" }],
    ["no budgetMode", { shadowUsage: "unknown", headroomCounted: false }],
  ] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
      await holdUnknownByHand(tx, claim.claimId);
      await closeByHand(tx, claim.claimId, BigInt(0), metadata);
    }, { maxWait: 5_000, timeout: 20_000 }),
    refusedWith(/Max shadow unknown closure must return its headroom/), label);
  }
  // A system closure must say it is the system's "not proven" closure.
  for (const [label, extra] of [
    ["no closedBy", { verification: "not_proven" }],
    ["proven by the system", { verification: "proven_not_started", closedBy: "system" }],
  ] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
      await holdUnknownByHand(tx, claim.claimId);
      const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
        where: { id: claim.claimId } });
      const auditId = await systemResolution(tx, claim.claimId, { ...shadowAudit, ...extra,
        status: "owner_consumed", settledMicroUsd: "0", reservedMicroUsd: "0",
        reservationId: row.reservationId });
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
      await tx.amuxIdeaSessionAnalysisBudgetClaim.update({ where: { id: claim.claimId },
        data: { status: "owner_consumed", settledMicroUsd: BigInt(0),
          resolutionAuditLogId: auditId, closedAt: clock[0]!.now } });
    }, { maxWait: 5_000, timeout: 20_000 }),
    refusedWith(/session budget resolution audit mismatch/), label);
  }
  // The owner's hand closure with the zero settlement and its reasons passes.
  await rolledBack(async (tx) => {
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
    await holdUnknownByHand(tx, claim.claimId);
    await closeByHand(tx, claim.claimId, BigInt(0), shadowAudit);
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.status, "owner_consumed");
    assert.equal(row.settledMicroUsd, BigInt(0));
  });
  // A new subscription claim must reserve exactly nothing.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const input = claimInput(queued, true);
    const window = await readAnalysisBudgetSnapshot(tx);
    const auditId = await writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET, targetId: input.claimId,
      summary: "Synthetic headroom claim.",
      metadata: { reservationId: input.reservationId, invocationOrdinal: 0,
        requestId: input.requestId, namespace: "agent/amux-intake",
        monthStart: window.monthStart, modelId, reservedMicroUsd: "1",
        budgetMode: "max_shadow", ideaId: queued.ideaId, reasoningEffort: "high",
        maxAuthProfile: "claude-max-oauth", maxAuthEvidenceDigest: "a".repeat(64),
        amountMeaning: "cli_shadow_headroom_not_ceiling", modelCallStarted: false } });
    await tx.amuxIdeaAnalysisBudgetWindow.update({ where: { namespace_monthStart: {
      namespace: "agent/amux-intake", monthStart: new Date(window.monthStart) } },
    data: { reservedMicroUsd: { increment: BigInt(1) } } });
    await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
      id: input.claimId, requestId: input.requestId, reservationId: input.reservationId,
      namespace: "agent/amux-intake", invocationOrdinal: 0,
      monthStart: new Date(window.monthStart), priceVersionId: null,
      provider: "anthropic", modelId, inputTokensCap: 1_000_000,
      outputTokensCap: 128_000, inputMicroUsdPerMillion: 8_000_000,
      outputMicroUsdPerMillion: 20_000_000, reservedMicroUsd: BigInt(1),
      budgetMode: "max_shadow", status: "in_flight", claimAuditLogId: auditId } });
  }, { maxWait: 5_000, timeout: 20_000 }),
  refusedWith(/subscription claim must reserve nothing/));
});

test("a bounded closure still consumes its full reservation", async () => {
  const queued = await queueIdea();
  await rolledBack(async (tx) => {
    const before = await readAnalysisBudgetSnapshot(tx);
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, false));
    const held = await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
    assert.equal(held.status, "outcome_unknown", "a paid unknown waits for the owner");
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.budgetMode, "bounded");
    assert.equal(claim.reservedMicroUsd, "5000");
    const readback = await readAmuxSessionBudgetResolution(tx, {
      claimId: claim.claimId, session });
    const resolved = await commitAmuxSessionBudgetUnknownResolution(tx, {
      claimId: claim.claimId, session, request, verification: "not_proven",
      localEvidenceDigest: sha256("synthetic bounded evidence"),
      readbackDigest: readback.readbackDigest, ownerConfirmed: true });
    assert.equal(resolved.status, "owner_consumed");
    assert.equal(resolved.settledMicroUsd, "5000");
    const after = await readAnalysisBudgetSnapshot(tx);
    assert.equal(BigInt(after.spentMicroUsd), BigInt(before.spentMicroUsd) + BigInt(5000));
    assert.equal(after.reservedMicroUsd, before.reservedMicroUsd);
    const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: resolved.auditId } });
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.settledMicroUsd, "5000");
    for (const key of ["budgetMode", "shadowUsage", "headroomCounted"]) {
      assert.equal(Object.hasOwn(metadata, key), false, key);
    }
  });
  // The CHECK still refuses a bounded owner closure below its reservation,
  // even with the subscription reasons attached, and a bounded claim that
  // reserves nothing.
  await assert.rejects(prisma.$transaction(async (tx) => {
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, false));
    await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
      outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
    await closeByHand(tx, claim.claimId, BigInt(0), { budgetMode: "max_shadow",
      shadowUsage: "unknown", headroomCounted: false });
  }, { maxWait: 5_000, timeout: 20_000 }),
  refusedWith(/AmuxIdeaSessionAnalysisBudgetClaim_values_check/));
  const [definition] = await prisma.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_get_constraintdef(oid) AS "definition" FROM pg_constraint
    WHERE conname = 'AmuxIdeaSessionAnalysisBudgetClaim_values_check'`;
  assert.match(definition!.definition,
    /status = 'owner_consumed'::text\) AND \(\("settledMicroUsd" = "reservedMicroUsd"\) OR \(\("budgetMode" = 'max_shadow'::text\) AND \("settledMicroUsd" = 0\)\)\)/);
  assert.match(definition!.definition,
    /\("reservedMicroUsd" > 0\) OR \(\("budgetMode" = 'max_shadow'::text\) AND \("reservedMicroUsd" = 0\)\)/);
});

test("a subscription row closed at its full reservation before this rule still satisfies the CHECK", async () => {
  // Such a row exists on staging and its audited settlement is not rewritten:
  // with the mode guard out of the way, the CHECK accepts a subscription row
  // that reserved headroom and was closed at that amount.
  const queued = await queueIdea();
  await rolledBack(async (tx) => {
    const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, true));
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" DISABLE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_mode_guard"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" DISABLE TRIGGER USER');
    await tx.amuxIdeaSessionAnalysisBudgetClaim.update({ where: { id: claim.claimId },
      data: { reservedMicroUsd: BigInt(700) } });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" ENABLE TRIGGER USER');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" DISABLE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_mode_guard"');
    await holdUnknownByHand(tx, claim.claimId);
    await closeByHand(tx, claim.claimId, BigInt(700), {});
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.settledMicroUsd, BigInt(700));
  });
});
