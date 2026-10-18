import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { dmBodyDigest, dmKeyPeriodOf, dmSnapshotManifestDigest } from "@/lib/amux/decisionMakerBodyCore";
import {
  assignDecisionMakerRequestWithDigestKey,
  eraseDecisionMakerBodies,
  readDecisionMakerBodies,
  readDecisionMakerResultDetail,
  recordDecisionMakerRequestWithCardText,
  rotateDecisionMakerDigestKey,
  submitDecisionMakerOutput,
} from "@/lib/amux/decisionMakerBodyStore";
import { DM_DELIVERY_NOT_AN_APPROVAL } from "@/lib/amux/decisionMakerDeliveryCore";
import { readDecisionMakerDeliveryCandidate, readDecisionMakerUnsettledDelivery } from "@/lib/amux/decisionMakerDeliveryRead";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";
import {
  readDecisionMakerDeliveryState,
  recordDecisionMakerDelivery,
  recordDecisionMakerDeliveryOutcome,
  recordDecisionMakerJudgment,
} from "@/lib/amux/decisionMakerJudgmentStore";
import { writeDecisionMakerDeliveryAudit } from "@/lib/amux/decisionMakerJudgmentSystemAudit";
import {
  closeDecisionMakerRequestOnDirectAnswer,
  readDecisionMakerRequestState,
  recordDecisionMakerTransmitIntent,
} from "@/lib/amux/decisionMakerRequestStore";
import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { prisma } from "@/lib/prisma";

// AMUX Decision Maker stage S2-2b3 (docs/policy/amux-decision-maker.md §2-7,
// §6, §7, §9) against PostgreSQL, in the agents lane of the DB integration
// suite: the bridge's read of the next confirmed answer and the delivery
// decision and outcome its routes write, through the routes' own DB
// boundaries.
//
// §12's blocking test covered here: "운영자 확정 없이는 어떤 DM 출력도 worker에게
// 전달되지 않는다" -- a proposal nobody judged, a rejected one, an escalation and
// a timeout are never read as an answer, and the kill switch row of §6's
// table for "bridge의 확정 답 조회·전달". The statements are counted in
// tests/amuxDecisionMakerDelivery.test.mjs.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error(
      "REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database",
    );
  }
};
requireDedicatedAmuxTestDatabase();

// The tables refuse DELETE; TRUNCATE fires no row trigger, so each test starts empty.
const resetAll = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AmuxDecisionMakerDeliveryEvent", "AmuxDecisionMakerJudgment", "AmuxDecisionMakerResultDetail", "AmuxDecisionMakerBody", "AmuxDecisionMakerRetentionEvent", "AmuxDecisionMakerDigestKeyEvent", "AmuxDecisionMakerRequestEvent", "AmuxDecisionMakerRequest", "AmuxDecisionMakerSwitchEvent" RESTART IDENTITY`,
  );

