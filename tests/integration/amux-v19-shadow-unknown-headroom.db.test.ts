import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
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
import { commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
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
// claim the owner closes without proof that the CLI never started spends no
// money, so it closes at zero and returns its headroom to the month. The
// runner reads the app's pre-write refusal as that refusal, not as an
// unknown outcome. A bounded claim's closure is unchanged.

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

/** Claim, then hold as outcome_unknown, in the caller's transaction. */
async function unknownClaim(tx: Prisma.TransactionClient,
  queued: { ideaId: string; reservationId: string }, shadow: boolean) {
  const claim = await commitAmuxSessionBudgetClaim(tx, claimInput(queued, shadow));
  await commitAmuxSessionBudgetOutcome(tx, { claimId: claim.claimId,
    outcome: "outcome_unknown", inputTokens: null, outputTokens: null });
  return claim;
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

async function resolveNotProven(claimId: string) {
  const readback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, { claimId, session }));
  assert.equal(readback.status, "outcome_unknown");
  return prisma.$transaction((tx) => commitAmuxSessionBudgetUnknownResolution(tx, {
    claimId, session, request, verification: "not_proven",
    localEvidenceDigest: sha256("synthetic inconclusive runner evidence " + claimId),
    readbackDigest: readback.readbackDigest, ownerConfirmed: true }));
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

test("an unproven subscription closure returns its headroom and the next claim is admitted", async () => {
  const before = await windowNow();
  const first = await queueIdea();
  const claim = await prisma.$transaction((tx) =>
    commitAmuxSessionBudgetClaim(tx, claimInput(first, true)));
  const headroom = BigInt(before.remainingMicroUsd);
  assert.equal(claim.reservedMicroUsd, headroom.toString(), "the claim occupies all headroom");
  await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: claim.claimId, outcome: "outcome_unknown", inputTokens: null,
    outputTokens: null, requiredBudgetMode: "max_shadow" }));

  // While that claim is unknown the app refuses the next one before writing,
  // and the runner reports that refusal instead of an unknown outcome.
  const second = await queueIdea();
  const held = await runnerClaim(second);
  assert.deepEqual(held.result, { kind: "budget_hold", reason: "usage_unknown",
    retryWrite: false });
  assert.equal(held.posts, 1);
  assert.equal(held.reads, 1);
  assert.equal(await prisma.amuxIdeaSessionAnalysisBudgetClaim.count({
    where: { reservationId: second.reservationId } }), 0);

  const resolved = await resolveNotProven(claim.claimId);
  assert.equal(resolved.status, "owner_consumed");
  assert.equal(resolved.settledMicroUsd, "0");
  const afterClosure = await windowNow();
  assert.equal(afterClosure.spentMicroUsd, before.spentMicroUsd, "headroom is not counted as usage");
  assert.equal(afterClosure.reservedMicroUsd, before.reservedMicroUsd, "the hold is released");
  assert.equal(afterClosure.shadowOverrunMicroUsd, before.shadowOverrunMicroUsd);
  assert.equal(afterClosure.remainingMicroUsd, before.remainingMicroUsd);
  const row = await prisma.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
    where: { id: claim.claimId } });
  assert.equal(row.status, "owner_consumed");
  assert.equal(row.settledMicroUsd, BigInt(0));
  assert.equal(row.reservedMicroUsd, headroom);
  assert.ok(row.closedAt);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: resolved.auditId } });
  assert.equal(audit.actorUserId, ownerId);
  assert.equal(audit.summary,
    "Owner closed one unknown subscription CLI claim; shadow usage unknown, headroom not counted.");
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.status, "owner_consumed");
  assert.equal(metadata.verification, "not_proven");
  assert.equal(metadata.settledMicroUsd, "0");
  assert.equal(metadata.reservedMicroUsd, headroom.toString());
  assert.equal(metadata.budgetMode, "max_shadow");
  assert.equal(metadata.shadowUsage, "unknown");
  assert.equal(metadata.headroomCounted, false);
  assert.equal(metadata.modelCallStarted, "unproven");
  const readback = await prisma.$transaction((tx) =>
    readAmuxSessionBudgetResolution(tx, { claimId: claim.claimId, session }));
  assert.equal(readback.status, "owner_consumed");
  assert.equal(readback.settledMicroUsd, "0");

  // The month is not full: the runner's next claim is admitted through the
  // real route and again occupies the whole headroom.
  const next = await runnerClaim(second);
  assert.equal(next.result.kind, "claimed");
  assert.deepEqual(next.result, { kind: "claimed", claimId: next.identity.claimId,
    reservationId: second.reservationId, requestId: next.identity.requestId,
    reservedMicroUsd: headroom.toString(), recovered: false, retryWrite: false });
  assert.equal(next.reads, 0);
  // Close it the same way so the shared lane keeps no open claim.
  await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, {
    claimId: next.identity.claimId, outcome: "outcome_unknown", inputTokens: null,
    outputTokens: null, requiredBudgetMode: "max_shadow" }));
  assert.equal((await resolveNotProven(next.identity.claimId)).settledMicroUsd, "0");
  const final = await windowNow();
  assert.equal(final.spentMicroUsd, before.spentMicroUsd);
  assert.equal(final.reservedMicroUsd, before.reservedMicroUsd);
});

