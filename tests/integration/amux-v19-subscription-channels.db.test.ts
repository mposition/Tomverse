import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR, AMUX_V19_SESSION_BUDGET_CLAIM_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_SUBSCRIPTION_AUTH_PROFILES } from "@/lib/amux/ideaAnalysisChannelCore";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "@/lib/amux/ideaAnalysisBudgetCore";
import { readAnalysisMonthlyBudgetSetting } from "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { AmuxIdeaAnalysisPriceApprovalError,
  commitAmuxIdeaAnalysisPriceApproval } from "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import { commitAmuxOperatingScope, readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from "@/lib/amux/ideaOperatingScopeStore";
import { AmuxSessionBudgetClaimError,
  commitAmuxSessionBudgetClaim } from "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { commitAmuxSessionAnalysisReservation } from
  "@/lib/amux/ideaSessionAnalysisReservationStore";
import { readAmuxV19MaxPriceSelection } from "@/lib/amux/ideaSessionMaxPriceSelectionRead";
import { AMUX_V19_MAX_LAUNCHER_ID } from "@/lib/amux/ideaSessionMaxLauncherAuth";
import { signAmuxV19MaxClaimAttestation } from
  "@/lib/amux/ideaSessionMaxLauncherAttestation.mjs";
import { commitAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionService";
import { inspectAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionCore";
import { POST as postMaxClaimRoute } from
  "@/app/api/internal/amux/v19/analysis-budget/claim/route";
import { prisma } from "@/lib/prisma";

// AMUX intake v19 subscription channels (owner decision 2026-10-20): every
// CLI channel can hold a subscription (max_shadow) claim, and the database
// binds the claim's sign-in profile to its own channel.

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v19 subscription channel test requires a dedicated loopback test database");
}

const ownerId = "synthetic-channel-owner-" + randomUUID();
const ownerEmail = "amux-channel-owner@example.test";
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
const request = new Request("https://tomverse.test/internal/amux/subscription-channels", {
  method: "POST",
});
const repositories = ["mposition/Tomverse"];
const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1, masterKey, digestKeyId: "synthetic-channel-digest", digestKey,
});
const sqlState = (error: unknown): string | null => {
  const candidate = error as { code?: unknown; meta?: { driverAdapterError?: {
    cause?: { code?: unknown; originalCode?: unknown } } } };
  const cause = candidate?.meta?.driverAdapterError?.cause;
  for (const code of [cause?.originalCode, cause?.code, candidate?.code]) {
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
};
class Rollback extends Error {}
/** Run assertions inside a transaction, then discard it so the next channel
 * starts from an empty shared ledger (a shadow claim occupies all headroom). */
async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await assert.rejects(prisma.$transaction(async (tx) => {
    await fn(tx);
    throw new Rollback("discard");
  }, { maxWait: 5_000, timeout: 20_000 }), (error: unknown) => error instanceof Rollback);
}

type Channel = { provider: "openai" | "anthropic" | "github-copilot" | "cursor";
  modelId: string; authority: AmuxOperatingScopeAuthority; priceVersionId: string };

async function approveChannel(provider: Channel["provider"], modelId: string):
  Promise<Omit<Channel, "authority">> {
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: randomUUID(), provider, modelId,
    allowedEfforts: ["high"], expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontier.ok) throw new Error("Synthetic Frontier input rejected: " + frontier.code);
  await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
  const priceVersionId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, requireCurrentFrontierModel: true, approval: {
      id: priceVersionId, provider, modelId, mode: "subscription_cli",
      expectedPreviousVersion: 0, inputTokensCap: 1_000_000, outputTokensCap: 128_000,
      inputMicroUsdPerMillion: 8_000_000, outputMicroUsdPerMillion: 20_000_000,
      evidenceDigest: randomBytes(32).toString("hex"), ownerConfirmedWorstTier: true,
      verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    } }));
  return { provider, modelId, priceVersionId };
}