const operator = (id = `dm-operator-${randomUUID()}`) =>
  ({ user: { id, email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

const setSwitch = (
  scope: "kill_switch" | "decision-maker-openai" | "decision-maker-anthropic",
  value: "on" | "off" | "proposal",
) => prisma.$transaction((tx) => recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope, value }));

const dbNowMs = async () =>
  Number((await prisma.$queryRaw<Array<{ now: bigint }>>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "now"`)[0]!.now);

const KEY = Buffer.alloc(32, 7);
let RING = new Map<number, Buffer>();

beforeEach(async () => {
  await resetAll();
  await setSwitch("decision-maker-openai", "proposal");
  await setSwitch("decision-maker-anthropic", "proposal");
  const period = dmKeyPeriodOf(await dbNowMs());
  RING = new Map([[period, KEY]]);
  const rotated = await prisma.$transaction((tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: period, keyRing: RING }));
  assert.equal(rotated.recorded, true);
});

after(async () => {
  await resetAll();
  await prisma.$disconnect();
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OPTIONS = [
  { id: "a", label: "Model id only" },
  { id: "b", label: "Model id and locale" },
];
const CARD = {
  askType: "decision",
  resolution: null,
  type: "task",
  tags: [] as string[],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  // The card's options carry their effect class and paths (stage S2-2b1); a result names OPTIONS.
  options: OPTIONS.map((option) => ({ ...option, effect: "choice_only", paths: [] as string[] })),
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
};

type Output =
  | { kind: "free_text"; answer: string; rationale: string; irreversible: boolean }
  | { kind: "select"; optionId: string; rationale: string; irreversible: boolean }
  | { kind: "escalate"; reason: string };

const FREE_TEXT: Output = { kind: "free_text", answer: "Use the model id only.", rationale: "The locale is already in the path.", irreversible: false };
const SELECT: Output = { kind: "select", optionId: "b", rationale: "The locale changes the answer.", irreversible: false };

/** Routed with its card text, assigned, transmitted card-only, and answered with `output`. */
const proposed = async (output: Output | "timeout" = FREE_TEXT, cardId = `AMUX-${randomUUID().slice(0, 8)}`) => {
  const binding = {
    cardId,
    questionRevision: 3,
    askingWorkerId: "claude-impl",
    amuxSessionId: "claude-impl",
    amuxSessionAttempt: 1,
    askingProvider: "claude",
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
  };
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx, { binding, card: CARD, keyRing: RING }));
  assert.equal(routed.route, "dm_proposal");
  const instance = routed.instance!;
  const assigned = await prisma.$transaction((tx) =>
    assignDecisionMakerRequestWithDigestKey(tx, { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: RING }),
  );
  assert.equal(assigned.recorded, true);
  const requestKey = (assigned as { requestKey: Buffer }).requestKey;
  const transmission = {
    snapshotState: "worker_head",
    snapshotTargetSha: SHA,
    snapshotManifestDigest: dmSnapshotManifestDigest(requestKey, [{ path: "lib/cache.ts", blobId: "f".repeat(40) }]),
    inputPayloadDigest: dmBodyDigest(requestKey, "card_text", "payload"),
  };
  const intent = await prisma.$transaction((tx) =>
    recordDecisionMakerTransmitIntent(tx, { requestId: routed.requestId, instance, transmission, requireLeaseAt: () => {} }),
  );
  assert.equal(intent.recorded, true);
  const stored: Record<string, unknown> = { ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  const submitted = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, {
      requestId: routed.requestId,
      instance,
      binding: { ...stored, transmission },
      output: output === "timeout" ? { kind: "timeout" } : { kind: "output", raw: JSON.stringify(output), options: OPTIONS },
      requireLeaseAt: () => {},
      keyRing: RING,
    }),
  );
  assert.equal(submitted.status === "submitted" && submitted.result.status, "accepted");
  return { requestId: routed.requestId, instance, cardId };
};

const shownOf = async (requestId: string): Promise<DmShownProposal> => {
  const state = (await readDecisionMakerRequestState(prisma, requestId))!;
  const bodies = await readDecisionMakerBodies(prisma, requestId);
  const detail = (await readDecisionMakerResultDetail(prisma, requestId))!;
  const digestOf = (field: string) => bodies.find((body) => body.field === field)?.digest ?? null;
  return {
    answerDigest: detail.outputKind === "free_text" ? digestOf("dm_answer") : null,
    rationaleDigest: digestOf("dm_rationale")!,
    optionId: detail.optionId,
    irreversible: detail.irreversible!,
    snapshotState: state.transmission!.snapshotState,
    snapshotTargetSha: state.transmission!.snapshotTargetSha,
    snapshotManifestDigest: state.transmission!.snapshotManifestDigest,
  };
};

const judge = async (requestId: string, kind: "confirm" | "edit_confirm" | "reject", operatorAnswer?: string) => {
  const input =
    kind === "reject"
      ? { kind }
      : kind === "confirm"
        ? { kind, shown: await shownOf(requestId) }
        : { kind, shown: await shownOf(requestId), operatorAnswer };
  const written = await prisma.$transaction((tx) =>
    recordDecisionMakerJudgment(tx, { session: operator(), requestId, keyRing: RING, ...input }),
  );
  assert.equal(written.recorded, true, JSON.stringify(written));
};

/** The bridge's read, through the route's own read boundary. */
const nextCandidate = (after: { judgedAtMs: number; requestId: string } | null = null) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryCandidateRead, (tx) => readDecisionMakerDeliveryCandidate(tx, { after }));

const decide = (requestId: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryDecision, (tx) => recordDecisionMakerDelivery(tx, { requestId }));

const settle = (requestId: string, outcome: "receipt" | "unknown") =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryOutcome, (tx) =>
    recordDecisionMakerDeliveryOutcome(tx, { requestId, outcome }),
  );

test("no DM output a person has not confirmed is ever read as an answer to deliver", async () => {
  // A proposal nobody judged, a rejected proposal, an escalation and a timeout.
  const unjudged = await proposed();
  const rejected = await proposed(SELECT);
  await judge(rejected.requestId, "reject");
  await proposed({ kind: "escalate", reason: "The operator must choose the cache owner." });
  await proposed("timeout");
  assert.deepEqual(await nextCandidate(), { status: "none" });
  // The decision is refused for each as well, and nothing is written.
  for (const requestId of [unjudged.requestId, rejected.requestId]) {
    assert.deepEqual(await decide(requestId), { recorded: false, reason: "not_confirmed" });
    assert.deepEqual(await readDecisionMakerDeliveryState(prisma, requestId), {
      requestId,
      judgmentKind: requestId === rejected.requestId ? "reject" : null,
      delivered: false,
      outcome: null,
      notSentReason: null,
      resolution: null,
    });
  }
});

test("a confirmed answer is read with §7's header, decided once, and its receipt recorded once", async () => {
  const basis = await proposed(SELECT);
  await judge(basis.requestId, "confirm");
  const candidate = await nextCandidate();
  assert.equal(candidate.status, "ready");
  if (candidate.status !== "ready") return;
  assert.equal(candidate.requestId, basis.requestId);
  assert.equal(candidate.cardId, basis.cardId);
  assert.equal(candidate.questionRevision, 3);
  // §9's binding as the request recorded it at routing.
  assert.equal(candidate.askingWorkerId, "claude-impl");
  assert.equal(candidate.session, "claude-impl");
  assert.equal(candidate.sessionAttempt, 1);
  assert.equal(candidate.messageId, `dm-answer:${basis.requestId}`);
  const label = basis.instance === "decision-maker-openai" ? "GPT-6 Astra" : "Claude Fable 5.1";
  assert.equal(
    candidate.message,
    `[Decision Maker ${basis.instance} (${label}) 제안, operator-confirmed, re ${basis.cardId}]\n선택지: b\n\n${DM_DELIVERY_NOT_AN_APPROVAL}`,
  );
  // The decision, once; the read no longer offers it.
  const decided = await decide(basis.requestId);
  assert.equal(decided.recorded, true);
  assert.deepEqual(await decide(basis.requestId), { recorded: false, reason: "already_delivered" });
  assert.deepEqual(await nextCandidate(), { status: "none" });
  // The receipt, once; nothing after it.
  assert.equal((await settle(basis.requestId, "receipt")).recorded, true);
  assert.deepEqual(await settle(basis.requestId, "unknown"), { recorded: false, reason: "outcome_recorded" });
  assert.deepEqual(await readDecisionMakerDeliveryState(prisma, basis.requestId), {
    requestId: basis.requestId,
    judgmentKind: "confirm",
    delivered: true,
    outcome: "receipt",
    notSentReason: null,
    resolution: null,
  });
});

test("an edited confirmation delivers the person's answer, not the DM's", async () => {
  const basis = await proposed(FREE_TEXT);
  await judge(basis.requestId, "edit_confirm", "Use the model id and keep the locale in the path.");
  const candidate = await nextCandidate();
  assert.equal(candidate.status, "ready");
  if (candidate.status !== "ready") return;
  assert.match(candidate.message, /operator-edited, re /);
  assert.ok(candidate.message.includes("\nUse the model id and keep the locale in the path.\n\n"));
  assert.ok(!candidate.message.includes(FREE_TEXT.kind === "free_text" ? FREE_TEXT.answer : ""));
});

test("under the kill switch nothing is read and nothing decided; an outcome is still recorded", async () => {
  const first = await proposed();
  await judge(first.requestId, "confirm");
  const second = await proposed();
  await judge(second.requestId, "confirm");
  assert.equal((await decide(second.requestId)).recorded, true);
  await setSwitch("kill_switch", "on");
  assert.deepEqual(await nextCandidate(), { status: "kill_switch_on" });
  assert.deepEqual(await decide(first.requestId), { recorded: false, reason: "kill_switch_on" });
  assert.equal((await readDecisionMakerDeliveryState(prisma, first.requestId)).delivered, false);
  // §6's table: an outcome records what already happened.
  assert.equal((await settle(second.requestId, "unknown")).recorded, true);
  await setSwitch("kill_switch", "off");
  const candidate = await nextCandidate();
  assert.equal(candidate.status === "ready" && candidate.requestId, first.requestId);
});

test("the walk steps past a confirmation it cannot deliver yet, and one whose answer was erased", async () => {
  const first = await proposed();
  await judge(first.requestId, "confirm");
  const second = await proposed();
  await judge(second.requestId, "confirm");
  const one = await nextCandidate();
  assert.equal(one.status === "ready" && one.requestId, first.requestId);
  if (one.status !== "ready") return;
  const two = await nextCandidate({ judgedAtMs: one.judgedAtMs, requestId: one.requestId });
  assert.equal(two.status === "ready" && two.requestId, second.requestId);
  if (two.status !== "ready") return;
  assert.deepEqual(await nextCandidate({ judgedAtMs: two.judgedAtMs, requestId: two.requestId }), { status: "none" });
  // A person erased the first answer (§10's privacy erase): nothing to deliver, and it says so.
  const erased = await prisma.$transaction((tx) =>
    eraseDecisionMakerBodies(tx, { session: operator(), requestId: first.requestId, fields: ["dm_answer"] }),
  );
  assert.equal(erased.deleted, true, JSON.stringify(erased));
  assert.deepEqual(await nextCandidate(), {
    status: "undeliverable",
    requestId: first.requestId,
    judgedAtMs: one.judgedAtMs,
    reason: "answer_body_missing",
  });
});

const notSent = (requestId: string, reason: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryOutcome, (tx) =>
    recordDecisionMakerDeliveryOutcome(tx, { requestId, outcome: "not_sent", reason }),
  );

test("stage S2-2b4: a decision that sent nothing records not_sent with its reason, as the request's one outcome", async () => {
  const basis = await proposed(SELECT);
  await judge(basis.requestId, "confirm");
  // Not before the decision: nothing was released to be not sent.
  assert.deepEqual(await notSent(basis.requestId, "answered_by_operator"), { recorded: false, reason: "not_delivered" });
  assert.equal((await decide(basis.requestId)).recorded, true);
  const recorded = await notSent(basis.requestId, "answered_by_operator");
  assert.equal(recorded.recorded, true, JSON.stringify(recorded));
  // One outcome per request: receipt, unknown and not_sent are one of three.
  assert.deepEqual(await settle(basis.requestId, "receipt"), { recorded: false, reason: "outcome_recorded" });
  assert.deepEqual(await settle(basis.requestId, "unknown"), { recorded: false, reason: "outcome_recorded" });
  assert.deepEqual(await notSent(basis.requestId, "lane_refused"), { recorded: false, reason: "outcome_recorded" });
  assert.deepEqual(await readDecisionMakerDeliveryState(prisma, basis.requestId), {
    requestId: basis.requestId,
    judgmentKind: "confirm",
    delivered: true,
    outcome: "not_sent",
    notSentReason: "answered_by_operator",
    resolution: null,
  });
  // The router's amux.decision.deliver, naming the event and the reason (§10 names no action of its own).
  const audits = await prisma.$queryRaw<Array<{ action: string; metadata: Record<string, string> }>>`
    SELECT a."action", a."metadata" FROM "AmuxDecisionMakerDeliveryEvent" d
    JOIN "AdminAuditLog" a ON a."id" = d."auditLogId"
    WHERE d."requestId" = ${basis.requestId} AND d."kind" = 'delivery_not_sent'
  `;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.action, "amux.decision.deliver");
  assert.equal(audits[0]!.metadata.kind, "delivery_not_sent");
  assert.equal(audits[0]!.metadata.not_sent_reason, "answered_by_operator");
  assert.equal(audits[0]!.metadata.systemActor, "amux-decision-router");
  // Nothing is left to resolve: a resolution follows an unknown outcome only.
  assert.equal((await nextCandidate()).status, "none");
});

test("stage S2-2b4: the database holds not_sent to a closed reason, after a decision, once", async () => {
  const basis = await proposed();
  await judge(basis.requestId, "confirm");
  assert.equal((await decide(basis.requestId)).recorded, true);
  // An unknown reason is refused before anything is written.
  await assert.rejects(notSent(basis.requestId, "because"), (error: unknown) => (error as { code?: string }).code === "invalid_input");
  // The CHECKs refuse what the store would never send, past the guard (the router's audit of the same
  // transaction): not_sent without a reason, a reason on another kind, a reason outside the list.
  const rawInsert = (kind: "delivery_not_sent" | "delivery_receipt", reason: string | null) =>
    prisma.$transaction(async (tx) => {
      const eventId = randomUUID();
      const auditLogId = await writeDecisionMakerDeliveryAudit(tx, {
        kind,
        eventId,
        metadata: { event_id: eventId, request_id: basis.requestId, kind },
      });
      await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerDeliveryEvent" ("id", "requestId", "kind", "actorKind", "notSentReason", "auditLogId")
        VALUES (${eventId}, ${basis.requestId}, ${kind}, 'system', ${reason}, ${auditLogId})`;
    });
  await assert.rejects(rawInsert("delivery_not_sent", null), /AmuxDecisionMakerDeliveryEvent_not_sent_shape_check/);
  await assert.rejects(rawInsert("delivery_receipt", "lane_refused"), /AmuxDecisionMakerDeliveryEvent_not_sent_shape_check/);
  await assert.rejects(rawInsert("delivery_not_sent", "because"), /AmuxDecisionMakerDeliveryEvent_not_sent_reason_check/);
  assert.equal((await readDecisionMakerDeliveryState(prisma, basis.requestId)).outcome, null);
  // Recorded under the kill switch as well: it records what already happened.
  await setSwitch("kill_switch", "on");
  assert.equal((await notSent(basis.requestId, "binding_changed")).recorded, true);
});

