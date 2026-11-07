import { randomBytes, randomInt, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { dmBodyDigest, dmKeyPeriodOf, dmSnapshotManifestDigest } from "@/lib/amux/decisionMakerBodyCore";
import {
  assignDecisionMakerRequestWithDigestKey,
  readDecisionMakerBodies,
  readDecisionMakerResultDetail,
  recordDecisionMakerRequestWithCardText,
  rotateDecisionMakerDigestKey,
  submitDecisionMakerOutput,
} from "@/lib/amux/decisionMakerBodyStore";
import { readDecisionMakerDeliveryCandidate } from "@/lib/amux/decisionMakerDeliveryRead";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";
import { recordDecisionMakerJudgment } from "@/lib/amux/decisionMakerJudgmentStore";
import { closeDecisionMakerRequestOnDirectAnswer, readDecisionMakerRequestState,
  recordDecisionMakerTransmitIntent } from "@/lib/amux/decisionMakerRequestStore";
import { runAmuxDmAutoApplyStep } from "@/lib/amux/dmAutoApplyService";
import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { AMUX_IDEA_CARD_CLOSE_SCAN } from "@/lib/amux/ideaCardCloseCore";
import {
  amuxIdeaCardCloseRelayCards,
  applyAmuxIdeaCardCloseDmAnswer,
  isAmuxIdeaCardCloseBusy,
  openAmuxIdeaCardCloseQuestionIfDue,
  readAmuxIdeaCardCloseOwnerState,
  readAmuxIdeaCardCloseQuestionForOwner,
  readAmuxIdeaCardCloseSyncForRelay,
} from "@/lib/amux/ideaCardCloseService";
import { AmuxIdeaCardCloseOwnerError, answerAmuxIdeaCardCloseForOwner,
  closeAmuxIdeaCardsDirectlyForOwner } from "@/lib/amux/ideaCardCloseOwnerService";
import { readAmuxIdeaProgressForOwner } from "@/lib/amux/ideaProgressRead";
import {
  isAmuxV22QuestionCard,
  recordDmQuestionLocalCard,
  recordDmQuestionLocalCardClosed,
  runAmuxV22ResolveStep,
} from "@/lib/amux/v22OwnerQuestionDmService";
import { prisma } from "@/lib/prisma";

// Closing a stalled idea's remaining cards (owner decision 2026-11-05,
// docs/policy/amux-decision-maker.md §2-10) against PostgreSQL, through the real
// DB boundaries: an operation over its statement ceiling fails here, and each
// apply runs the card table's deferred guards at COMMIT. Only the seed turns
// triggers off, because a card's history is not what is under test.

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
  const usesCanonicalCiDatabase = databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

// With the key, every audit entry takes its most statements: the counted case.
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-idea-card-close-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = "synthetic-card-close";
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = "1";
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = randomBytes(32).toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = "synthetic-card-close-digest";
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = randomBytes(32).toString("base64");

const OWNER_ID = `card-close-owner-${randomUUID()}`;
const OWNER_EMAIL = "amux-card-close-owner@example.test";
process.env.ADMIN_USER_IDS = OWNER_ID;
process.env.ADMIN_EMAILS = OWNER_EMAIL;
process.env.ADMIN_OWNER_EMAILS = OWNER_EMAIL;

const owner = (over: Record<string, unknown> = {}) => ({
  user: { id: OWNER_ID, email: OWNER_EMAIL, authenticatedAt: new Date().toISOString(), ...over },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
}) as Session;
const adminRequest = () => new Request("https://tomverse.test/api/admin/amux/ideas/card-close", {
  method: "POST", headers: { "user-agent": "synthetic-card-close" } });

const ON = { TOMVERSE_AMUX_CARD_CLOSE_DM: "enabled" };
const DAY_MS = 86_400_000;
const digest = "a".repeat(64);
const cipher = Buffer.from("synthetic-only", "utf8");

const resetAll = () => prisma.$executeRawUnsafe(
  `TRUNCATE TABLE "AmuxIdeaCardCloseQuestion", "AmuxDecisionMakerDeliveryEvent", "AmuxDecisionMakerJudgment", "AmuxDecisionMakerResultDetail", "AmuxDecisionMakerBody", "AmuxDecisionMakerRetentionEvent", "AmuxDecisionMakerDigestKeyEvent", "AmuxDecisionMakerRequestEvent", "AmuxDecisionMakerRequest", "AmuxDecisionMakerSwitchEvent" RESTART IDENTITY`);

const operator = () => ({ user: { id: `dm-operator-${randomUUID()}`, email: "operator@example.test" },
  expires: "2099-01-01T00:00:00.000Z" }) as Session;
const setSwitch = (scope: "kill_switch" | "decision-maker-openai" | "decision-maker-anthropic",
  value: "on" | "off" | "proposal") =>
  prisma.$transaction((tx) => recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope, value }));
const dbNowMs = async () => Number((await prisma.$queryRaw<Array<{ now: bigint }>>`
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "now"`)[0]!.now);

/** A change a worker's own path would make, past the guards its history would satisfy. */
const asReplica = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await work(tx);
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
  });

const KEY = Buffer.alloc(32, 7);
let RING = new Map<number, Buffer>();

beforeEach(async () => {
  await resetAll();
  await setSwitch("decision-maker-openai", "proposal");
  await setSwitch("decision-maker-anthropic", "proposal");
  const period = dmKeyPeriodOf(await dbNowMs());
  RING = new Map([[period, KEY]]);
  await prisma.$transaction((tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod: period, keyRing: RING }));
});

// A test's ideas leave the scan with it, so the next test asks only about its own.
const seededIdeas: string[] = [];
const everySeededIdea: string[] = [];
afterEach(async () => {
  if (seededIdeas.length === 0) return;
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxIdeaSubmission"
    SET "state" = 'cancelled', "cancelledAt" = "updatedAt" WHERE "id" = ANY(${seededIdeas})`);
  seededIdeas.length = 0;
});

/**
 * The seed bypasses the guards, so its rows are not ones a real history leaves
 * (an assignment id bound to nothing, a synthetic content key). The suites that
 * run after this file in the same database update and read such tables broadly,
 * so every row seeded here goes with the file.
 */
async function removeSeededRows() {
  if (everySeededIdea.length === 0) return;
  await asReplica(async (tx) => {
    const cards = (await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "registeredWorkItemId" AS "id" FROM "AmuxIdeaUnitDecision"
      WHERE "ideaId" = ANY(${everySeededIdea}) AND "registeredWorkItemId" IS NOT NULL`).map((row) => row.id);
    await tx.$executeRaw`DELETE FROM "AmuxWorkDependency"
      WHERE "taskId" = ANY(${cards}) OR "dependencyId" = ANY(${cards})`;
    await tx.$executeRaw`DELETE FROM "AmuxV22TaskQuestion" WHERE "taskId" = ANY(${cards})`;
    await tx.$executeRaw`DELETE FROM "AmuxExecutionAttempt" WHERE "taskId" = ANY(${cards})`;
    await tx.$executeRaw`DELETE FROM "AmuxHumanEscalation" WHERE "taskId" = ANY(${cards})`;
    await tx.$executeRaw`DELETE FROM "AmuxWorkItem" WHERE "id" = ANY(${cards})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaCardCloseQuestion" WHERE "ideaId" = ANY(${everySeededIdea})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaLaneAttempt" WHERE "ideaId" = ANY(${everySeededIdea})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaUnitDecision" WHERE "ideaId" = ANY(${everySeededIdea})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaDraftUnit" WHERE "ideaId" = ANY(${everySeededIdea})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaSubmission" WHERE "id" = ANY(${everySeededIdea})`;
  });
  everySeededIdea.length = 0;
}

after(async () => {
  await removeSeededRows();
  await resetAll();
  await prisma.$disconnect();
});

type CardSeed ={ cardType?: "task" | "story"; status: string; ageDays?: number; displayKey?: string;
  revision?: number; assigned?: boolean; receipt?: boolean };

// Oldest first in the scan, ahead of any idea another suite left in this database.
let seedClock = Date.parse("2001-01-01T00:00:00.000Z");
let keyCounter = 0;
const nextKey = () => {
  keyCounter += 1;
  return `AMUX-CC${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}-${String(100 + keyCounter)}`;
};