async function selectScope(channel: Omit<Channel, "authority">): Promise<AmuxOperatingScopeAuthority> {
  const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: current?.version ?? 0,
    scope: { repositories, model: { provider: channel.provider, modelId: channel.modelId,
      reasoningEffort: "high" } }, ownerConfirmed: true,
  }));
  const authority = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  assert.ok(authority);
  assert.equal(authority.scope.model.provider, channel.provider);
  return authority;
}

async function queueIdea(authority: AmuxOperatingScopeAuthority) {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1, requestId: ideaId,
    input: { version: 1, idea: "Synthetic channel idea " + ideaId, repositories, pullRequests: [] },
    source: { toolName: "Copilot", modelProvider: "GitHub", sessionDisplay: "AMUX channel DB test" } });
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

/** The claim service's own writes, by hand, so a wrong profile reaches the
 * database guard that the service would never let through. */
async function insertShadowClaimByHand(tx: Prisma.TransactionClient, input: {
  channel: Channel; ideaId: string; reservationId: string; maxAuthProfile: string;
}) {
  await takeAuditChainLock(tx);
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  const now = clock[0]!.now;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const setting = await readAnalysisMonthlyBudgetSetting(tx);
  await tx.amuxIdeaAnalysisBudgetWindow.createMany({ data: [{
    namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart,
    limitMicroUsd: BigInt(setting.limitMicroUsd), spentMicroUsd: BigInt(0),
    reservedMicroUsd: BigInt(0) }], skipDuplicates: true });
  const key = { namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart };
  const window = await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: key } });
  const reserved = window.limitMicroUsd! - window.spentMicroUsd - window.reservedMicroUsd -
    window.shadowOverrunMicroUsd;
  const price = await tx.amuxIdeaAnalysisPriceVersion.findUniqueOrThrow({
    where: { id: input.channel.priceVersionId } });
  const claimId = randomUUID();
  const requestId = randomUUID();
  const auditId = await writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V19_SESSION_BUDGET_CLAIM_ACTION, targetType: AMUX_V19_SESSION_BUDGET_TARGET,
    targetId: claimId, summary: "Synthetic subscription channel claim.",
    metadata: { reservationId: input.reservationId, invocationOrdinal: 0, requestId,
      namespace: AMUX_V4_ANALYSIS_NAMESPACE, monthStart: monthStart.toISOString(),
      priceVersionId: price.id, modelId: input.channel.modelId,
      reservedMicroUsd: reserved.toString(), budgetMode: "max_shadow", ideaId: input.ideaId,
      reasoningEffort: "high", maxAuthProfile: input.maxAuthProfile,
      maxAuthEvidenceDigest: randomBytes(32).toString("hex"),
      amountMeaning: "cli_shadow_headroom_not_ceiling", modelCallStarted: false } });
  await tx.amuxIdeaAnalysisBudgetWindow.update({ where: { namespace_monthStart: key },
    data: { reservedMicroUsd: { increment: reserved } } });
  await tx.amuxIdeaSessionAnalysisBudgetClaim.create({ data: {
    id: claimId, requestId, reservationId: input.reservationId,
    namespace: AMUX_V4_ANALYSIS_NAMESPACE, invocationOrdinal: 0, monthStart,
    priceVersionId: price.id, provider: input.channel.provider, modelId: input.channel.modelId,
    inputTokensCap: price.inputTokensCap, outputTokensCap: price.outputTokensCap,
    inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: price.outputMicroUsdPerMillion,
    reservedMicroUsd: reserved, budgetMode: "max_shadow", status: "in_flight",
    claimAuditLogId: auditId } });
}

const CHANNELS = [["openai", "synthetic-codex-" + randomUUID()],
  ["github-copilot", "claude-sonnet-4.5"], ["cursor", "gpt-5"],
  ["anthropic", "synthetic-claude-" + randomUUID()]] as const;
const channels: Channel[] = [];

// CI runs this suite in the shared amux lane after session-submission, whose
// append-only scope rows stay; selectScope() writes on top of the latest one,
// and after() puts the scope that was current back for the suites that follow.
let priorScope: AmuxOperatingScopeAuthority | null = null;
before(async () => {
  priorScope = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  for (const [provider, modelId] of CHANNELS) {
    channels.push({ ...await approveChannel(provider, modelId),
      authority: undefined as unknown as AmuxOperatingScopeAuthority });
  }
});