// ---------------------------------------------------------------------------
// Stage S2-2b4, section 2-7: "운영자의 직접 답이 먼저면 요청은 닫힌다"
// ---------------------------------------------------------------------------

const directAnswer = (cardId: string, questionRevision = 3) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDirectAnswerClose, (tx) =>
    closeDecisionMakerRequestOnDirectAnswer(tx, { cardId, questionRevision }),
  );

test("stage S2-2b4: the operator's direct answer closes its question's open request once, and its proposal is never confirmed or delivered", async () => {
  const basis = await proposed(SELECT);
  const shown = await shownOf(basis.requestId);
  const closed = await directAnswer(basis.cardId);
  assert.equal(closed.recorded, true, JSON.stringify(closed));
  assert.equal((await readDecisionMakerRequestState(prisma, basis.requestId))!.closing, "direct_answer_close");
  // Once: the same report again finds it closed and writes nothing.
  assert.deepEqual(await directAnswer(basis.cardId), { recorded: false, reason: "closed" });
  // §12: no DM output reaches a worker without the operator's confirmation -- and the operator
  // answered instead, so the proposal can no longer be confirmed, rejected or delivered.
  for (const input of [{ kind: "confirm", shown }, { kind: "reject" }]) {
    const judged = await prisma.$transaction((tx) =>
      recordDecisionMakerJudgment(tx, { session: operator(), requestId: basis.requestId, keyRing: RING, ...input }),
    );
    assert.deepEqual(judged, { recorded: false, reason: "closed" }, input.kind);
  }
  assert.deepEqual(await nextCandidate(), { status: "none" });
  assert.deepEqual(await decide(basis.requestId), { recorded: false, reason: "not_confirmed" });
  // The router's close under section 10's amux.decision.assign_discarded, told apart by its kind;
  // the closing trigger starts the retention at the close.
  const audits = await prisma.$queryRaw<Array<{ action: string; targetType: string; metadata: Record<string, string> }>>`
    SELECT a."action", a."targetType", a."metadata" FROM "AmuxDecisionMakerRequestEvent" e
    JOIN "AdminAuditLog" a ON a."id" = e."auditLogId"
    WHERE e."requestId" = ${basis.requestId} AND e."kind" = 'direct_answer_close'
  `;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.action, "amux.decision.assign_discarded");
  assert.equal(audits[0]!.targetType, "AmuxDecisionMakerRequestEvent");
  assert.equal(audits[0]!.metadata.kind, "direct_answer_close");
  assert.equal(audits[0]!.metadata.systemActor, "amux-decision-router");
  const retention = await prisma.$queryRaw<Array<{ hours: number }>>`
    SELECT extract(epoch FROM r."retentionUntil" - e."createdAt") / 3600 AS "hours"
    FROM "AmuxDecisionMakerRetentionEvent" r
    JOIN "AmuxDecisionMakerRequestEvent" e ON e."auditLogId" = r."auditLogId"
    WHERE r."requestId" = ${basis.requestId} AND r."kind" = 'retention_set'
  `;
  assert.deepEqual(retention.map((row) => Number(row.hours)), [2160]);
});