/** One idea with registered cards, its triggers off so a card can start in any status. */
async function seedIdea(cards: CardSeed[], input: { state?: string; actor?: string; proposed?: boolean } = {}) {
  const ideaId = randomUUID();
  seededIdeas.push(ideaId);
  everySeededIdea.push(ideaId);
  seedClock += 60_000;
  const submittedAt = new Date(seedClock);
  const completedAt = new Date(seedClock + 1_000);
  const cardIds: string[] = [];
  const displayKeys: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`
      INSERT INTO "AmuxIdeaSubmission" ("id", "requestId", "actorUserId", "state", "submittedAt",
        "analysisDeadlineAt", "analysisCompletedAt", "rawPurgeAfter", "updatedAt")
      VALUES (${ideaId}, ${randomUUID()}::uuid, ${input.actor ?? OWNER_ID}, ${input.state ?? "completed"},
        ${submittedAt}, ${new Date(seedClock + 7 * DAY_MS)}, ${completedAt}, ${completedAt}, ${completedAt})`;
    let unitIndex = 0;
    for (const seed of cards) {
      const cardType = seed.cardType ?? "task";
      const unitId = randomUUID();
      const decisionId = randomUUID();
      const cardId = randomUUID();
      const displayKey = seed.displayKey ?? nextKey();
      const preparedAt = new Date();
      const expiresAt = new Date(preparedAt.getTime() + 15 * 60_000);
      await tx.$executeRaw`
        INSERT INTO "AmuxIdeaDraftUnit" ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
          "unitKind", "state", "expiresAt", "finalDecisionAt", "bodyPurgeAfter", "bodyCiphertext", "bodyKeyId",
          "bodyKeyVersion", "bodyDigest", "bodyDigestKeyId", "updatedAt")
        VALUES (${unitId}, ${ideaId}, ${input.actor ?? OWNER_ID}, 0, ${unitIndex}, ${`c0:card-${unitIndex}`},
          'card', 'approved', ${new Date(preparedAt.getTime() + DAY_MS)}, ${preparedAt},
          ${new Date(preparedAt.getTime() + 30 * DAY_MS)}, ${cipher}, 'synthetic', 1, ${digest}, 'synthetic', ${preparedAt})`;
      unitIndex += 1;
      await tx.$executeRaw`
        INSERT INTO "AmuxIdeaUnitDecision" ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
          "prepareRequestId", "action", "state", "ownerSessionDigest", "ownerSessionDigestKeyId", "unitDigest",
          "unitDigestKeyId", "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
          "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId", "baseNodeId", "baseNodeRevision",
          "baseNodeDigest", "baseNodeDigestKeyId", "preparedAt", "expiresAt", "prepareAuditLogId",
          "consumeRequestId", "consumedAt", "registeredWorkItemId", "finalAuditLogId", "updatedAt")
        VALUES (${decisionId}, ${ideaId}, ${unitId}, ${input.actor ?? OWNER_ID}, 0, ${randomUUID()}::uuid,
          'register_card', 'consumed', ${digest}, 'synthetic', ${digest}, 'synthetic', ${digest}, 'synthetic',
          ${JSON.stringify({ card: { cardType, dependencies: [] } })}::jsonb, ${randomUUID()}, ${digest}, 'synthetic',
          ${randomUUID()}, 0, ${digest}, 'synthetic', ${preparedAt}, ${expiresAt}, ${randomUUID()},
          ${randomUUID()}::uuid, ${new Date(preparedAt.getTime() + 1_000)}, ${cardId}, ${randomUUID()}, ${preparedAt})`;
      const updatedAt = new Date(Date.now() - (seed.ageDays ?? 0) * DAY_MS);
      const snapshot = JSON.stringify({ schemaVersion: "amux-v4", ideaId, approvalId: decisionId });
      const terminal = seed.status === "done" ? new Date() : null;
      const assignment = seed.assigned ? randomUUID() : null;
      const receipt = seed.receipt || seed.assigned ? randomUUID() : null;
      const task = cardType === "task";
      await tx.$executeRaw`
        INSERT INTO "AmuxWorkItem" ("id", "title", "status", "owner", "claimedAt", "revision", "sourceSystem", "sourceKey",
          "sourceVersion", "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
          "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion", "v4TitleDigest", "v4TitleDigestKeyId",
          "v4BodyCiphertext", "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest", "v4BodyDigestKeyId",
          "v4BriefCiphertext", "v4BriefKeyId", "v4BriefKeyVersion", "v4BriefDigest", "v4BriefDigestKeyId",
          "v4SourceApprovalId", "v4TerminalAt", "v22ReceiptId", "v22AssignmentId", "taskRole", "executionGrade",
          "storyKind", "displayKey", "createdAt", "updatedAt")
        VALUES (${cardId}, ${task ? "AMUX Task" : "AMUX Story"}, ${seed.status},
          ${seed.assigned ? "claude-impl" : null}::text, ${seed.assigned ? new Date() : null}::timestamp,
          ${seed.revision ?? 3}, 'admin-idea-v4', ${unitId.toUpperCase()}, '1', ${digest}, ${snapshot}::jsonb,
          ${cardType}, ${randomUUID()}, ${cipher}, 'synthetic', 1, ${digest}, 'synthetic',
          ${cipher}, 'synthetic', 1, ${digest}, 'synthetic',
          ${task ? cipher : null}::bytea, ${task ? "synthetic" : null}::text, ${task ? 1 : null}::int,
          ${task ? digest : null}::text, ${task ? "synthetic" : null}::text,
          ${decisionId}, ${terminal}::timestamp, ${receipt}::uuid, ${assignment}::uuid,
          ${task ? "implement" : null}::text, ${task ? "advanced" : null}::text,
          ${task ? null : "general"}::text, ${displayKey}, ${updatedAt}, ${updatedAt})`;
      cardIds.push(cardId);
      displayKeys.push(displayKey);
    }
    if (input.proposed) {
      await tx.$executeRaw`
        INSERT INTO "AmuxIdeaDraftUnit" ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
          "unitKind", "state", "expiresAt", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion", "bodyDigest",
          "bodyDigestKeyId", "updatedAt")
        VALUES (${randomUUID()}, ${ideaId}, ${input.actor ?? OWNER_ID}, 0, 99, 'c0:card-99', 'card', 'proposed',
          ${new Date(Date.now() + 10 * DAY_MS)}, ${cipher}, 'synthetic', 1, ${digest}, 'synthetic', ${new Date()})`;
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
  }, { timeout: 30_000 });
  return { ideaId, cardIds, displayKeys };
}

type QuestionRow = { id: string; ideaId: string; state: string; reasonCode: string; cards: unknown;
  answerSource: string | null; answeredByUserId: string | null; answeredAt: Date | null; cancelReason: string | null;
  handoffReason: string | null; handoffAt: Date | null; localCardId: string | null; localCardClosedAt: Date | null };
const questionOf = async (ideaId: string) => (await prisma.$queryRaw<QuestionRow[]>`
  SELECT * FROM "AmuxIdeaCardCloseQuestion" WHERE "ideaId" = ${ideaId}
  ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`)[0] ?? null;
const questionCount = async () => (await prisma.$queryRaw<Array<{ count: number }>>`
  SELECT count(*)::int AS "count" FROM "AmuxIdeaCardCloseQuestion"`)[0]!.count;
const card = (id: string) => prisma.amuxWorkItem.findUniqueOrThrow({ where: { id }, select: {
  status: true, owner: true, claimedAt: true, revision: true, v4TerminalAt: true, updatedAt: true } });

/** Opens questions until the scan finds no more, so no other idea hides the one asked about. */
const drain = async (env: Record<string, string> = { ...ON, AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: "50" }) => {
  for (let round = 0; round < 60; round += 1) {
    if (!(await openAmuxIdeaCardCloseQuestionIfDue(env)).opened) return;
  }
  throw new Error("the scan did not end");
};

const CLOSE_OPTIONS = [
  { id: "close", label: "Close the remaining cards as cancelled" },
  { id: "keep", label: "Keep them and do not ask for 30 days" },
];
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Output = { kind: "select"; optionId: string; rationale: string; irreversible: boolean } |
  { kind: "free_text"; answer: string; rationale: string; irreversible: boolean };

/** What the bridge does with a pending entry: files it, records the card, routes it. */
async function fileToRelay(ideaId: string) {
  const question = (await questionOf(ideaId))!;
  const [entry] = amuxIdeaCardCloseRelayCards([question]);
  assert.ok(entry, "the row reads back as a relay entry");
  const cardId = `CC-${randomUUID().slice(0, 8)}`;
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
    (tx) => recordDmQuestionLocalCard(tx, { questionId: question.id, cardId }));
  const binding = { cardId, questionRevision: 1, askingWorkerId: entry.worker, amuxSessionId: entry.worker,
    amuxSessionAttempt: 0, askingProvider: entry.provider, termListVersion: "v1",
    classificationVersion: "authority-manifest-1", scannerVersion: "v1" };
  const dmCard = { askType: "decision", resolution: null, type: "task",
    tags: ["v22-question", `v22q-${question.id}`, `v22-provider-${entry.provider}`],
    title: entry.title, question: entry.question,
    options: entry.options.map((option) => ({ ...option, effect: "choice_only", paths: [] as string[] })),
    unblocks: entry.unblocks, context: "", contextPaths: [] as string[] };
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx,
    { binding, card: dmCard, keyRing: RING }));
  return { question, cardId, binding, routed };
}

async function proposed(ideaId: string, output: Output) {
  const { question, cardId, routed } = await fileToRelay(ideaId);
  assert.equal(routed.route, "dm_proposal", "the text the server writes reaches a DM");
  const instance = routed.instance!;
  const assigned = await prisma.$transaction((tx) => assignDecisionMakerRequestWithDigestKey(tx,
    { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: RING }));
  assert.equal(assigned.recorded, true);
  const requestKey = (assigned as { requestKey: Buffer }).requestKey;
  const transmission = { snapshotState: "worker_head", snapshotTargetSha: SHA,
    snapshotManifestDigest: dmSnapshotManifestDigest(requestKey, [{ path: "lib/cache.ts", blobId: "f".repeat(40) }]),
    inputPayloadDigest: dmBodyDigest(requestKey, "card_text", "payload") };
  await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx,
    { requestId: routed.requestId, instance, transmission, requireLeaseAt: () => {} }));
  const stored: Record<string, unknown> = { ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  const submitted = await prisma.$transaction((tx) => submitDecisionMakerOutput(tx, {
    requestId: routed.requestId, instance, binding: { ...stored, transmission },
    output: { kind: "output", raw: JSON.stringify(output), options: CLOSE_OPTIONS },
    requireLeaseAt: () => {}, keyRing: RING }));
  assert.equal(submitted.status === "submitted" && submitted.result.status, "accepted");
  return { question, cardId, requestId: routed.requestId };
}