after(async () => {
  if (priorScope) {
    const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
    await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
      session, request, id: randomUUID(), expectedPreviousVersion: current?.version ?? 0,
      scope: priorScope!.scope, ownerConfirmed: true }));
  }
  masterKey.fill(0);
  digestKey.fill(0);
  await prisma.$disconnect();
});

test("Frontier approvals, scope, reservation and price accept all four CLI channels", async () => {
  const rows = await prisma.amuxIdeaFrontierModelApproval.findMany({
    where: { status: "approved" }, select: { provider: true } });
  assert.deepEqual([...new Set(rows.map((row) => row.provider))].sort(),
    ["anthropic", "cursor", "github-copilot", "openai"]);
  // Only this suite's prices: earlier suites in the shared lane leave theirs.
  const prices = await prisma.amuxIdeaAnalysisPriceVersion.findMany({
    where: { mode: "subscription_cli", status: "approved",
      id: { in: channels.map((channel) => channel.priceVersionId) } },
    select: { provider: true } });
  assert.deepEqual(prices.map((price) => price.provider).sort(),
    ["anthropic", "cursor", "github-copilot", "openai"]);
  // The applied constraints: four channels on the v19 path, two on the v4 hold.
  const definitions = await prisma.$queryRaw<Array<{ name: string; definition: string }>>`
    SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition" FROM pg_constraint
    WHERE conname IN ('AmuxIdeaFrontierModelApproval_provider_check',
      'AmuxIdeaAnalysisPriceVersion_provider_check', 'AmuxIdeaOperatingScopeSetting_value_check',
      'AmuxIdeaSessionAnalysisReservation_provider_check',
      'AmuxIdeaSessionAnalysisBudgetClaim_values_check',
      'AmuxIdeaAnalysisBudgetHold_provider_check')`;
  assert.equal(definitions.length, 6);
  for (const { name, definition } of definitions) {
    const v4 = name === "AmuxIdeaAnalysisBudgetHold_provider_check";
    for (const provider of ["openai", "anthropic"]) assert.match(definition, new RegExp(`'${provider}'`));
    for (const provider of ["github-copilot", "cursor"]) {
      assert.equal(definition.includes(`'${provider}'`), !v4, `${name} ${provider}`);
    }
    assert.doesNotMatch(definition, /provider = 'anthropic'::text\)/, name);
  }
});

test("the price writer refuses an unapproved subscription model and an API price for Copilot", async () => {
  const base = { mode: "subscription_cli" as const, expectedPreviousVersion: 0,
    inputTokensCap: 1, outputTokensCap: 1, inputMicroUsdPerMillion: 1,
    outputMicroUsdPerMillion: 1, evidenceDigest: "c".repeat(64),
    ownerConfirmedWorstTier: true as const, verifiedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60 * 60_000) };
  await assert.rejects(prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, requireCurrentFrontierModel: true, approval: { ...base,
      id: randomUUID(), provider: "cursor", modelId: "not-approved-model" } })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "model_not_approved");
  await assert.rejects(prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
    session, request, approval: { ...base, mode: "api", id: randomUUID(),
      provider: "github-copilot", modelId: "claude-sonnet-4.5" } })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "invalid_price_evidence");
});