test("stage S2-2b4: a direct answer closes the request from any open state, and nothing else", async () => {
  const binding = (cardId: string) => ({
    cardId,
    questionRevision: 3,
    askingWorkerId: "claude-impl",
    amuxSessionId: "claude-impl",
    amuxSessionAttempt: 1,
    askingProvider: "claude",
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
  });
  // Routed to a DM and never assigned.
  const unassigned = await prisma.$transaction((tx) =>
    recordDecisionMakerRequestWithCardText(tx, { binding: binding("AMUX-unassigned"), card: CARD, keyRing: RING }),
  );
  assert.equal(unassigned.route, "dm_proposal");
  assert.equal((await directAnswer("AMUX-unassigned")).recorded, true);
  // An escalation the operator now answers.
  const escalated = await proposed({ kind: "escalate", reason: "The operator must choose the cache owner." });
  assert.equal((await directAnswer(escalated.cardId)).recorded, true);
  // A question kept with the operator is closed from its creation; there is nothing to close.
  const kept = await prisma.$transaction((tx) =>
    recordDecisionMakerRequestWithCardText(tx, { binding: { ...binding("AMUX-kept"), askingProvider: "gemini" }, card: CARD, keyRing: RING }),
  );
  assert.equal(kept.route, "operator");
  assert.deepEqual(await directAnswer("AMUX-kept"), { recorded: false, reason: "not_routed_to_dm" });
  // No request for the question, or for another revision of it.
  assert.deepEqual(await directAnswer("AMUX-nobody"), { recorded: false, reason: "unknown_request" });
  assert.deepEqual(await directAnswer(escalated.cardId, 4), { recorded: false, reason: "unknown_request" });
  // Section 6's table: the operator's direct answer is allowed under the kill switch.
  const proposal = await proposed();
  await setSwitch("kill_switch", "on");
  assert.equal((await directAnswer(proposal.cardId)).recorded, true);
  // A malformed question is refused before anything is read.
  await assert.rejects(directAnswer("../x"), (error: unknown) => (error as { code?: string }).code === "invalid_input");
});