const shownOf = async (requestId: string): Promise<DmShownProposal> => {
  const state = (await readDecisionMakerRequestState(prisma, requestId))!;
  const bodies = await readDecisionMakerBodies(prisma, requestId);
  const detail = (await readDecisionMakerResultDetail(prisma, requestId))!;
  const digestOf = (field: string) => bodies.find((body) => body.field === field)?.digest ?? null;
  return { answerDigest: detail.outputKind === "free_text" ? digestOf("dm_answer") : null,
    rationaleDigest: digestOf("dm_rationale")!, optionId: detail.optionId, irreversible: detail.irreversible!,
    snapshotState: state.transmission!.snapshotState, snapshotTargetSha: state.transmission!.snapshotTargetSha,
    snapshotManifestDigest: state.transmission!.snapshotManifestDigest };
};

const judge = async (requestId: string, kind: "confirm" | "edit_confirm" | "reject", operatorAnswer?: string) => {
  const input = kind === "reject" ? { kind } : kind === "confirm" ? { kind, shown: await shownOf(requestId) } :
    { kind, shown: await shownOf(requestId), operatorAnswer };
  const written = await prisma.$transaction((tx) =>
    recordDecisionMakerJudgment(tx, { session: operator(), requestId, keyRing: RING, ...input }));
  assert.equal(written.recorded, true, JSON.stringify(written));
};

const select = (optionId: "close" | "keep"): Output =>
  ({ kind: "select", optionId, rationale: "Nothing has moved.", irreversible: false });

/** Asks about this idea, files it, a DM proposes, and a person confirms. */
async function confirmed(ideaId: string, optionId: "close" | "keep") {
  await drain();
  const proposal = await proposed(ideaId, select(optionId));
  await judge(proposal.requestId, "confirm");
  return proposal;
}

const auditOf = (questionId: string) => prisma.adminAuditLog.findMany({
  where: { targetType: "AmuxIdeaCardCloseQuestion", targetId: questionId },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  select: { action: true, actorUserId: true, metadata: true, entryHash: true } });

const stageOf = async (ideaId: string, actor = OWNER_ID) =>
  (await readAmuxIdeaProgressForOwner(actor)).find((row) => row.ideaId === ideaId);

test("the switch off leaves no question and files none, whatever the ideas look like", async () => {
  const { ideaId } = await seedIdea([{ status: "blocked" }]);
  assert.deepEqual(await openAmuxIdeaCardCloseQuestionIfDue({}), { opened: false });
  assert.deepEqual(await openAmuxIdeaCardCloseQuestionIfDue({ TOMVERSE_AMUX_CARD_CLOSE_DM: "true" }),
    { opened: false });
  assert.equal(await questionCount(), 0);

  await drain();
  const open = (await questionOf(ideaId))!;
  assert.equal(open.state, "open");
  // Turned off with a question not yet filed: filing it is what starts a paid turn.
  const off = await readAmuxIdeaCardCloseSyncForRelay({});
  assert.deepEqual(off.pending, []);
  const on = await readAmuxIdeaCardCloseSyncForRelay(ON);
  assert.ok(on.pending.some((entry) => entry.question_id === open.id));
});

test("a blocked Task or unchanged cards are asked about; the question holds numbers and statuses", async () => {
  const blocked = await seedIdea([
    { status: "blocked" }, { status: "backlog" }, { status: "done" },
    { cardType: "story", status: "backlog" }]);
  const stale = await seedIdea([{ status: "backlog", ageDays: 8 }, { status: "backlog", ageDays: 9 }]);
  await drain();
  const first = (await questionOf(blocked.ideaId))!;
  assert.equal(first.state, "open");
  assert.equal(first.reasonCode, "blocked_task");
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the local AMUX files only this");
  const asked = first.cards as Array<{ id: string; displayKey: string; status: string; cardType: string }>;
  assert.deepEqual(new Set(asked.map((entry) => entry.status)), new Set(["blocked", "backlog"]));
  assert.equal(asked.length, 3, "the finished card is not among them");
  for (const entry of asked) {
    assert.deepEqual(Object.keys(entry).sort(), entry.status === "blocked" ?
      ["blockReason", "cardType", "displayKey", "id", "status", "updatedAtMs"] :
      ["cardType", "displayKey", "id", "status", "updatedAtMs"]);
  }
  assert.equal((await questionOf(stale.ideaId))!.reasonCode, "stale_cards");
  const audit = await auditOf(first.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "amux.idea.card_close.asked");
  assert.ok(audit[0].entryHash, "on the canonical chain");
  assert.equal(audit[0].actorUserId, null);
  // Nothing moved by asking.
  assert.equal((await card(blocked.cardIds[0])).status, "blocked");
  assert.equal((await card(blocked.cardIds[1])).revision, 3);
});

test("the question says why a blocked Task is blocked and how long the cards have not changed", async () => {
  const { ideaId, cardIds, displayKeys } = await seedIdea([
    { status: "blocked", ageDays: 7 }, { status: "blocked", ageDays: 9 }, { status: "backlog", ageDays: 10 }]);
  // The first: its last attempt ended with an unknown result and cost, as STARTERCHK-001's did.
  // The second: an open review's reason comes before its attempt's.
  await asReplica(async (tx) => {
    const now = new Date();
    for (const [taskId, reason] of [[cardIds[0], "usage_outcome_unknown"], [cardIds[1], "outcome_unknown"]]) {
      await tx.$executeRaw`
        INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
          "taskRevision", "attemptNumber", "heartbeatAt", "startedAt", "endedAt", "outcome", "toStatus", "endedBy",
          "reason", "updatedAt")
        VALUES (${randomUUID()}, ${taskId}, 'claude-impl', 'fixture-instance', 1, 3, 1, ${now}, ${now}, ${now},
          'failed', 'blocked', 'claude-impl', ${reason}, ${now})`;
    }
  });
  await prisma.amuxHumanEscalation.create({ data: { taskId: cardIds[1], specialty: "execution-recovery",
    reason: "human_review_required", openedBy: "tomverse-amux-orchestrator", openedTaskRevision: 3 } });
  await drain();
  const question = (await questionOf(ideaId))!;
  const asked = question.cards as Array<{ id: string; blockReason?: string | null; updatedAtMs: number }>;
  const byId = new Map(asked.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(cardIds[0])?.blockReason, "usage_outcome_unknown");
  assert.equal(byId.get(cardIds[1])?.blockReason, "human_review_required");
  assert.equal("blockReason" in byId.get(cardIds[2])!, false, "only a blocked card says why");
  for (const entry of asked) assert.equal(typeof entry.updatedAtMs, "number");

  // The relay's tick renders it on the database clock.
  const relay = (await readAmuxIdeaCardCloseSyncForRelay(ON)).pending.find((entry) => entry.question_id === question.id)!;
  assert.ok(relay.question.includes(
    `${displayKeys[0]} (task, blocked: the run's result and cost are unknown; unchanged for 7 days)`), relay.question);
  assert.ok(relay.question.includes(
    `${displayKeys[1]} (task, blocked: a person was asked to review it; unchanged for 9 days)`), relay.question);
  assert.ok(relay.question.includes(`${displayKeys[2]} (task, backlog; unchanged for 10 days)`), relay.question);
  assert.ok(relay.question.includes("None of its remaining cards has changed for 7 days."), relay.question);
  assert.ok(!relay.question.includes("usage_outcome_unknown"), "never the code itself");

  // It still reaches a DM, and a close applies to exactly the cards asked about.
  const proposal = await proposed(ideaId, select("close"));
  await judge(proposal.requestId, "confirm");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "closed");
  assert.equal((await questionOf(ideaId))!.state, "closed");
  for (const id of cardIds) assert.equal((await card(id)).status, "cancelled");
});

test("a question written before the reasons and dates is filed and answered as it was", async () => {
  const { ideaId, cardIds, displayKeys } = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await drain();
  const question = (await questionOf(ideaId))!;
  const old = (question.cards as Array<Record<string, unknown>>).map(({ id, displayKey, cardType, status }) =>
    ({ id, displayKey, cardType, status }));
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxIdeaCardCloseQuestion"
    SET "cards" = ${JSON.stringify(old)}::jsonb WHERE "id" = ${question.id}`);
  const relay = (await readAmuxIdeaCardCloseSyncForRelay(ON)).pending.find((entry) => entry.question_id === question.id)!;
  assert.ok(relay.question.includes(`${displayKeys[0]} (task, blocked)\n`), relay.question);
  assert.doesNotMatch(relay.question, /unchanged|None of its remaining cards/);
  const view = await readAmuxIdeaCardCloseQuestionForOwner({ ideaId, actorUserId: OWNER_ID });
  assert.deepEqual(view?.cards.map((entry) => entry.id).sort(), [...cardIds].sort());
  const proposal = await proposed(ideaId, select("close"));
  await judge(proposal.requestId, "confirm");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "closed");
  assert.equal((await questionOf(ideaId))!.state, "closed");
  for (const id of cardIds) assert.equal((await card(id)).status, "cancelled");
});

test("an idea with anything moving, finished, or waiting elsewhere is not asked about", async () => {
  const recent = await seedIdea([{ status: "backlog", ageDays: 1 }]);
  const doing = await seedIdea([{ status: "blocked" }, { status: "review", receipt: true }]);
  const assigned = await seedIdea([{ status: "blocked" }, { status: "todo", assigned: true }]);
  const finished = await seedIdea([{ status: "done" }, { status: "cancelled" }]);
  const cancelled = await seedIdea([{ status: "blocked" }]);
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxIdeaSubmission" SET "state" = 'cancelled',
    "cancelledAt" = "updatedAt" WHERE "id" = ${cancelled.ideaId}`);
  const storiesOnly = await seedIdea([{ cardType: "story", status: "blocked" }]);
  const planWaits = await seedIdea([{ status: "blocked" }], { state: "awaiting_owner", proposed: true });
  const planDone = await seedIdea([{ status: "blocked" }], { state: "completed", proposed: true });
  const lane = await seedIdea([{ status: "blocked" }]);
  await prisma.amuxIdeaLaneAttempt.create({ data: { id: randomUUID(), ideaId: lane.ideaId,
    claimedAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) } });
  const running = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await asReplica((tx) => tx.$executeRaw`
    INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
      "taskRevision", "attemptNumber", "heartbeatAt", "leaseExpiresAt", "startedAt", "updatedAt")
    VALUES (${randomUUID()}, ${running.cardIds[1]}, 'claude-impl', 'fixture-instance', 1, 3, 1,
      ${new Date()}, ${new Date(Date.now() + 60_000)}, ${new Date()}, ${new Date()})`);
  const asking = await seedIdea([{ status: "blocked" }]);
  await asReplica(async (tx) => {
    const attemptId = randomUUID();
    const now = new Date();
    await tx.$executeRaw`
      INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
        "taskRevision", "attemptNumber", "heartbeatAt", "startedAt", "endedAt", "outcome", "toStatus", "endedBy",
        "reason", "updatedAt")
      VALUES (${attemptId}, ${asking.cardIds[0]}, 'claude-impl', 'fixture-instance', 1, 3, 1, ${now}, ${now}, ${now},
        'succeeded', 'blocked', 'claude-impl', 'owner_question', ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxV22TaskQuestion" ("id", "taskId", "attemptId", "worker", "sequence", "questionSha256", "updatedAt")
      VALUES (${randomUUID()}, ${asking.cardIds[0]}, ${attemptId}, 'claude-impl', 1, ${digest}, ${now})`;
  });
  const dependedOn = await seedIdea([{ status: "blocked" }]);
  const dependent = await seedIdea([{ status: "backlog", ageDays: 1 }]);
  await asReplica((tx) => tx.$executeRaw`
    INSERT INTO "AmuxWorkDependency" ("taskId", "dependencyId") VALUES (${dependent.cardIds[0]}, ${dependedOn.cardIds[0]})`);

  await drain();
  for (const [name, seeded] of Object.entries({ recent, doing, assigned, finished, cancelled, storiesOnly, planWaits,
    lane, running, asking, dependedOn })) {
    assert.equal(await questionOf(seeded.ideaId), null, name);
  }
  assert.equal((await questionOf(planDone.ideaId))?.state, "open", "a completed idea leaves its proposals behind");
});