test("the database refuses a subscription closure that counts headroom or does not say why", async () => {
  const queued = await queueIdea();
  const shadowAudit = { budgetMode: "max_shadow", shadowUsage: "unknown",
    headroomCounted: false };
  for (const [label, settle, metadata] of [
    ["full reservation counted", "reserved", shadowAudit],
    ["no shadowUsage", "zero", { budgetMode: "max_shadow", headroomCounted: false }],
    ["headroomCounted true", "zero", { ...shadowAudit, headroomCounted: true }],
    ["headroomCounted as text", "zero", { ...shadowAudit, headroomCounted: "false" }],
    ["no budgetMode", "zero", { shadowUsage: "unknown", headroomCounted: false }],
  ] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const claim = await unknownClaim(tx, queued, true);
      await closeByHand(tx, claim.claimId,
        settle === "reserved" ? BigInt(claim.reservedMicroUsd) : BigInt(0), metadata);
    }, { maxWait: 5_000, timeout: 20_000 }),
    refusedWith(/Max shadow unknown closure must return its headroom/), label);
  }
  // The same hand closure with the zero settlement and its reasons passes.
  await rolledBack(async (tx) => {
    const claim = await unknownClaim(tx, queued, true);
    await closeByHand(tx, claim.claimId, BigInt(0), shadowAudit);
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.status, "owner_consumed");
    assert.equal(row.settledMicroUsd, BigInt(0));
  });
});

test("a bounded closure still consumes its full reservation", async () => {
  const queued = await queueIdea();
  await rolledBack(async (tx) => {
    const before = await readAnalysisBudgetSnapshot(tx);
    const claim = await unknownClaim(tx, queued, false);
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
  // even with the subscription reasons attached.
  await assert.rejects(prisma.$transaction(async (tx) => {
    const claim = await unknownClaim(tx, queued, false);
    await closeByHand(tx, claim.claimId, BigInt(0), { budgetMode: "max_shadow",
      shadowUsage: "unknown", headroomCounted: false });
  }, { maxWait: 5_000, timeout: 20_000 }),
  refusedWith(/AmuxIdeaSessionAnalysisBudgetClaim_values_check/));
  const [definition] = await prisma.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_get_constraintdef(oid) AS "definition" FROM pg_constraint
    WHERE conname = 'AmuxIdeaSessionAnalysisBudgetClaim_values_check'`;
  assert.match(definition!.definition,
    /status = 'owner_consumed'::text\) AND \(\("settledMicroUsd" = "reservedMicroUsd"\) OR \(\("budgetMode" = 'max_shadow'::text\) AND \("settledMicroUsd" = 0\)\)\)/);
});

test("a subscription row closed at its full reservation before this rule still satisfies the CHECK", async () => {
  // Such a row exists on staging and its audited settlement is not rewritten:
  // with only the new mode-guard branch out of the way, the CHECK accepts it.
  const queued = await queueIdea();
  await rolledBack(async (tx) => {
    const claim = await unknownClaim(tx, queued, true);
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim" DISABLE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_mode_guard"');
    await closeByHand(tx, claim.claimId, BigInt(claim.reservedMicroUsd), {});
    const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
      where: { id: claim.claimId } });
    assert.equal(row.settledMicroUsd, BigInt(claim.reservedMicroUsd));
  });
});