test("stage S2-2b4: a request a direct answer closed in flight rejects the DM's late result", async () => {
  const cardId = "AMUX-in-flight";
  const routed = await prisma.$transaction((tx) =>
    recordDecisionMakerRequestWithCardText(tx, {
      binding: {
        cardId,
        questionRevision: 3,
        askingWorkerId: "claude-impl",
        amuxSessionId: "claude-impl",
        amuxSessionAttempt: 1,
        askingProvider: "claude",
        termListVersion: "v1",
        classificationVersion: "authority-manifest-1",
        scannerVersion: "v1",
      },
      card: CARD,
      keyRing: RING,
    }),
  );
  const instance = routed.instance!;
  const assigned = await prisma.$transaction((tx) =>
    assignDecisionMakerRequestWithDigestKey(tx, { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: RING }),
  );
  const requestKey = (assigned as { requestKey: Buffer }).requestKey;
  const transmission = {
    snapshotState: "none",
    snapshotTargetSha: null,
    snapshotManifestDigest: null,
    inputPayloadDigest: dmBodyDigest(requestKey, "card_text", "payload"),
  };
  assert.equal(
    (await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId: routed.requestId, instance, transmission, requireLeaseAt: () => {} }))).recorded,
    true,
  );
  assert.equal((await directAnswer(cardId)).recorded, true);
  const stored: Record<string, unknown> = { ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  const submitted = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, {
      requestId: routed.requestId,
      instance,
      binding: { ...stored, transmission },
      output: { kind: "output", raw: JSON.stringify(FREE_TEXT), options: OPTIONS },
      requireLeaseAt: () => {},
      keyRing: RING,
    }),
  );
  assert.equal(submitted.status === "submitted" && submitted.result.status, "rejected");
  assert.equal(submitted.status === "submitted" && submitted.result.status === "rejected" && submitted.result.reason, "request_closed");
});

