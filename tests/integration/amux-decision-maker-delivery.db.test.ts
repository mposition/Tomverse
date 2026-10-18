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
import { readDecisionMakerDeliveryCandidate } from "@/lib/amux/decisionMakerDeliveryRead";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";
import {
  readDecisionMakerDeliveryState,
  recordDecisionMakerDelivery,
  recordDecisionMakerDeliveryOutcome,
  recordDecisionMakerJudgment,
} from "@/lib/amux/decisionMakerJudgmentStore";
import { readDecisionMakerRequestState, recordDecisionMakerTransmitIntent } from "@/lib/amux/decisionMakerRequestStore";
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
  assert.equal(candidate.session, "claude-impl");
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