test("ideas that can never be asked about do not hide a later one from the scan's bound", async () => {
  const seedDependedOn = async () => {
    const seeded = await seedIdea([{ status: "blocked" }]);
    const other = await seedIdea([{ status: "backlog", ageDays: 1 }]);
    await asReplica((tx) => tx.$executeRaw`
      INSERT INTO "AmuxWorkDependency" ("taskId", "dependencyId") VALUES (${other.cardIds[0]}, ${seeded.cardIds[0]})`);
  };
  const seedLiveAttempt = async () => {
    const seeded = await seedIdea([{ status: "blocked" }]);
    await asReplica((tx) => tx.$executeRaw`
      INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
        "taskRevision", "attemptNumber", "heartbeatAt", "leaseExpiresAt", "startedAt", "updatedAt")
      VALUES (${randomUUID()}, ${seeded.cardIds[0]}, 'claude-impl', 'fixture-instance', 1, 3, 1,
        ${new Date()}, ${new Date(Date.now() + 60_000)}, ${new Date()}, ${new Date()})`);
  };
  const seedWorkerQuestion = async () => {
    const seeded = await seedIdea([{ status: "blocked" }]);
    await asReplica(async (tx) => {
      const attemptId = randomUUID();
      const now = new Date();
      await tx.$executeRaw`
        INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
          "taskRevision", "attemptNumber", "heartbeatAt", "startedAt", "endedAt", "outcome", "toStatus", "endedBy",
          "reason", "updatedAt")
        VALUES (${attemptId}, ${seeded.cardIds[0]}, 'claude-impl', 'fixture-instance', 1, 3, 1, ${now}, ${now}, ${now},
          'succeeded', 'blocked', 'claude-impl', 'owner_question', ${now})`;
      await tx.$executeRaw`
        INSERT INTO "AmuxV22TaskQuestion" ("id", "taskId", "attemptId", "worker", "sequence", "questionSha256", "updatedAt")
        VALUES (${randomUUID()}, ${seeded.cardIds[0]}, ${attemptId}, 'claude-impl', 1, ${digest}, ${now})`;
    });
  };
  const seedAssigned = () => seedIdea([{ status: "blocked" }, { status: "todo", assigned: true }]);
  // Each kind passes the blocked-Task test, is refused only for what else it holds, and stays old.
  const kinds = [seedAssigned, seedLiveAttempt, seedWorkerQuestion, seedDependedOn];
  for (let index = 0; index <= AMUX_IDEA_CARD_CLOSE_SCAN; index += 1) await kinds[index % kinds.length]();
  const later = await seedIdea([{ status: "blocked" }]);
  assert.deepEqual(await openAmuxIdeaCardCloseQuestionIfDue(ON),
    { opened: true, questionId: (await questionOf(later.ideaId))?.id, ideaId: later.ideaId });
});

test("one question per call, up to the day's limit", async () => {
  const seeded = [await seedIdea([{ status: "blocked" }]), await seedIdea([{ status: "blocked" }]),
    await seedIdea([{ status: "blocked" }])];
  const env = { ...ON, AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: "2" };
  const first = await openAmuxIdeaCardCloseQuestionIfDue(env);
  assert.equal(first.opened, true);
  assert.equal(await questionCount(), 1, "one per call");
  assert.equal((await openAmuxIdeaCardCloseQuestionIfDue(env)).opened, true);
  assert.equal(await questionCount(), 2);
  assert.deepEqual(await openAmuxIdeaCardCloseQuestionIfDue(env), { opened: false }, "the day's limit");
  assert.equal(await questionCount(), 2);
  assert.ok(await questionOf(seeded[0].ideaId), "oldest first");
  assert.ok(await questionOf(seeded[1].ideaId));
  assert.equal(await questionOf(seeded[2].ideaId), null);
  // The default is five.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxIdeaCardCloseQuestion"`);
  for (let index = 0; index < 4; index += 1) await seedIdea([{ status: "blocked" }]);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await openAmuxIdeaCardCloseQuestionIfDue(ON)).opened, true, `call ${index}`);
  }
  assert.deepEqual(await openAmuxIdeaCardCloseQuestionIfDue(ON), { opened: false });
  assert.equal(await questionCount(), 5);
  // Past 24 hours the limit is spent no more.
  await asReplica((tx) => tx.$executeRaw`
    UPDATE "AmuxIdeaCardCloseQuestion" SET "createdAt" = "createdAt" - INTERVAL '25 hours'`);
  assert.equal((await openAmuxIdeaCardCloseQuestionIfDue(ON)).opened, true);
});