// ---------------------------------------------------------------------------
// Stage S2-2b4, section 9: a decision whose outcome the bridge never recorded
// ---------------------------------------------------------------------------

const unsettled = () =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryUnsettledRead, (tx) => readDecisionMakerUnsettledDelivery(tx));

test("stage S2-2b4: a decision with no outcome is read back with its binding until an outcome settles it", async () => {
  assert.deepEqual(await unsettled(), { status: "none" });
  const first = await proposed(SELECT);
  await judge(first.requestId, "confirm");
  const second = await proposed(FREE_TEXT);
  await judge(second.requestId, "confirm");
  // A confirmation with no decision is the delivery read's, not this one's.
  assert.deepEqual(await unsettled(), { status: "none" });
  assert.equal((await decide(first.requestId)).recorded, true);
  assert.equal((await decide(second.requestId)).recorded, true);
  assert.equal((await settle(first.requestId, "receipt")).recorded, true);
  const read = await unsettled();
  assert.equal(read.status, "unsettled");
  if (read.status !== "unsettled") return;
  assert.equal(read.requestId, second.requestId);
  assert.equal(read.cardId, second.cardId);
  assert.equal(read.questionRevision, 3);
  // §9's binding, as the request recorded it at routing: the local AMUX reads the receipt of
  // dm-answer:<request id> in this session, and pauses this session for an unknown outcome.
  assert.equal(read.askingWorkerId, "claude-impl");
  assert.equal(read.session, "claude-impl");
  assert.equal(read.sessionAttempt, 1);
  assert.equal(read.messageId, `dm-answer:${second.requestId}`);
  assert.ok(Number.isSafeInteger(read.decidedAtMs) && read.decidedAtMs > 0);
  // It carries no answer: nothing to send, only what to look up.
  assert.ok(!JSON.stringify(read).includes(FREE_TEXT.kind === "free_text" ? FREE_TEXT.answer : "x"));
  // Read under the kill switch as well: recording what happened is allowed (section 6's table).
  await setSwitch("kill_switch", "on");
  assert.equal((await unsettled()).status, "unsettled");
  assert.equal((await notSent(second.requestId, "question_changed")).recorded, true);
  assert.deepEqual(await unsettled(), { status: "none" });
});

