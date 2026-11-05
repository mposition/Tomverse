import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Session } from "next-auth";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { dmBodyDigest, dmKeyPeriodOf, dmSnapshotManifestDigest } from
  "@/lib/amux/decisionMakerBodyCore";
import { assignDecisionMakerRequestWithDigestKey, readDecisionMakerBodies,
  readDecisionMakerResultDetail, recordDecisionMakerRequestWithCardText,
  rotateDecisionMakerDigestKey, submitDecisionMakerOutput } from
  "@/lib/amux/decisionMakerBodyStore";
import { irreversibleTermCategories } from "@/lib/amux/decisionMakerCore";
import { recordDecisionMakerJudgment } from "@/lib/amux/decisionMakerJudgmentStore";
import { readDecisionMakerRequestState, recordDecisionMakerTransmitIntent } from
  "@/lib/amux/decisionMakerRequestStore";
import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { AMUX_V19_SUBSCRIPTION_NO_PRICE_ID } from
  "@/lib/amux/ideaAnalysisApprovedCostProfile";
import { commitAnalysisBudgetSetting, readAnalysisMonthlyBudgetSetting } from
  "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import { commitAmuxOperatingScope, readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from "@/lib/amux/ideaOperatingScopeStore";
import { AmuxSessionBudgetClaimError, commitAmuxSessionBudgetClaim } from
  "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
import { commitAmuxSessionAnalysisPlanInTx } from "@/lib/amux/ideaSessionAnalysisPlanService";
import { amuxV19SessionPromptForClaim } from "@/lib/amux/ideaSessionAnalysisPromptCore";
import { buildAmuxSessionAnalysisQueueWhere } from
  "@/lib/amux/ideaSessionAnalysisQueueWhereCore";
import { commitAmuxSessionAnalysisReservation } from
  "@/lib/amux/ideaSessionAnalysisReservationStore";
import { readAmuxV19MaxPagePromptInTx } from "@/lib/amux/ideaSessionMaxIdeaRead";
import { readAmuxV19MaxPriceSelection } from "@/lib/amux/ideaSessionMaxPriceSelectionRead";
import { decideAmuxPlanRefusalAsOwner } from
  "@/lib/amux/ideaSessionPlanRefusalOwnerService";
import { readOpenAmuxPlanRefusal } from "@/lib/amux/ideaSessionPlanRefusalService";
import { commitAmuxIdeaSessionSubmission as commitPinned } from
  "@/lib/amux/ideaSessionSubmissionService";
import { inspectAmuxIdeaSessionSubmission } from "@/lib/amux/ideaSessionSubmissionCore";
import { applyAmuxPlanRefusalDecisionStep, isAmuxV22QuestionCard, readAmuxV22QuestionSyncRows,
  recordAmuxV22QuestionLocalCard, recordAmuxV22QuestionLocalCardClosed,
  runAmuxV22ResolveStep } from "@/lib/amux/v22OwnerQuestionDmService";
import { prisma } from "@/lib/prisma";

const ownerId = "synthetic-plan-refusal-owner-" + randomUUID();
const ownerEmail = "amux-plan-refusal-owner@example.test";
process.env.ADMIN_USER_IDS = ownerId;
process.env.ADMIN_EMAILS = ownerEmail;
process.env.ADMIN_OWNER_EMAILS = ownerEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = { user: { id: ownerId, email: ownerEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/internal/amux/plan-refusal", { method: "POST" });
const modelId = "synthetic-plan-refusal-model-" + randomUUID();
const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1, masterKey, digestKeyId: "synthetic-plan-refusal-digest", digestKey });
const DM_KEY = Buffer.alloc(32, 9);
let RING = new Map<number, Buffer>();
let authority: AmuxOperatingScopeAuthority;
let priorScope: AmuxOperatingScopeAuthority | null = null;