test("a confirmed close cancels the remaining cards, shows the idea cancelled, and is never delivered to a worker", async () => {
  const { ideaId, cardIds } = await seedIdea([
    { status: "blocked", revision: 4 }, { status: "backlog", revision: 2 },
    { status: "todo", receipt: true, revision: 6 }, { cardType: "story", status: "backlog", revision: 1 }]);
  const openEscalation = await prisma.amuxHumanEscalation.create({ data: { taskId: cardIds[0],
    specialty: "execution-recovery", reason: "execution_blocked", openedBy: "tomverse-amux-orchestrator",
    openedTaskRevision: 4 } });
  const before = await stageOf(ideaId);
  assert.equal(before?.stage, "execution");
  const { question, cardId, requestId } = await confirmed(ideaId, "close");

  // §2-10: a confirmed answer is applied in the app; the delivery walk steps past it.
  const offered = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryCandidateRead,
    (tx) => readDecisionMakerDeliveryCandidate(tx, { after: null }));
  assert.equal(offered.status, "undeliverable");
  assert.equal("reason" in offered && offered.reason, "v22_question_card");
  assert.ok(!("message" in offered));
  assert.equal(await isAmuxV22QuestionCard(prisma, cardId), true);
  assert.equal(await isAmuxV22QuestionCard(prisma, "CC-not-a-question"), false);

  const step = await runAmuxV22ResolveStep(null);
  assert.equal(step.resolved, "closed");
  assert.equal(step.cursor.move, "advance");

  const closed = (await questionOf(ideaId))!;
  assert.equal(closed.state, "closed");
  assert.equal(closed.answerSource, "dm_confirmed");
  assert.equal(closed.answeredByUserId, null);
  assert.ok(closed.answeredAt);
  for (const [index, revision] of [4, 2, 6, 1].entries()) {
    const after = await card(cardIds[index]);
    assert.equal(after.status, "cancelled", `card ${index}`);
    assert.equal(after.owner, null);
    assert.equal(after.claimedAt, null);
    assert.equal(after.revision, revision + 1);
    assert.ok(after.v4TerminalAt, "terminal on the clock, for retention");
  }
  const resolved = await prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id: openEscalation.id } });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolutionOutcome, "block");
  assert.equal(resolved.resolvedById, "amux-idea-card-close");
  const audit = await auditOf(question.id);
  assert.deepEqual(audit.map((entry) => entry.action),
    ["amux.idea.card_close.asked", "amux.idea.card_close.closed"]);
  const metadata = audit[1].metadata as Record<string, unknown>;
  assert.equal(metadata.requestId, requestId);
  assert.equal(metadata.escalationsResolved, 1);
  assert.equal((metadata.cardIds as string[]).length, 4);

  // The database admits the later purge of a closed card's brief: it needs a
  // terminal time, and only that time. An unclosed card refuses the same write.
  const purge = (id: string) => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "AmuxWorkItem" SET "v4BriefCiphertext" = NULL, "v4BriefKeyId" = NULL,
      "v4BriefKeyVersion" = NULL, "v4BriefPurgedAt" = (clock_timestamp() AT TIME ZONE 'UTC') WHERE "id" = ${id}`;
    throw new Error("rolled back on purpose");
  });
  await assert.rejects(purge(cardIds[0]), /rolled back on purpose/);
  const unclosed = await seedIdea([{ status: "backlog", ageDays: 1 }]);
  await assert.rejects(purge(unclosed.cardIds[0]), /AmuxWorkItem_v4_key_pair_check/);

  // The progress read counts it as closed work, not finished work.
  const after = await stageOf(ideaId);
  assert.equal(after?.stage, "cancelled");
  assert.deepEqual(after?.tasks, { total: 3, done: 0, inReview: 0 });
  assert.ok(after?.taskRows.every((row) => row.merged === false && row.status === "cancelled"));

  // The relay closes the local card, once; and nothing asks about this idea again.
  const sync = await readAmuxIdeaCardCloseSyncForRelay(ON);
  assert.deepEqual(sync.closing, [{ questionId: question.id, cardId }]);
  const close = () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
    (tx, context) => recordDmQuestionLocalCardClosed(tx, { questionId: question.id, cardId, now: context.dbNow }));
  await close();
  await close();
  assert.deepEqual((await readAmuxIdeaCardCloseSyncForRelay(ON)).closing, []);
  assert.ok((await questionOf(ideaId))!.localCardClosedAt);
  await drain();
  assert.equal((await questionOf(ideaId))!.id, question.id, "no new question");
  // A walk from the start again steps past it.
  const again = await runAmuxV22ResolveStep(null);
  assert.equal(again.resolved, null);
});

test("a merged Task stays done and the idea shows done, not cancelled", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "done", receipt: true }, { status: "blocked" }]);
  await confirmed(ideaId, "close");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "closed");
  assert.equal((await card(cardIds[0])).status, "done");
  assert.equal((await card(cardIds[0])).revision, 3, "a finished card is not touched");
  assert.equal((await card(cardIds[1])).status, "cancelled");
  const row = await stageOf(ideaId);
  assert.equal(row?.stage, "done");
  assert.deepEqual(row?.tasks, { total: 2, done: 1, inReview: 0 });
});

test("keep records the answer, moves nothing, and asks again only after 30 days", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  const { question, cardId } = await confirmed(ideaId, "keep");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "kept");
  const kept = (await questionOf(ideaId))!;
  assert.equal(kept.state, "kept");
  assert.equal(kept.answerSource, "dm_confirmed");
  assert.equal((await card(cardIds[0])).status, "blocked");
  assert.equal((await card(cardIds[1])).revision, 3);
  assert.deepEqual((await auditOf(question.id)).map((entry) => entry.action),
    ["amux.idea.card_close.asked", "amux.idea.card_close.kept"]);
  assert.deepEqual((await readAmuxIdeaCardCloseSyncForRelay(ON)).closing, [{ questionId: question.id, cardId }]);

  await drain();
  assert.equal((await questionOf(ideaId))!.id, question.id, "not asked again");
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxIdeaCardCloseQuestion"
    SET "answeredAt" = "answeredAt" - INTERVAL '29 days' WHERE "id" = ${question.id}`);
  await drain();
  assert.equal((await questionOf(ideaId))!.id, question.id, "still inside the 30 days");
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxIdeaCardCloseQuestion"
    SET "answeredAt" = "answeredAt" - INTERVAL '2 days' WHERE "id" = ${question.id}`);
  await drain();
  const next = (await questionOf(ideaId))!;
  assert.notEqual(next.id, question.id, "asked again after them");
  assert.equal(next.state, "open");
});

/** What the page does: read what a direct close would close, then send those cards. */
const closeDirectly = async (ideaId: string, over: Record<string, unknown> = {}) => {
  const shown = (await readAmuxIdeaCardCloseOwnerState({ ideaId, actorUserId: OWNER_ID })).direct?.cards
    .map((entry) => entry.id) ?? ["nothing-shown"];
  return closeAmuxIdeaCardsDirectlyForOwner({ session: owner(), request: adminRequest(), ideaId, cardIds: shown,
    reason: "Stalled for good, secret note.", ...over } as never);
};

test("a direct close closes only the cards the owner was shown", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  const before = await questionCount();
  // A card registered after the page read is not among those shown; one finished since is.
  for (const cardIdsShown of [[cardIds[0]], [...cardIds, randomUUID()], [cardIds[0], cardIds[0]]]) {
    assert.equal((await closeDirectly(ideaId, { cardIds: cardIdsShown })).outcome, "not_closable",
      JSON.stringify(cardIdsShown));
  }
  assert.equal(await questionCount(), before, "no row for a refused close");
  for (const id of cardIds) assert.equal((await card(id)).status, ["blocked", "backlog"][cardIds.indexOf(id)]);
  assert.equal((await closeDirectly(ideaId, { cardIds: [...cardIds].reverse() })).outcome, "closed",
    "the same cards in any order");
});

test("the owner closes a kept idea's cards directly, with no question open, through the one apply", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }, { status: "backlog" },
    { cardType: "story", status: "backlog" }]);
  const { question } = await confirmed(ideaId, "keep");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "kept");
  const escalation = await prisma.amuxHumanEscalation.create({ data: { taskId: cardIds[0],
    specialty: "execution-recovery", reason: "usage_outcome_unknown", openedBy: "tomverse-amux-orchestrator",
    openedTaskRevision: 3 } });

  // The kept idea is not asked about again, but the owner sees what a direct close would close.
  await drain();
  assert.equal((await questionOf(ideaId))!.id, question.id);
  const state = await readAmuxIdeaCardCloseOwnerState({ ideaId, actorUserId: OWNER_ID });
  assert.equal(state.question, null);
  assert.equal(state.direct?.reasonCode, "blocked_task");
  assert.deepEqual(state.direct?.cards.map((entry) => entry.id).sort(), [...cardIds].sort());
  assert.deepEqual(await readAmuxIdeaCardCloseOwnerState({ ideaId, actorUserId: "someone-else" }),
    { question: null, direct: null }, "another owner's idea reads as neither");

  await assert.rejects(closeDirectly(ideaId, { reason: "no" }), /invalid/);
  await assert.rejects(closeDirectly(ideaId, { session: owner({
    authenticatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }) }), /Sign in again/);
  assert.equal((await card(cardIds[0])).status, "blocked", "nothing moved by a refusal");

  const result = await closeDirectly(ideaId);
  assert.equal(result.outcome, "closed");
  assert.equal(result.outcome === "closed" && result.closedCards, 3);
  for (const id of cardIds) {
    const after = await card(id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.revision, 4);
    assert.ok(after.v4TerminalAt);
  }
  const resolved = await prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id: escalation.id } });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedById, OWNER_ID);
  const row = (await questionOf(ideaId))!;
  assert.notEqual(row.id, question.id, "its own row in the one table");
  assert.equal(row.state, "closed");
  assert.equal(row.answerSource, "operator");
  assert.equal(row.answeredByUserId, OWNER_ID);
  assert.equal(row.localCardId, null, "filed to no one");
  const audit = await auditOf(row.id);
  assert.deepEqual(audit.map((entry) => entry.action), ["amux.idea.card_close.closed"]);
  assert.equal(audit[0].actorUserId, OWNER_ID, "a person's entry");
  assert.ok(audit[0].entryHash);
  const metadata = audit[0].metadata as Record<string, unknown>;
  assert.equal(metadata.direct, true);
  assert.match(String(metadata.reasonDigest), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(metadata).includes("secret note"));
  assert.equal((await stageOf(ideaId))?.stage, "cancelled", "every card closed: the idea shows cancelled");
  assert.deepEqual((await readAmuxIdeaCardCloseSyncForRelay(ON)).pending
    .filter((entry) => entry.question_id === row.id), [], "never filed to the relay");
  assert.equal((await closeDirectly(ideaId)).outcome, "not_closable", "nothing left to close");
});

test("a direct close needs no question and takes no place in the day's limit", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "backlog", ageDays: 9 }]);
  // Off: the switch holds back only the paid question.
  assert.equal((await readAmuxIdeaCardCloseOwnerState({ ideaId, actorUserId: OWNER_ID }, {})).direct?.reasonCode,
    "stale_cards");
  assert.equal((await closeDirectly(ideaId)).outcome, "closed");
  assert.equal((await card(cardIds[0])).status, "cancelled");

  const next = await seedIdea([{ status: "blocked" }]);
  await drain({ ...ON, AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: String(await questionCount()) });
  assert.equal((await questionOf(next.ideaId))?.state, "open",
    "the direct close's row is not one of the day's questions");
});

test("a direct close refuses what a question would not ask about, and leaves an open question to be answered", async () => {
  const running = await seedIdea([{ status: "blocked" }, { status: "review", receipt: true }]);
  const assigned = await seedIdea([{ status: "blocked" }, { status: "todo", assigned: true }]);
  const recent = await seedIdea([{ status: "backlog", ageDays: 1 }]);
  const finished = await seedIdea([{ status: "done" }]);
  const theirs = await seedIdea([{ status: "blocked" }], { actor: `card-close-other-${randomUUID()}` });
  const live = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await asReplica((tx) => tx.$executeRaw`
    INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
      "taskRevision", "attemptNumber", "heartbeatAt", "leaseExpiresAt", "startedAt", "updatedAt")
    VALUES (${randomUUID()}, ${live.cardIds[1]}, 'claude-impl', 'fixture-instance', 1, 3, 1,
      ${new Date()}, ${new Date(Date.now() + 60_000)}, ${new Date()}, ${new Date()})`);
  const dependedOn = await seedIdea([{ status: "blocked" }]);
  const dependent = await seedIdea([{ status: "backlog", ageDays: 1 }]);
  await asReplica((tx) => tx.$executeRaw`
    INSERT INTO "AmuxWorkDependency" ("taskId", "dependencyId") VALUES (${dependent.cardIds[0]}, ${dependedOn.cardIds[0]})`);
  for (const seeded of [running, assigned, recent, finished, theirs, live, dependedOn]) {
    assert.equal((await readAmuxIdeaCardCloseOwnerState({ ideaId: seeded.ideaId, actorUserId: OWNER_ID })).direct,
      null, seeded.ideaId);
    assert.equal((await closeDirectly(seeded.ideaId)).outcome, "not_closable", seeded.ideaId);
  }
  assert.equal((await card(running.cardIds[0])).status, "blocked");
  assert.equal((await card(dependedOn.cardIds[0])).status, "blocked");

  const asked = await seedIdea([{ status: "blocked" }]);
  await drain();
  const open = (await questionOf(asked.ideaId))!;
  assert.equal(open.state, "open");
  const state = await readAmuxIdeaCardCloseOwnerState({ ideaId: asked.ideaId, actorUserId: OWNER_ID });
  assert.equal(state.question?.questionId, open.id, "the open question is what the detail shows");
  assert.equal(state.direct, null);
  assert.equal((await closeDirectly(asked.ideaId)).outcome, "not_closable");
  assert.equal((await questionOf(asked.ideaId))!.id, open.id, "no second row");
});

test("work that started before the answer is applied closes nothing and cancels the question", async () => {
  const started = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  const { question } = await confirmed(started.ideaId, "close");
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'review', "revision" = 9
    WHERE "id" = ${started.cardIds[1]}`);
  const step = await runAmuxV22ResolveStep(null);
  assert.equal(step.resolved, "cancelled");
  const cancelled = (await questionOf(started.ideaId))!;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.cancelReason, "work_started");
  assert.equal((await card(started.cardIds[0])).status, "blocked", "nothing closed");
  assert.equal((await card(started.cardIds[1])).status, "review");
  const audit = await auditOf(question.id);
  assert.equal(audit.at(-1)?.action, "amux.idea.card_close.cancelled");
  assert.equal((audit.at(-1)?.metadata as Record<string, unknown>).reason, "work_started");

  // A claim holding a worker is the same, as a card added after the question.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxDecisionMakerDeliveryEvent", "AmuxDecisionMakerJudgment"`);
  const assigned = await seedIdea([{ status: "todo", receipt: true, ageDays: 8 }]);
  await drain();
  const before = (await questionOf(assigned.ideaId))!;
  const { requestId } = await proposed(assigned.ideaId, select("close"));
  await judge(requestId, "confirm");
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "owner" = 'claude-impl', "claimedAt" = ${new Date()},
    "v22AssignmentId" = ${randomUUID()}::uuid, "revision" = 9 WHERE "id" = ${assigned.cardIds[0]}`);
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "cancelled");
  assert.equal((await questionOf(assigned.ideaId))!.id, before.id);
  assert.equal((await questionOf(assigned.ideaId))!.cancelReason, "work_started");
  assert.equal((await card(assigned.cardIds[0])).status, "todo");

  // A question that closed with no effect is not asked again the same day.
  await drain();
  assert.equal((await questionOf(assigned.ideaId))!.id, before.id);
});

test("under the kill switch a confirmed answer is not applied and the walk keeps its place", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }]);
  const { question, requestId } = await confirmed(ideaId, "close");
  await setSwitch("kill_switch", "on");
  assert.deepEqual(await runAmuxV22ResolveStep(null), { resolved: null, cursor: { move: "keep" } });
  assert.equal((await questionOf(ideaId))!.state, "open");
  assert.equal((await card(cardIds[0])).status, "blocked");
  // The check under the audit chain lock, for a switch turned on after the read.
  const applied = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseApply,
    (tx, context) => applyAmuxIdeaCardCloseDmAnswer(tx, { questionId: question.id, requestId,
      decision: "close", now: context.dbNow }));
  assert.deepEqual(applied, { applied: false });
  assert.equal((await card(cardIds[0])).status, "blocked");
  // No new question either.
  const other = await seedIdea([{ status: "blocked" }]);
  await drain();
  assert.equal(await questionOf(other.ideaId), null);

  await setSwitch("kill_switch", "off");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "closed");
  assert.equal((await card(cardIds[0])).status, "cancelled");
});

test("an answer that says neither close nor keep changes nothing and goes to the owner", async () => {
  const edited = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await drain();
  const { question, requestId } = await proposed(edited.ideaId, select("close"));
  await judge(requestId, "edit_confirm", "Close the blocked one and leave the other.");
  const step = await runAmuxV22ResolveStep(null);
  assert.equal(step.resolved, null);
  assert.equal(step.cursor.move, "advance");
  const left = (await questionOf(edited.ideaId))!;
  assert.equal(left.state, "open");
  assert.equal(left.handoffReason, "answer_unreadable");
  assert.ok(left.handoffAt);
  assert.equal((await card(edited.cardIds[0])).status, "blocked");
  assert.equal((await card(edited.cardIds[1])).revision, 3);
  // A later walk records nothing more.
  await runAmuxV22ResolveStep(null);
  const actions = (await auditOf(question.id)).map((entry) => entry.action);
  assert.deepEqual(actions, ["amux.idea.card_close.asked", "amux.idea.card_close.handed_off"]);
  // The owner's panel sees it and can answer it.
  const view = await readAmuxIdeaCardCloseQuestionForOwner({ ideaId: edited.ideaId, actorUserId: OWNER_ID });
  assert.equal(view?.handedOff, true);
  const answered = await answerAmuxIdeaCardCloseForOwner({ session: owner(), request: adminRequest(),
    ideaId: edited.ideaId, questionId: question.id, decision: "keep", reason: "Still wanted." });
  assert.equal(answered.outcome, "kept");

  // A free-text answer that is one of the words is an answer.
  const worded = await seedIdea([{ status: "blocked" }]);
  await drain();
  const free = await proposed(worded.ideaId, { kind: "free_text", answer: " close ", rationale: "Nothing moved.",
    irreversible: false });
  await judge(free.requestId, "confirm");
  const steps = await runAmuxV22ResolveStep(null);
  assert.equal(steps.cursor.move, "advance");
  // The first confirmation in the walk may be the earlier one; walk on from it.
  const next = steps.cursor.move === "advance" ? await runAmuxV22ResolveStep(
    { judgedAtMs: steps.cursor.judgedAtMs, requestId: steps.cursor.requestId }) : steps;
  assert.ok(steps.resolved === "closed" || next.resolved === "closed");
  assert.equal((await card(worded.cardIds[0])).status, "cancelled");
});

test("the owner answers directly, with a person's audit, whatever the router or the kill switch did", async () => {
  // A card's own number hits the term list: no DM, the question stays with the operator.
  // Unique per run, so a database another run left behind holds no such key.
  const routedAway = await seedIdea([{ status: "blocked", displayKey: `AMUX-PROD-${randomInt(100, 1_000_000)}` },
    { status: "backlog" }]);
  await drain();
  const { question, routed } = await fileToRelay(routedAway.ideaId);
  assert.equal(routed.route, "operator");
  await setSwitch("kill_switch", "on");

  const view = await readAmuxIdeaCardCloseQuestionForOwner({ ideaId: routedAway.ideaId, actorUserId: OWNER_ID });
  assert.equal(view?.questionId, question.id);
  assert.equal(view?.reasonCode, "blocked_task");
  assert.equal(view?.handedOff, false);
  assert.deepEqual(view?.cards.map((entry) => entry.displayKey).sort(),
    [...routedAway.displayKeys].sort());
  assert.equal(await readAmuxIdeaCardCloseQuestionForOwner({ ideaId: routedAway.ideaId, actorUserId: "someone-else" }), null);

  const answer = (over: Record<string, unknown> = {}) => answerAmuxIdeaCardCloseForOwner({
    session: owner(), request: adminRequest(), ideaId: routedAway.ideaId, questionId: question.id,
    decision: "close", reason: "No longer wanted, secret note.", ...over } as never);
  await assert.rejects(answer({ reason: "no" }), /invalid/, "a reason is required");
  await assert.rejects(answer({ session: owner({ authenticatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }) }),
    /Sign in again/, "recent re-authentication");
  await assert.rejects(answer({ session: { user: { id: "not-an-admin", email: "x@example.test" },
    expires: new Date(Date.now() + 60_000).toISOString() } }), /forbidden/);
  assert.equal((await questionOf(routedAway.ideaId))!.state, "open");

  const result = await answer();
  assert.equal(result.outcome, "closed");
  assert.equal(result.outcome === "closed" && result.closedCards, 2);
  const closed = (await questionOf(routedAway.ideaId))!;
  assert.equal(closed.state, "closed");
  assert.equal(closed.answerSource, "operator");
  assert.equal(closed.answeredByUserId, OWNER_ID);
  assert.equal((await card(routedAway.cardIds[0])).status, "cancelled");
  assert.ok((await card(routedAway.cardIds[0])).v4TerminalAt);
  const audit = (await auditOf(question.id)).at(-1)!;
  assert.equal(audit.action, "amux.idea.card_close.closed");
  assert.equal(audit.actorUserId, OWNER_ID, "a person's entry");
  assert.ok(audit.entryHash);
  const metadata = audit.metadata as Record<string, unknown>;
  assert.match(String(metadata.reasonDigest), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(metadata).includes("secret note"), "the reason is only a digest");
  await setSwitch("kill_switch", "off");

  assert.equal((await answer()).outcome, "not_open", "answering twice changes nothing");
  assert.equal(await readAmuxIdeaCardCloseQuestionForOwner({ ideaId: routedAway.ideaId, actorUserId: OWNER_ID }), null);
  assert.equal((await answer({ ideaId: randomUUID() })).outcome, "not_found");

  // Another owner's idea reads as missing, and a rejected proposal leaves the way open.
  const others = await seedIdea([{ status: "blocked" }], { actor: "another-owner" });
  await drain();
  const theirs = (await questionOf(others.ideaId))!;
  assert.equal((await answerAmuxIdeaCardCloseForOwner({ session: owner(), request: adminRequest(),
    ideaId: others.ideaId, questionId: theirs.id, decision: "close", reason: "Not mine." })).outcome, "not_found");
  const rejected = await seedIdea([{ status: "blocked" }]);
  await drain();
  const proposal = await proposed(rejected.ideaId, select("keep"));
  await judge(proposal.requestId, "reject");
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, null);
  assert.equal((await questionOf(rejected.ideaId))!.state, "open");
  assert.equal((await answerAmuxIdeaCardCloseForOwner({ session: owner(), request: adminRequest(),
    ideaId: rejected.ideaId, questionId: proposal.question.id, decision: "close", reason: "Done with it." })).outcome, "closed");
  assert.equal((await card(rejected.cardIds[0])).status, "cancelled");
});

test("the local card is named once and closes only after the question left open; unknown ids answer as before", async () => {
  const { ideaId } = await seedIdea([{ status: "blocked" }]);
  await drain();
  const question = (await questionOf(ideaId))!;
  const write = <T>(work: (tx: Parameters<Parameters<typeof withAmuxDbBoundary>[1]>[0], now: Date) => Promise<T>) =>
    withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite, (tx, context) => work(tx, context.dbNow));
  await write((tx) => recordDmQuestionLocalCard(tx, { questionId: question.id, cardId: "CC-one" }));
  await write((tx) => recordDmQuestionLocalCard(tx, { questionId: question.id, cardId: "CC-one" }));
  await assert.rejects(write((tx) => recordDmQuestionLocalCard(tx, { questionId: question.id, cardId: "CC-two" })),
    /card_conflict/);
  await assert.rejects(write((tx, now) => recordDmQuestionLocalCardClosed(tx, { questionId: question.id, cardId: "CC-one", now })),
    /not_closable/, "an open question's card stays");
  // Neither table holds it: the worst case, inside the boundary's six calls.
  await assert.rejects(write((tx) => recordDmQuestionLocalCard(tx, { questionId: randomUUID(), cardId: "CC-three" })),
    /not_found/);
  await assert.rejects(write((tx, now) => recordDmQuestionLocalCardClosed(tx, { questionId: randomUUID(), cardId: "CC-three", now })),
    /not_found/);
  assert.deepEqual((await readAmuxIdeaCardCloseSyncForRelay(ON)).pending.filter((entry) => entry.question_id === question.id), [],
    "a filed question is not listed again");
});

test("the table refuses what the lifecycle does not allow", async () => {
  const { ideaId } = await seedIdea([{ status: "blocked" }]);
  await drain();
  const question = (await questionOf(ideaId))!;
  const dbRefusal = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { return (error as Error).message; }
    return null;
  };
  const update = (set: string) => dbRefusal(prisma.$executeRawUnsafe(
    `UPDATE "AmuxIdeaCardCloseQuestion" SET ${set} WHERE "id" = '${question.id}'`));
  assert.match(String(await update(`"reasonCode" = 'stale_cards'`)), /identity is immutable/);
  assert.match(String(await update(`"cards" = '[{"id":"x"}]'::jsonb`)), /identity is immutable/);
  assert.match(String(await update(`"state" = 'kept'`)), /state_check/, "an answer needs its source");
  assert.match(String(await update(`"state" = 'cancelled'`)), /state_check/, "a cancel needs its reason");
  assert.match(String(await update(`"localCardClosedAt" = CURRENT_TIMESTAMP`)), /shape_check/);
  assert.match(String(await update(`"reasonCode" = 'other'`)), /identity is immutable|shape_check/);
  assert.match(String(await dbRefusal(prisma.$executeRawUnsafe(
    `DELETE FROM "AmuxIdeaCardCloseQuestion" WHERE "id" = '${question.id}'`))), /never deleted/);
  // One open per idea.
  const insert = (id: string) => prisma.$executeRawUnsafe(
    `INSERT INTO "AmuxIdeaCardCloseQuestion" ("id", "ideaId", "reasonCode", "cards", "updatedAt")
     VALUES ('${id}', '${ideaId}', 'stale_cards', '[{"id":"x"}]'::jsonb, CURRENT_TIMESTAMP)`);
  assert.match(String(await dbRefusal(insert(randomUUID()))), /one_open_per_idea|Unique constraint|23505/);
  assert.match(String(await dbRefusal(insert("NOT-A-UUID"))), /shape_check/, "the local AMUX files only a lowercase UUID");

  await update(`"state" = 'kept', "answerSource" = 'dm_confirmed', "answeredAt" = CURRENT_TIMESTAMP`);
  assert.equal((await questionOf(ideaId))!.state, "kept");
  assert.match(String(await update(`"answeredAt" = "answeredAt" + INTERVAL '1 day'`)), /cannot change its kept answer/);
  assert.match(String(await update(`"state" = 'open', "answerSource" = NULL, "answeredAt" = NULL`)),
    /cannot move from kept to open/);
  assert.match(String(await update(`"handoffReason" = 'answer_unreadable', "handoffAt" = CURRENT_TIMESTAMP`)),
    /hands off only while open/);
});

test("an apply fits its ceiling exactly, in the case with the most statements, and a shorter one rolls back", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await prisma.amuxHumanEscalation.create({ data: { taskId: cardIds[0], specialty: "execution-recovery",
    reason: "execution_blocked", openedBy: "tomverse-amux-orchestrator", openedTaskRevision: 3 } });
  const { question, requestId } = await confirmed(ideaId, "close");
  const apply = (prismaCallCeiling: number) => withAmuxDbBoundary(
    { ...AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseApply, prismaCallCeiling },
    (tx, context) => applyAmuxIdeaCardCloseDmAnswer(tx, { questionId: question.id, requestId,
      decision: "close", now: context.dbNow }));
  assert.equal(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseApply.prismaCallCeiling, 12, "§9's limit");
  await assert.rejects(apply(11), (error: unknown) => error instanceof AmuxDbBoundaryError &&
    error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED");
  assert.equal((await questionOf(ideaId))!.state, "open", "all of it rolled back");
  assert.equal((await card(cardIds[0])).status, "blocked");
  assert.deepEqual(await apply(12), { applied: true, outcome: "closed" });
  // A second transaction takes the chain lock at once: nothing outlived the apply.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
    await takeAuditChainLock(tx);
  });
});

test("opening a question stays inside its ceiling with every audit statement counted", async () => {
  await seedIdea([{ status: "blocked" }]);
  assert.equal(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseOpen.prismaCallCeiling, 10);
  assert.equal((await openAmuxIdeaCardCloseQuestionIfDue(ON)).opened, true);
});

test("a fault applying one answer neither stops the walk nor changes anything, and the next pass applies it", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }]);
  await confirmed(ideaId, "close");
  const warn = mock.method(console, "warn", () => undefined);
  // A worker's transaction holds the card, so the apply's locked read refuses at once.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "AmuxWorkItem" WHERE "id" = ${cardIds[0]} FOR UPDATE`;
    locked();
    await held;
  }, { timeout: 20_000 });
  await holding;
  const blocked = await runAmuxV22ResolveStep(null).finally(() => release());
  await holder;
  assert.equal(blocked.resolved, null);
  assert.equal(blocked.cursor.move, "advance", "the walk goes on past it");
  assert.equal((await questionOf(ideaId))!.state, "open");
  assert.equal((await card(cardIds[0])).status, "blocked");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /idea_card_close_apply_failed/);
  warn.mock.restore();
  assert.equal((await runAmuxV22ResolveStep(null)).resolved, "closed", "a walk from the start meets it again");
  assert.equal((await card(cardIds[0])).status, "cancelled");
});