test("each delivery route's boundary takes its operation, and one call fewer refuses it", async () => {
  const basis = await proposed();
  await judge(basis.requestId, "confirm");
  const shortRead = { ...AMUX_DB_BOUNDARIES.decisionMakerDeliveryCandidateRead, prismaCallCeiling: 6 };
  await assert.rejects(
    withAmuxDbBoundary(shortRead, (tx) => readDecisionMakerDeliveryCandidate(tx, { after: null })),
    (error: unknown) => error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
  );
  assert.equal((await nextCandidate()).status, "ready");
  const shortDecision = { ...AMUX_DB_BOUNDARIES.decisionMakerDeliveryDecision, prismaCallCeiling: 9 };
  await assert.rejects(
    withAmuxDbBoundary(shortDecision, (tx) => recordDecisionMakerDelivery(tx, { requestId: basis.requestId })),
    (error: unknown) => error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
  );
  assert.equal((await decide(basis.requestId)).recorded, true);
  const shortOutcome = { ...AMUX_DB_BOUNDARIES.decisionMakerDeliveryOutcome, prismaCallCeiling: 8 };
  await assert.rejects(
    withAmuxDbBoundary(shortOutcome, (tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId: basis.requestId, outcome: "receipt" })),
    (error: unknown) => error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
  );
  assert.equal((await settle(basis.requestId, "receipt")).recorded, true);
});