before(async () => {
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: randomUUID(), provider: "anthropic", modelId,
    allowedEfforts: ["high"], expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true }));
  if (!frontier.ok) throw new Error(frontier.code);
  await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
  priorScope = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, { session, request,
    id: randomUUID(), expectedPreviousVersion: priorScope?.version ?? 0, ownerConfirmed: true,
    scope: { repositories: ["mposition/Tomverse"],
      model: { provider: "anthropic", modelId, reasoningEffort: "high" } } }));
  authority = (await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx)))!;
  const budget = await prisma.$transaction((tx) => readAnalysisMonthlyBudgetSetting(tx));
  await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, { session, request,
    id: randomUUID(), expectedPreviousVersion: budget.version, monthlyUsd: "1000",
    ownerConfirmed: true }));
  for (const scope of ["decision-maker-openai", "decision-maker-anthropic"] as const) {
    await prisma.$transaction((tx) => recordDecisionMakerSwitchByOperator(tx,
      { session, scope, value: "proposal" }));
  }
  const rows = await prisma.$queryRaw<Array<{ now: bigint }>>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "now"`;
  const period = dmKeyPeriodOf(Number(rows[0]!.now));
  RING = new Map([[period, DM_KEY]]);
  await prisma.$transaction((tx) => rotateDecisionMakerDigestKey(tx,
    { keyPeriod: period, keyRing: RING }));
});

// CI runs this suite late in the shared amux lane, after session-submission
// needed a fresh scope; the append-only scope it adds is superseded by the
// scope that was current, so the suites that follow see what they saw before.
after(async () => {
  if (priorScope) {
    const current = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
    await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, { session, request,
      id: randomUUID(), expectedPreviousVersion: current?.version ?? 0,
      scope: priorScope!.scope, ownerConfirmed: true }));
  }
  masterKey.fill(0);
  digestKey.fill(0);
  await prisma.$disconnect();
});

/** An idea whose first claim settled and whose answer the plan check refused. */
async function refusedIdea() {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1, requestId: ideaId,
    input: { version: 1, idea: "Synthetic refused idea " + ideaId,
      repositories: ["mposition/Tomverse"], pullRequests: [] },
    source: { toolName: "Codex", modelProvider: "OpenAI", sessionDisplay: "plan refusal DB test" } });
  if (!inspected.ok) throw new Error(inspected.code);
  const reservation = await prisma.$transaction(async (tx) => {
    const submission = await commitPinned(tx, { inspected, expectedAuthority: authority,
      ideaId, keys: keysFor(ideaId), pinnedCommitShas: ["a".repeat(40)] });
    return commitAmuxSessionAnalysisReservation(tx, { ideaId,
      requestId: submission.requestId, submissionAuditId: submission.auditId, authority });
  });
  const openPage = async (invocationOrdinal: number) => {
    const page = { claimId: randomUUID(), requestId: randomUUID(),
      reservationId: reservation.reservationId, invocationOrdinal };
    await prisma.$transaction((tx) => commitAmuxSessionBudgetClaim(tx, { ...page,
      priceVersionId: AMUX_V19_SUBSCRIPTION_NO_PRICE_ID,
      maxLauncherIdentity: { ideaId, provider: "anthropic", modelId, reasoningEffort: "high",
        authEvidenceDigest: randomBytes(32).toString("hex") },
      runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
        maxSubscriptionAuthenticated: true } }));
    return page;
  };
  const first = await openPage(0);
  const planned = await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await commitAmuxSessionBudgetOutcome(tx, { claimId: first.claimId,
      outcome: "verified_success", inputTokens: 10, outputTokens: 1,
      requiredBudgetMode: "max_shadow",
      exactAgentClaim: { requestId: first.requestId, reservationId: first.reservationId,
        ideaId, invocationOrdinal: 0 },
      cliAttestation: { provider: "anthropic", modelAttestation: "served",
        cliSha256: "e".repeat(64) } });
    await tx.amuxIdeaSubmission.update({ where: { id: ideaId }, data: { state: "analyzing" } });
    return commitAmuxSessionAnalysisPlanInTx(tx, { ideaId, claimId: first.claimId,
      resultAuditId: `synthetic-result-${first.claimId}`, modelId,
      rawModelOutput: "{\"units\":[]}", keys: keysFor(ideaId) });
  }, { timeout: 30_000 });
  assert.deepEqual(planned, { state: "plan_refused", reason: "invalid_result" });
  const refusal = await prisma.amuxIdeaSessionPlanRefusal.findUniqueOrThrow({
    where: { claimId: first.claimId } });
  return { ideaId, reservationId: reservation.reservationId, openPage, refusal };
}

const queued = async (reservationId: string) => (await prisma.amuxIdeaSessionAnalysisReservation
  .findMany({ where: buildAmuxSessionAnalysisQueueWhere(new Date(), null), select: { id: true } }))
  .some((row) => row.id === reservationId);

const syncRows = () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionRead,
  (tx, context) => readAmuxV22QuestionSyncRows(tx, context.dbNow));
const writeCard = <T>(work: (tx: Parameters<Parameters<typeof withAmuxDbBoundary>[1]>[0],
  now: Date) => Promise<T>) => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
  (tx, context) => work(tx, context.dbNow));

/** The card's ask, routed to a DM and answered with `output`, as the relay's scan files it. */
async function proposed(card: { title: string; question: string; unblocks: string;
  options: Array<{ id: string; label: string }> }, cardId: string, output: unknown) {
  const binding = { cardId, questionRevision: 1, askingWorkerId: "session-analysis",
    amuxSessionId: "session-analysis", amuxSessionAttempt: 0, askingProvider: "claude",
    termListVersion: "v1", classificationVersion: "authority-manifest-1", scannerVersion: "v1" };
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx,
    { binding, keyRing: RING, card: { askType: "decision", resolution: null, type: "task",
      tags: [], title: card.title, question: card.question, unblocks: card.unblocks,
      options: card.options.map((option) => ({ ...option, effect: "choice_only", paths: [] })),
      context: "", contextPaths: [] } }));
  assert.equal(routed.route, "dm_proposal", "the card clears the routing checks");
  const instance = routed.instance!;
  const assigned = await prisma.$transaction((tx) => assignDecisionMakerRequestWithDigestKey(tx,
    { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: RING }));
  const requestKey = (assigned as unknown as { requestKey: Buffer }).requestKey;
  const transmission = { snapshotState: "worker_head", snapshotTargetSha: "0123456789abcdef0123456789abcdef01234567",
    snapshotManifestDigest: dmSnapshotManifestDigest(requestKey, [{ path: "lib/cache.ts", blobId: "f".repeat(40) }]),
    inputPayloadDigest: dmBodyDigest(requestKey, "card_text", "payload") };
  await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx,
    { requestId: routed.requestId, instance, transmission, requireLeaseAt: () => {} }));
  const stored: Record<string, unknown> = {
    ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  const submitted = await prisma.$transaction((tx) => submitDecisionMakerOutput(tx, {
    requestId: routed.requestId, instance, binding: { ...stored, transmission },
    output: { kind: "output", raw: JSON.stringify(output), options: card.options },
    requireLeaseAt: () => {}, keyRing: RING } as never));
  assert.equal(submitted.status === "submitted" && submitted.result.status, "accepted");
  return routed.requestId;
}

async function confirm(requestId: string, edited?: string) {
  const state = (await readDecisionMakerRequestState(prisma, requestId))!;
  const bodies = await readDecisionMakerBodies(prisma, requestId);
  const detail = (await readDecisionMakerResultDetail(prisma, requestId))!;
  const digestOf = (field: string) => bodies.find((body) => body.field === field)?.digest ?? null;
  const shown = { answerDigest: detail.outputKind === "free_text" ? digestOf("dm_answer") : null,
    rationaleDigest: digestOf("dm_rationale")!, optionId: detail.optionId,
    irreversible: detail.irreversible!, snapshotState: state.transmission!.snapshotState,
    snapshotTargetSha: state.transmission!.snapshotTargetSha,
    snapshotManifestDigest: state.transmission!.snapshotManifestDigest };
  const written = await prisma.$transaction((tx) => recordDecisionMakerJudgment(tx, {
    session, requestId, keyRing: RING, shown,
    ...(edited ? { kind: "edit_confirm", operatorAnswer: edited } : { kind: "confirm" }) } as never));
  assert.equal(written.recorded, true, JSON.stringify(written));
}

const select = (optionId: string) => ({ kind: "select", optionId,
  rationale: "The refusal names one fixable schema point.", irreversible: false });

test("a refused answer waits for a confirmed proposal, then runs again with its reason", async () => {
  const idea = await refusedIdea();
  assert.equal(idea.refusal.state, "open");
  assert.equal(idea.refusal.detail, "chunk_schema_rejected");
  assert.equal(idea.refusal.schemaRule, "key_missing");
  const held = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: idea.ideaId },
    select: { state: true, analysisCompletedAt: true, rawPurgeAfter: true, rawCiphertext: true } });
  assert.equal(held.state, "analyzing");
  assert.equal(held.analysisCompletedAt, null);
  assert.ok(held.rawCiphertext, "the idea is kept for another run");

  // Nothing runs while the decision is open: not the queue, not the runner's
  // read, not the claim.
  assert.equal(await queued(idea.reservationId), false);
  assert.deepEqual(await prisma.$transaction((tx) => readAmuxV19MaxPriceSelection(tx,
    { reservationId: idea.reservationId, ideaId: idea.ideaId })), { kind: "hold" });
  await assert.rejects(idea.openPage(1), (error: unknown) =>
    error instanceof AmuxSessionBudgetClaimError && error.code === "not_ready");

  const { refusalCards } = await syncRows();
  const card = refusalCards.find((row) => row.question_id === idea.refusal.id)!;
  assert.equal(card.provider, "claude");
  assert.match(card.question, /chunk_schema_rejected, rule key_missing/);
  assert.deepEqual(irreversibleTermCategories([card.title, card.question, card.unblocks,
    ...card.options.map((option) => option.label)].join("\n")), []);
  const cardId = `AMUX-${randomUUID().slice(0, 8)}`;
  await writeCard((tx) => recordAmuxV22QuestionLocalCard(tx, { questionId: idea.refusal.id, cardId }));
  await writeCard((tx) => recordAmuxV22QuestionLocalCard(tx, { questionId: idea.refusal.id, cardId }));
  await assert.rejects(writeCard((tx) => recordAmuxV22QuestionLocalCard(tx,
    { questionId: idea.refusal.id, cardId: "AMUX-other" })), /card_conflict/);
  assert.ok(!(await syncRows()).refusalCards.some((row) => row.question_id === idea.refusal.id));
  assert.equal(await isAmuxV22QuestionCard(prisma, cardId), true, "never typed into a session");

  const requestId = await proposed(card, cardId, select("retry"));
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, null, "nobody confirmed it yet");
  assert.equal(await queued(idea.reservationId), false);
  await confirm(requestId);
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "answered");
  const decided = await prisma.amuxIdeaSessionPlanRefusal.findUniqueOrThrow({
    where: { id: idea.refusal.id } });
  assert.equal(decided.state, "retry");
  assert.equal(decided.decisionSource, "dm_confirmed");

  assert.equal(await queued(idea.reservationId), true);
  const second = await idea.openPage(1);
  const page = await prisma.$transaction((tx) => readAmuxV19MaxPagePromptInTx(tx,
    { reservationId: idea.reservationId, ideaId: idea.ideaId, claimId: second.claimId },
    keysFor(idea.ideaId)));
  assert.ok(page, "page 0 is still what the second claim analyses");
  assert.match(page.prompt, /A previous answer for this page was refused by the plan check: chunk_schema_rejected, rule key_missing/);
  // The box runner's own check still finds the data block at the end.
  assert.ok(amuxV19SessionPromptForClaim({ claimId: second.claimId, pagePrompt: page.prompt,
    referenceCount: 1, provider: "anthropic" }));
  // One claim runs at a time; this one's run ends here.
  await prisma.$transaction((tx) => commitAmuxSessionBudgetOutcome(tx, { claimId: second.claimId,
    outcome: "verified_success", inputTokens: 10, outputTokens: 1,
    requiredBudgetMode: "max_shadow",
    exactAgentClaim: { requestId: second.requestId, reservationId: second.reservationId,
      ideaId: idea.ideaId, invocationOrdinal: 1 },
    cliAttestation: { provider: "anthropic", modelAttestation: "served",
      cliSha256: "e".repeat(64) } }));

  const closing = (await syncRows()).closing;
  assert.ok(closing.some((row) => row.questionId === idea.refusal.id && row.cardId === cardId));
  await writeCard((tx, now) => recordAmuxV22QuestionLocalCardClosed(tx,
    { questionId: idea.refusal.id, cardId, now }));
  await writeCard((tx, now) => recordAmuxV22QuestionLocalCardClosed(tx,
    { questionId: idea.refusal.id, cardId, now }));
  assert.ok(!(await syncRows()).closing.some((row) => row.questionId === idea.refusal.id));
});

test("a stop parks the idea for the operator and no further claim is possible", async () => {
  const idea = await refusedIdea();
  // The longest path runs through its own boundary: docs/policy/amux-decision-maker.md
  // §9's 12 statements, which the boundary's ceiling enforces call by call.
  assert.equal(AMUX_DB_BOUNDARIES.decisionMakerPlanRefusalDecide.prismaCallCeiling, 12);
  const applied = await applyAmuxPlanRefusalDecisionStep({ refusalId: idea.refusal.id,
    ideaId: idea.ideaId, requestId: randomUUID(), decision: "stop" });
  assert.equal(applied?.applied, true);
  assert.equal((await applyAmuxPlanRefusalDecisionStep({ refusalId: idea.refusal.id,
    ideaId: idea.ideaId, requestId: randomUUID(), decision: "retry" }))?.applied, false,
  "a decided refusal is decided once");
  const parked = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: idea.ideaId },
    select: { state: true, analysisCompletedAt: true, rawPurgeAfter: true } });
  assert.equal(parked.state, "awaiting_owner");
  assert.ok(parked.analysisCompletedAt);
  assert.ok(parked.rawPurgeAfter);
  assert.equal(await queued(idea.reservationId), false);
  await assert.rejects(idea.openPage(1), (error: unknown) =>
    error instanceof AmuxSessionBudgetClaimError && error.code === "not_ready");
  assert.equal(await readOpenAmuxPlanRefusal(idea.ideaId), null);
});

test("an answer that names no option stays open, and the owner can decide once", async () => {
  const idea = await refusedIdea();
  const card = (await syncRows()).refusalCards.find((row) => row.question_id === idea.refusal.id)!;
  const cardId = `AMUX-${randomUUID().slice(0, 8)}`;
  await writeCard((tx) => recordAmuxV22QuestionLocalCard(tx, { questionId: idea.refusal.id, cardId }));
  const requestId = await proposed(card, cardId, select("retry"));
  await confirm(requestId, "Maybe, look at it again later.");
  for (let step = await runAmuxV22ResolveStep(null); step.cursor.move === "advance";
    step = await runAmuxV22ResolveStep(step.cursor)) {
    assert.equal(step.resolved, null);
  }
  const open = await readOpenAmuxPlanRefusal(idea.ideaId);
  assert.equal(open?.refusalId, idea.refusal.id);
  assert.equal(open?.at?.rule, "key_missing");

  await assert.rejects(decideAmuxPlanRefusalAsOwner({ session, request, ideaId: randomUUID(),
    refusalId: idea.refusal.id, decision: "retry" }), /not_found/);
  await decideAmuxPlanRefusalAsOwner({ session, request, ideaId: idea.ideaId,
    refusalId: idea.refusal.id, decision: "retry" });
  await assert.rejects(decideAmuxPlanRefusalAsOwner({ session, request, ideaId: idea.ideaId,
    refusalId: idea.refusal.id, decision: "stop" }), /not_open/);
  const decided = await prisma.amuxIdeaSessionPlanRefusal.findUniqueOrThrow({
    where: { id: idea.refusal.id } });
  assert.equal(decided.state, "retry");
  assert.equal(decided.decisionSource, "operator");
  assert.equal(decided.decidedByUserId, ownerId);
});