for (const [index, [provider]] of CHANNELS.entries()) {
  test(`${provider}: a subscription claim records its own channel's sign-in profile`, async () => {
    const channel = channels[index]!;
    channel.authority = await selectScope(channel);
    const queued = await queueIdea(channel.authority);
    const selection = await prisma.$transaction((tx) =>
      readAmuxV19MaxPriceSelection(tx, queued));
    assert.deepEqual(selection, { kind: "ready", priceVersionId: channel.priceVersionId,
      modelId: channel.modelId, reasoningEffort: "high" });
    const identity = { ideaId: queued.ideaId, modelId: channel.modelId,
      reasoningEffort: "high", authEvidenceDigest: randomBytes(32).toString("hex") };
    const claim = (provider: string) => (tx: Prisma.TransactionClient) =>
      commitAmuxSessionBudgetClaim(tx, { claimId: randomUUID(), requestId: randomUUID(),
        reservationId: queued.reservationId, invocationOrdinal: 0,
        priceVersionId: channel.priceVersionId,
        maxLauncherIdentity: { ...identity, provider },
        runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
          maxSubscriptionAuthenticated: true } });
    // A launcher of another channel cannot claim this reservation.
    const other = channel.provider === "cursor" ? "anthropic" : "cursor";
    await assert.rejects(prisma.$transaction(claim(other)), (error: unknown) =>
      error instanceof AmuxSessionBudgetClaimError && error.code === "not_ready");
    await rolledBack(async (tx) => {
      const result = await claim(channel.provider)(tx);
      const row = await tx.amuxIdeaSessionAnalysisBudgetClaim.findUniqueOrThrow({
        where: { id: result.claimId } });
      assert.equal(row.provider, channel.provider);
      assert.equal(row.budgetMode, "max_shadow");
      const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
      const metadata = audit.metadata as Record<string, unknown>;
      assert.equal(metadata.maxAuthProfile, AMUX_SUBSCRIPTION_AUTH_PROFILES[channel.provider]);
      assert.equal(metadata.budgetMode, "max_shadow");
      assert.equal(audit.summary, "Occupied monthly shadow headroom for one subscription CLI analysis.");
    });
    // The database guard: the same hand-written claim passes with this
    // channel's profile and is refused with any other channel's profile.
    await rolledBack((tx) => insertShadowClaimByHand(tx, { channel, ...queued,
      maxAuthProfile: AMUX_SUBSCRIPTION_AUTH_PROFILES[channel.provider] }));
    for (const wrong of Object.values(AMUX_SUBSCRIPTION_AUTH_PROFILES)
      .filter((profile) => profile !== AMUX_SUBSCRIPTION_AUTH_PROFILES[channel.provider])
      .concat([""])) {
      await assert.rejects(prisma.$transaction((tx) => insertShadowClaimByHand(tx, {
        channel, ...queued, maxAuthProfile: wrong })), (error: unknown) =>
        sqlState(error) === "23514" &&
        /Max shadow claim must occupy remaining headroom/.test(String(error)), wrong);
    }
    // A claim naming another channel and model than the reservation is
    // refused even with that other channel's own consistent profile.
    const otherChannel = channels.find((each) => each.provider !== channel.provider)!;
    await assert.rejects(prisma.$transaction((tx) => insertShadowClaimByHand(tx, {
      channel: otherChannel, ...queued,
      maxAuthProfile: AMUX_SUBSCRIPTION_AUTH_PROFILES[otherChannel.provider] })),
    (error: unknown) => sqlState(error) === "23514", otherChannel.provider);
  });
}

test("the fixed Claude Max launcher route cannot claim another channel's reservation", async () => {
  const copilot = channels.find((channel) => channel.provider === "github-copilot")!;
  await selectScope(copilot);
  const authority = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  assert.ok(authority);
  const queued = await queueIdea(authority);
  const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
  const names = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE", "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
    "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ"] as const;
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE = "enabled";
    process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ = "enabled";
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "enabled";
    const identity = { claimId: randomUUID(), requestId: randomUUID(),
      reservationId: queued.reservationId, ideaId: queued.ideaId, invocationOrdinal: 0,
      priceVersionId: copilot.priceVersionId, modelId: copilot.modelId, reasoningEffort: "high" };
    const authVerifiedAt = new Date().toISOString();
    const response = await postMaxClaimRoute(new Request(
      "https://test.invalid/api/internal/amux/v19/analysis-budget/claim", {
        method: "POST", headers: { authorization: `Bearer ${secret}`,
          "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID, "content-type": "application/json" },
        body: JSON.stringify({ ...identity, authVerifiedAt,
          authProof: signAmuxV19MaxClaimAttestation(secret, identity, authVerifiedAt) }),
      }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "not_ready" });
    assert.equal(await prisma.amuxIdeaSessionAnalysisBudgetClaim.count({
      where: { reservationId: queued.reservationId } }), 0);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
});