test("an answer meeting a worker that holds a card refuses at once instead of deadlocking, and applies after", async () => {
  // Release review r-20261106-051457-02f6ff: the v22 start (and the claim,
  // heartbeat, settlement and recovery) lock the card and take the audit chain
  // only for their closing entry; an answer takes the chain and then locks the
  // card. The worker side below takes exactly those two locks in that order.
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }]);
  await drain();
  const question = (await questionOf(ideaId))!;
  type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
  const settle = <T>(work: Promise<T>): Promise<Settled<T>> =>
    work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => { locked = resolve; });
  const worker = settle(prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${cardIds[0]} FOR UPDATE`;
    locked();
    await held;
    await takeAuditChainLock(tx);
  }, { timeout: 20_000 }));
  await holding;
  const answer = () => answerAmuxIdeaCardCloseForOwner({ session: owner(), request: adminRequest(),
    ideaId, questionId: question.id, decision: "close", reason: "No longer wanted." });
  let answerSettled = false;
  const first = settle(answer().finally(() => { answerSettled = true; }));
  // Let the answer reach the card: refused at once, or waiting on it holding the chain.
  const waitingOnCard = async () => (await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS "count" FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query LIKE '%AmuxIdeaCardCloseQuestion%'`)[0]!.count;
  for (let round = 0; round < 500 && !answerSettled; round += 1) if ((await waitingOnCard()) > 0) break;
  // The worker reaches its audit entry while the answer is in flight.
  release();
  const [workerResult, refused] = await Promise.all([worker, first]);
  assert.ok(workerResult.ok, `the worker's transaction finished: ${workerResult.ok ? "" : String(workerResult.error)}`);
  assert.ok(!refused.ok, "the answer did not wait for the card");
  assert.ok(refused.error instanceof AmuxIdeaCardCloseOwnerError && refused.error.code === "busy",
    `the owner is told to try again: ${String(refused.error)}`);
  assert.equal((await questionOf(ideaId))!.state, "open", "nothing of the answer was kept");
  assert.equal((await card(cardIds[0])).status, "blocked");
  assert.equal((await answer()).outcome, "closed", "once the worker is done the same answer applies");
  assert.equal((await card(cardIds[0])).status, "cancelled");
});

test("the Decision Maker's apply refuses a held card with lock_not_available and the next pass applies it", async () => {
  const { ideaId, cardIds } = await seedIdea([{ status: "blocked" }]);
  const { question, requestId } = await confirmed(ideaId, "close");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => { locked = resolve; });
  const worker = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${cardIds[0]} FOR UPDATE`;
    locked();
    await held;
    await takeAuditChainLock(tx);
  }, { timeout: 20_000 });
  await holding;
  const apply = () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseApply,
    (tx, context) => applyAmuxIdeaCardCloseDmAnswer(tx, { questionId: question.id, requestId,
      decision: "close", now: context.dbNow }));
  const startedAt = Date.now();
  const refused = await apply().then(() => null, (error: unknown) => error);
  const waitedMs = Date.now() - startedAt;
  release();
  await worker;
  assert.ok(isAmuxIdeaCardCloseBusy(refused), `lock_not_available, not a timeout: ${String(refused)}`);
  assert.ok(waitedMs < 1_000, `it did not wait for the card (${waitedMs} ms)`);
  assert.equal((await questionOf(ideaId))!.state, "open");
  assert.deepEqual(await apply(), { applied: true, outcome: "closed" });
  assert.equal((await card(cardIds[0])).status, "cancelled");
});

// The Decision Maker as the approver (owner decision 2026-11-07,
// TOMVERSE_AMUX_DM_APPROVER): the same filed card, with no person's judgment.
const APPROVER = { TOMVERSE_AMUX_DM_APPROVER: "enabled" };

test("the DM approver applies an open proposal without a person, as dm, after claiming the request", async () => {
  const { ideaId } = await seedIdea([{ status: "blocked" }, { status: "backlog" }]);
  await drain();
  const proposal = await proposed(ideaId, select("close"));
  assert.equal(await runAmuxDmAutoApplyStep({}), null, "off by default");
  assert.equal((await questionOf(ideaId))!.state, "open");
  assert.deepEqual(await runAmuxDmAutoApplyStep(APPROVER),
    { requestId: proposal.requestId, kind: "card_close", applied: true });
  const question = (await questionOf(ideaId))!;
  assert.equal(question.state, "closed");
  assert.equal(question.answerSource, "dm");
  assert.equal(question.answeredByUserId, null);
  assert.equal((await readDecisionMakerRequestState(prisma, proposal.requestId))!.closing, "direct_answer_close",
    "Admin no longer offers it for confirmation");
  const audits = await auditOf(question.id);
  assert.ok(audits.some((row) => row.entryHash && (row.metadata as Record<string, unknown>).source === "dm"),
    "the hash-chained system audit names the dm source");
  assert.equal(await runAmuxDmAutoApplyStep(APPROVER), null, "nothing is left to apply");
});

test("the DM approver leaves an irreversible or unfixed proposal to a person, and never one a person judged", async () => {
  const irreversible = await seedIdea([{ status: "blocked" }]);
  const unfixed = await seedIdea([{ status: "blocked" }]);
  await drain();
  const first = await proposed(irreversible.ideaId, { kind: "select", optionId: "close",
    rationale: "Nothing has moved.", irreversible: true });
  const second = await proposed(unfixed.ideaId, { kind: "free_text", answer: "Maybe close them later.",
    rationale: "Unsure.", irreversible: false });
  for (let round = 0; round < 6; round += 1)
    assert.equal(await runAmuxDmAutoApplyStep(APPROVER), null, "whichever is picked, it is not applied");
  assert.equal((await questionOf(irreversible.ideaId))!.state, "open");
  assert.equal((await questionOf(unfixed.ideaId))!.state, "open");
  assert.equal((await readDecisionMakerRequestState(prisma, first.requestId))!.closing, null);
  assert.equal((await readDecisionMakerRequestState(prisma, second.requestId))!.closing, null,
    "still open for the operator's confirmation");

  // A person's judgment that lands between the approver's read and its claim wins:
  // the claim is refused, so nothing is applied.
  const judged = await seedIdea([{ status: "blocked" }]);
  await drain();
  const third = await proposed(judged.ideaId, select("close"));
  await judge(third.requestId, "reject");
  const claim = await prisma.$transaction((tx) => closeDecisionMakerRequestOnDirectAnswer(tx,
    { cardId: third.cardId, questionRevision: 1 }));
  assert.equal(claim.recorded, false);
  assert.equal(await runAmuxDmAutoApplyStep(APPROVER), null);
  assert.equal((await questionOf(judged.ideaId))!.state, "open");
});

/** A v22 worker question parked on its Task, filed to the relay and proposed by a DM. */
async function proposedWorkerQuestion(output: Output) {
  const task = await prisma.amuxWorkItem.create({ data: {
    id: `amux-approver-question-${randomUUID()}`, title: "Approver question fixture",
    status: "blocked", kind: "code", priority: "p2", revision: 4 } });
  const now = new Date();
  const attempt = await prisma.amuxExecutionAttempt.create({ data: {
    id: randomUUID(), taskId: task.id, worker: "codex-impl", workerInstanceId: "fixture-instance",
    workerGeneration: 1, taskRevision: 3, attemptNumber: 1, heartbeatAt: now, startedAt: now,
    endedAt: now, outcome: "succeeded", toStatus: "blocked", endedBy: "codex-impl", reason: "owner_question" } });
  const question = await prisma.amuxV22TaskQuestion.create({ data: {
    id: randomUUID(), taskId: task.id, attemptId: attempt.id, worker: "codex-impl", sequence: 1,
    questionSha256: digest } });
  const cardId = `VQ-${randomUUID().slice(0, 8)}`;
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
    (tx) => recordDmQuestionLocalCard(tx, { questionId: question.id, cardId }));
  const options = [{ id: "a", label: "Use the short name" }, { id: "b", label: "Use the long name" }];
  const binding = { cardId, questionRevision: 1, askingWorkerId: "codex-impl", amuxSessionId: "codex-impl",
    amuxSessionAttempt: 0, askingProvider: "claude", termListVersion: "v1",
    classificationVersion: "authority-manifest-1", scannerVersion: "v1" };
  const dmCard = { askType: "decision", resolution: null, type: "task",
    tags: ["v22-question", `v22q-${question.id}`, "v22-provider-claude"],
    title: "v22 Task question 1", question: "Which name should the helper use?",
    options: options.map((option) => ({ ...option, effect: "choice_only", paths: [] as string[] })),
    unblocks: "Finishing the rename.", context: "", contextPaths: [] as string[] };
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx,
    { binding, card: dmCard, keyRing: RING }));
  assert.equal(routed.route, "dm_proposal");
  const instance = routed.instance!;
  const assigned = await prisma.$transaction((tx) => assignDecisionMakerRequestWithDigestKey(tx,
    { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: RING }));
  const requestKey = (assigned as { requestKey: Buffer }).requestKey;
  const transmission = { snapshotState: "worker_head", snapshotTargetSha: SHA,
    snapshotManifestDigest: dmSnapshotManifestDigest(requestKey, [{ path: "lib/cache.ts", blobId: "f".repeat(40) }]),
    inputPayloadDigest: dmBodyDigest(requestKey, "card_text", "payload") };
  await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx,
    { requestId: routed.requestId, instance, transmission, requireLeaseAt: () => {} }));
  const stored: Record<string, unknown> = { ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  const submitted = await prisma.$transaction((tx) => submitDecisionMakerOutput(tx, {
    requestId: routed.requestId, instance, binding: { ...stored, transmission },
    output: { kind: "output", raw: JSON.stringify(output), options }, requireLeaseAt: () => {}, keyRing: RING }));
  assert.equal(submitted.status === "submitted" && submitted.result.status, "accepted");
  return { task, question, requestId: routed.requestId };
}

test("the DM approver answers a worker question only with an option it offered; a free-text answer waits for a person", async () => {
  const chosen = await proposedWorkerQuestion({ kind: "select", optionId: "a",
    rationale: "Shorter reads better.", irreversible: false });
  assert.deepEqual(await runAmuxDmAutoApplyStep(APPROVER),
    { requestId: chosen.requestId, kind: "question", applied: true });
  const answered = await prisma.amuxV22TaskQuestion.findUniqueOrThrow({ where: { id: chosen.question.id } });
  assert.equal(answered.state, "answered");
  assert.equal(answered.answerSource, "dm");
  assert.match(answered.answerText ?? "", /Chosen option: a$/);
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: chosen.task.id } })).status, "todo",
    "the Task goes back to its worker with the answer");
  assert.equal((await readDecisionMakerRequestState(prisma, chosen.requestId))!.closing, "direct_answer_close");

  const free = await proposedWorkerQuestion({ kind: "free_text", answer: "Use whichever reads better.",
    rationale: "Either works.", irreversible: false });
  assert.equal(await runAmuxDmAutoApplyStep(APPROVER), null);
  assert.equal((await prisma.amuxV22TaskQuestion.findUniqueOrThrow({ where: { id: free.question.id } })).state, "open");
  assert.equal((await readDecisionMakerRequestState(prisma, free.requestId))!.closing, null,
    "still open for the operator's confirmation");
});
