import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  dmBodyDigest,
  dmKeyPeriodEndMs,
  dmKeyPeriodOf,
  dmKeyPeriodStartMs,
  dmSnapshotManifestDigest,
} from "@/lib/amux/decisionMakerBodyCore";
import {
  assignDecisionMakerRequestWithDigestKey,
  eraseDecisionMakerBodies,
  readDecisionMakerBodies,
  readDecisionMakerCardText,
  readDecisionMakerResultDetail,
  recordDecisionMakerRequestWithCardText,
  rotateDecisionMakerDigestKey,
  storeDecisionMakerOperatorAnswer,
  submitDecisionMakerOutput,
} from "@/lib/amux/decisionMakerBodyStore";
import { dmCardText } from "@/lib/amux/decisionMakerCore";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";
import {
  readDecisionMakerDeclarationAccuracyReport,
  readDecisionMakerDeliveryState,
  readDecisionMakerJudgment,
  recordDecisionMakerDelivery,
  recordDecisionMakerDeliveryOutcome,
  recordDecisionMakerJudgment,
  resolveDecisionMakerDeliveryUnknown,
} from "@/lib/amux/decisionMakerJudgmentStore";
import {
  countOpenDecisionMakerRequestsCreatedBetween,
  readDecisionMakerRequestState,
  recordDecisionMakerRequest,
  recordDecisionMakerTransmitIntent,
  staleCloseDecisionMakerRequest,
} from "@/lib/amux/decisionMakerRequestStore";
import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { prisma } from "@/lib/prisma";

// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// stage S1e, against PostgreSQL through the migration history
// (20261008130000_amux_decision_maker_stale_close_hours and
// 20261008130100_amux_decision_maker_judgment_delivery), in the agents lane of
// the DB integration suite.
//
// §12's blocking tests covered here: "보여 준 digest와 다른 본문은 확정되지
// 않는다는 테스트" and the kill switch table's rows for a confirmation, a
// rejection, the delivery and a person's resolution. The rest cover what the
// migration header says the database enforces: one judgment per request,
// closing it with its own event and starting its retention; a proposal with
// its detail; the person's audit of the same transaction naming the request;
// an edited answer stored with its judgment and none after; the delivery
// graph and its single consumption; no update or delete; READ COMMITTED only;
// the CHECKs on NULL; section 4's report; and the stale close at 720 hours,
// also across a daylight-saving change in the session's time zone. The
// writer's own statements are counted in tests/amuxDecisionMakerJudgment.test.mjs.

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

const REQUEST = "AmuxDecisionMakerRequest";
const EVENT = "AmuxDecisionMakerRequestEvent";
const DELIVERY = "AmuxDecisionMakerDeliveryEvent";
const OPENAI = "decision-maker-openai";
const HOUR = 60 * 60 * 1000;
const SHA = "0123456789abcdef0123456789abcdef01234567";

type SystemActor = "amux-decision-router" | "amux-decision-maker-openai" | "amux-decision-maker-anthropic";
type Audit =
  | { kind: "system"; actor: SystemActor; action: string; targetType: string; targetId: string; metadata?: Prisma.InputJsonObject }
  | { kind: "person"; action: string; targetType: string; targetId: string; session?: Session; metadata?: Prisma.InputJsonObject };

const writeAudit = (tx: Prisma.TransactionClient, audit: Audit) =>
  audit.kind === "system"
    ? writeSystemAuditLog({
        tx,
        systemActor: audit.actor,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        summary: "test",
        metadata: audit.metadata,
      })
    : writeAdminAuditLog({
        tx,
        session: audit.session ?? operator(),
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        summary: "test",
        metadata: audit.metadata,
      });

/** A database refusal, found wherever Prisma put the message. */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, "the database accepted what it must refuse");
  const record = caught as { meta?: unknown; cause?: unknown };
  assert.match([String(caught), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" "), pattern);
};

class RolledBack extends Error {
  constructor() {
    super("RolledBack");
  }
}

// ---------------------------------------------------------------------------
// A request with a proposal, through the stores
// ---------------------------------------------------------------------------

const OPTIONS = [
  { id: "a", label: "Model id only" },
  { id: "b", label: "Model id and locale" },
];

type Output =
  | { kind: "free_text"; answer: string; rationale: string; irreversible: boolean }
  | { kind: "select"; optionId: string; rationale: string; irreversible: boolean }
  | { kind: "escalate"; reason: string };

const FREE_TEXT: Output = { kind: "free_text", answer: "Use the model id only.", rationale: "The locale is already in the path.", irreversible: false };

const CARD = {
  askType: "decision",
  resolution: null,
  type: "task",
  tags: [] as string[],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: OPTIONS,
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
};

/**
 * Routed, assigned with its key, transmitted with a worker_head snapshot, and answered with `output`.
 * `withCardText` routes through the body store's composition, which keeps the card text as the
 * application does (2026-10-09); the rest of this file routes through the ledger's own routing.
 */
const proposed = async (
  output: Output | "timeout" = FREE_TEXT,
  askingProvider = "claude",
  { card = CARD, withCardText = false }: { card?: typeof CARD; withCardText?: boolean } = {},
) => {
  const binding = {
    cardId: `card-judgment-${randomUUID()}`,
    questionRevision: 1,
    askingWorkerId: "worker.claude-1",
    amuxSessionId: "session:7",
    amuxSessionAttempt: 1,
    askingProvider,
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
  };
  const routed = await prisma.$transaction((tx) =>
    withCardText
      ? recordDecisionMakerRequestWithCardText(tx, { binding, card, keyRing: RING })
      : recordDecisionMakerRequest(tx, { binding, card, keyRing: RING }),
  );
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
  const state = (await readDecisionMakerRequestState(prisma, routed.requestId))!;
  return { requestId: routed.requestId, instance, requestKey, resultEventId: state.terminal!.eventId };
};

/** What Admin shows beside a proposal: read from the stores, as stage S2's screen will. */
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

type JudgmentInput = { kind: string; shown?: unknown; accuracy?: unknown; operatorAnswer?: unknown };

const judge = (requestId: string, input: JudgmentInput, session: Session = operator()) =>
  prisma.$transaction((tx) => recordDecisionMakerJudgment(tx, { session, requestId, keyRing: RING, ...input }));

const eventsOf = (requestId: string) =>
  prisma.$queryRaw<Array<{ kind: string; auditLogId: string; createdAtMs: bigint }>>`
    SELECT "kind", "auditLogId", floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtMs"
    FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} ORDER BY "sequence"
  `;

const retentionOf = (requestId: string) =>
  prisma.$queryRaw<Array<{ kind: string; retentionUntilMs: bigint; auditLogId: string; actorKind: string }>>`
    SELECT "kind", floor(extract(epoch FROM "retentionUntil") * 1000)::bigint AS "retentionUntilMs", "auditLogId", "actorKind"
    FROM "AmuxDecisionMakerRetentionEvent" WHERE "requestId" = ${requestId} ORDER BY "sequence"
  `;

// ---------------------------------------------------------------------------
// Direct writes, past the store
// ---------------------------------------------------------------------------

type JudgmentRow = {
  requestId: string;
  resultEventId: string;
  instance?: string;
  kind: string;
  actorUserId: string;
  shown: DmShownProposal | null;
  operatorAnswerDigest?: string | null;
  declarationAccuracy?: string;
  mismatchedItems?: string[] | null;
  auditLogId: string;
};

const insertJudgmentRow = (tx: Prisma.TransactionClient, row: JudgmentRow) =>
  tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerJudgment"
      ("id", "requestId", "resultEventId", "instance", "kind", "actorUserId",
       "shownAnswerDigest", "shownRationaleDigest", "shownOptionId", "shownIrreversible",
       "shownSnapshotState", "shownSnapshotTargetSha", "shownSnapshotManifestDigest",
       "operatorAnswerDigest", "declarationAccuracy", "mismatchedItems", "auditLogId")
    VALUES
      (${randomUUID()}, ${row.requestId}, ${row.resultEventId}, ${row.instance ?? OPENAI}, ${row.kind}, ${row.actorUserId},
       ${row.shown?.answerDigest ?? null}::text, ${row.shown?.rationaleDigest ?? null}::text, ${row.shown?.optionId ?? null}::text,
       ${row.shown?.irreversible ?? null}::boolean, ${row.shown?.snapshotState ?? null}::text,
       ${row.shown?.snapshotTargetSha ?? null}::text, ${row.shown?.snapshotManifestDigest ?? null}::text,
       ${row.operatorAnswerDigest ?? null}::text, ${row.declarationAccuracy ?? "not_judged"},
       ${row.mismatchedItems === undefined ? [] : row.mismatchedItems}::text[], ${row.auditLogId})
  `;

/** The person's judgment audit as the store writes it: the request named as target and in the metadata. */
const judgmentAudit = (tx: Prisma.TransactionClient, requestId: string, kind: string, session: Session) =>
  writeAudit(tx, { kind: "person", action: `amux.decision.${kind}`, targetType: REQUEST, targetId: requestId, session, metadata: { request_id: requestId } });

/**
 * A judgment written past the store, in one transaction that is rolled back
 * when it was accepted. `change` alters the row the store would have written;
 * `audit` replaces the audit row. Returns null when the database accepted it.
 */
const tryJudgment = async (
  basis: { requestId: string; resultEventId: string; shown: DmShownProposal },
  kind: "confirm" | "edit_confirm" | "reject",
  change: (row: JudgmentRow, tx: Prisma.TransactionClient) => Promise<JudgmentRow> | JudgmentRow = (row) => row,
  audit?: (tx: Prisma.TransactionClient, session: Session) => Promise<string>,
): Promise<unknown> => {
  try {
    await prisma.$transaction(async (tx) => {
      const session = operator();
      const auditLogId = audit ? await audit(tx, session) : await judgmentAudit(tx, basis.requestId, kind, session);
      let operatorAnswerDigest: string | null = null;
      if (kind === "edit_confirm") {
        const createdAtMs = (await readDecisionMakerRequestState(tx, basis.requestId))!.createdAtMs;
        operatorAnswerDigest = (
          await storeDecisionMakerOperatorAnswer(tx, { requestId: basis.requestId, requestCreatedAtMs: createdAtMs, text: "Use the locale too.", auditLogId, keyRing: RING })
        ).digest;
      }
      const row = await change(
        {
          requestId: basis.requestId,
          resultEventId: basis.resultEventId,
          kind,
          actorUserId: session.user!.id!,
          shown: kind === "reject" ? null : basis.shown,
          operatorAnswerDigest,
          auditLogId,
        },
        tx,
      );
      await insertJudgmentRow(tx, row);
      throw new RolledBack();
    });
  } catch (error) {
    return error instanceof RolledBack ? null : error;
  }
  throw new Error("unreachable");
};

const refusedWith = (error: unknown, pattern: RegExp) => {
  assert.ok(error !== null, "the database accepted what it must refuse");
  const record = error as { meta?: unknown; cause?: unknown };
  assert.match([String(error), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" "), pattern);
};

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

test("a confirmation through the store closes the request with its own event and starts the retention at the judgment", async () => {
  const { requestId, resultEventId } = await proposed();
  const person = operator("dm-operator-confirm");
  const written = await judge(requestId, { kind: "confirm", shown: await shownOf(requestId), accuracy: { accuracy: "matched" } }, person);
  assert.equal(written.recorded, true);
  if (!written.recorded) return;
  const stored = await readDecisionMakerJudgment(prisma, requestId);
  assert.deepEqual(stored && [stored.kind, stored.instance, stored.accuracy, stored.operatorAnswerDigest, stored.auditLogId], [
    "confirm",
    OPENAI,
    { accuracy: "matched", mismatchedItems: [] },
    null,
    written.judgment.auditLogId,
  ]);
  const row = (
    await prisma.$queryRaw<Array<{ actorUserId: string; resultEventId: string; createdAtMs: bigint }>>`
      SELECT "actorUserId", "resultEventId", floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtMs"
      FROM "AmuxDecisionMakerJudgment" WHERE "requestId" = ${requestId}
    `
  )[0]!;
  assert.equal(row.actorUserId, "dm-operator-confirm");
  assert.equal(row.resultEventId, resultEventId);
  // The person's audit names the request.
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: written.judgment.auditLogId } });
  assert.deepEqual(audit && [audit.action, audit.targetType, audit.targetId, audit.actorUserId], ["amux.decision.confirm", REQUEST, requestId, "dm-operator-confirm"]);
  // The request's closing event, of the judgment's kind and named by the same audit row.
  const events = await eventsOf(requestId);
  const closing = events.at(-1)!;
  assert.deepEqual([closing.kind, closing.auditLogId], ["confirm", written.judgment.auditLogId]);
  assert.equal((await readDecisionMakerRequestState(prisma, requestId))!.closing, "confirm");
  // Its retention: 2160 hours after the close, named by the same audit row.
  const retention = await retentionOf(requestId);
  assert.deepEqual(retention.map((entry) => [entry.kind, entry.actorKind, entry.auditLogId]), [["retention_set", "system", written.judgment.auditLogId]]);
  assert.equal(Number(retention[0]!.retentionUntilMs), Number(closing.createdAtMs) + 2160 * HOUR);
  // Closed: no stale close, by the store or the guard.
  assert.deepEqual(await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId })), { recorded: false, reason: "closed" });
  // A judged request is not open for its key period's destruction.
  const period = dmKeyPeriodOf(Number(row.createdAtMs));
  assert.equal(await countOpenDecisionMakerRequestsCreatedBetween(prisma, { fromMs: dmKeyPeriodStartMs(period), toMs: dmKeyPeriodEndMs(period) }), 0);
});

test("an edited confirmation stores the person's answer through the body store and names its digest", async () => {
  const { requestId, requestKey } = await proposed();
  const answer = "Use the model id and the locale.";
  const written = await judge(requestId, {
    kind: "edit_confirm",
    shown: await shownOf(requestId),
    operatorAnswer: answer,
    accuracy: { accuracy: "mismatched", mismatchedItems: ["paths", "effect_class"] },
  });
  assert.equal(written.recorded, true);
  if (!written.recorded) return;
  const digest = dmBodyDigest(requestKey, "operator_answer", answer);
  assert.equal(written.judgment.operatorAnswerDigest, digest);
  const bodies = await readDecisionMakerBodies(prisma, requestId);
  assert.deepEqual(bodies.find((body) => body.field === "operator_answer") && [bodies.find((body) => body.field === "operator_answer")!.text, bodies.find((body) => body.field === "operator_answer")!.digest], [answer, digest]);
  const stored = await prisma.$queryRaw<Array<{ operatorAnswerDigest: string; declarationAccuracy: string; mismatchedItems: string[] }>>`
    SELECT "operatorAnswerDigest", "declarationAccuracy", "mismatchedItems" FROM "AmuxDecisionMakerJudgment" WHERE "requestId" = ${requestId}
  `;
  assert.deepEqual(stored, [{ operatorAnswerDigest: digest, declarationAccuracy: "mismatched", mismatchedItems: ["effect_class", "paths"] }]);
  assert.equal((await eventsOf(requestId)).at(-1)!.kind, "edit_confirm");
  // Nothing more for the request: no second answer, under any audit.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await judgmentAudit(tx, requestId, "edit_confirm", operator());
      await storeDecisionMakerOperatorAnswer(tx, { requestId, requestCreatedAtMs: (await readDecisionMakerRequestState(tx, requestId))!.createdAtMs, text: "Another.", auditLogId: audit, keyRing: RING });
    }),
    /AMUX_DM_BODY_CLOSED|AmuxDecisionMakerBody_requestId_field_key|unique/i,
  );
});

test("under the kill switch a confirmation is refused by the store and the guard, and a rejection is recorded", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  await setSwitch("kill_switch", "on");
  assert.deepEqual(await judge(basis.requestId, { kind: "confirm", shown }), { recorded: false, reason: "kill_switch_on" });
  assert.deepEqual(await judge(basis.requestId, { kind: "edit_confirm", shown, operatorAnswer: "x y" }), { recorded: false, reason: "kill_switch_on" });
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm"), /AMUX_DM_JUDGMENT_SWITCH/);
  refusedWith(await tryJudgment({ ...basis, shown }, "edit_confirm"), /AMUX_DM_JUDGMENT_SWITCH/);
  assert.equal(await tryJudgment({ ...basis, shown }, "reject"), null);
  // An instance off stops routing and process start only; it does not refuse a judgment.
  await setSwitch("kill_switch", "off");
  await setSwitch(OPENAI, "off");
  assert.equal(await tryJudgment({ ...basis, shown }, "confirm"), null);
  await setSwitch("kill_switch", "on");
  const rejected = await judge(basis.requestId, { kind: "reject", accuracy: { accuracy: "not_judged" } });
  assert.equal(rejected.recorded, true);
  assert.equal((await eventsOf(basis.requestId)).at(-1)!.kind, "reject");
});

test("one judgment per request: a second is refused by the store, the guard and the indexes", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  assert.equal((await judge(basis.requestId, { kind: "reject" })).recorded, true);
  for (const kind of ["confirm", "reject"] as const) {
    assert.deepEqual(await judge(basis.requestId, kind === "reject" ? { kind } : { kind, shown }), { recorded: false, reason: "closed" });
    refusedWith(await tryJudgment({ ...basis, shown }, kind), /AMUX_DM_JUDGMENT_CLOSED/);
  }
  // The guard aside, the request has one judgment and one closing event.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerJudgment" DISABLE TRIGGER "amux_decision_maker_judgment_guard"`);
      const session = operator();
      const audit = await judgmentAudit(tx, basis.requestId, "reject", session);
      await insertJudgmentRow(tx, { ...basis, kind: "reject", actorUserId: session.user!.id!, shown: null, auditLogId: audit });
    }),
    /AmuxDecisionMakerJudgment_requestId_key|AmuxDecisionMakerJudgment_resultEventId_key|unique|AMUX_DM_REQUEST_EVENT/i,
  );
});

test("a judgment needs the request's open proposal with its detail, of the request's instance", async () => {
  // An escalation and a timeout are terminal results, not proposals.
  for (const output of [{ kind: "escalate", reason: "The card asks for a person." } as Output, "timeout" as const]) {
    const basis = await proposed(output);
    assert.deepEqual(await judge(basis.requestId, { kind: "reject" }), { recorded: false, reason: "no_proposal" });
    refusedWith(await tryJudgment({ ...basis, shown: null as unknown as DmShownProposal }, "reject"), /AMUX_DM_JUDGMENT_NO_PROPOSAL/);
  }
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  // Another request's result, another instance, no such request.
  const other = await proposed();
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, resultEventId: other.resultEventId })), /AMUX_DM_JUDGMENT_NO_PROPOSAL/);
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, instance: "decision-maker-anthropic" })), /AMUX_DM_JUDGMENT_INSTANCE/);
  refusedWith(await tryJudgment({ ...basis, shown }, "reject", (row) => ({ ...row, requestId: randomUUID() })), /AMUX_DM_JUDGMENT_NO_REQUEST|foreign key|AmuxDecisionMakerJudgment_requestId_fkey/i);
  // A request routed to the operator is closed from its creation.
  const routedToOperator = await prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: id });
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequest"
        ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt", "askingProvider",
         "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion", "scannerVersion", "route", "instance",
         "refusalCodes", "auditLogId", "assignmentDeadlineAt")
      VALUES (${id}, ${`card-operator-${id}`}, 1, 'worker.claude-1', 'session:1', 1, 'claude', ${"a".repeat(64)}, 1, 'v1',
              'authority-manifest-1', 'v1', 'operator', ${OPENAI}, ARRAY['instance_off']::text[], ${audit}, now())
    `;
    return id;
  });
  refusedWith(await tryJudgment({ ...basis, requestId: routedToOperator, shown }, "reject"), /AMUX_DM_JUDGMENT_CLOSED/);
  assert.deepEqual(await judge(routedToOperator, { kind: "reject" }), { recorded: false, reason: "not_routed_to_dm" });
  // The proposal's detail stays required: the same row is accepted while it stands.
  assert.equal(await tryJudgment({ ...basis, shown }, "confirm"), null);
});

test("a confirmation stands only on what Admin showed: a changed value, a stale snapshot or an erased body is refused", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  const changes: Array<[string, Partial<DmShownProposal>]> = [
    ["another rationale", { rationaleDigest: "f".repeat(64) }],
    ["another answer", { answerDigest: "f".repeat(64) }],
    ["a select instead of free text", { answerDigest: null, optionId: "b" }],
    ["the irreversible flag hidden", { irreversible: true }],
    ["another snapshot state", { snapshotState: "develop" }],
    ["another target", { snapshotTargetSha: "f".repeat(40) }],
    ["another manifest", { snapshotManifestDigest: "f".repeat(64) }],
    ["card only", { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null }],
  ];
  for (const [label, change] of changes) {
    assert.deepEqual(await judge(basis.requestId, { kind: "confirm", shown: { ...shown, ...change } }), { recorded: false, reason: "shown_mismatch" }, label);
    refusedWith(await tryJudgment({ ...basis, shown: { ...shown, ...change } }, "confirm"), /AMUX_DM_JUDGMENT_SHOWN/);
    refusedWith(await tryJudgment({ ...basis, shown: { ...shown, ...change } }, "edit_confirm"), /AMUX_DM_JUDGMENT_SHOWN/);
  }
  // A select: its option, never an answer.
  const select = await proposed({ kind: "select", optionId: "b", rationale: "Smaller key.", irreversible: true });
  const selectShown = await shownOf(select.requestId);
  assert.deepEqual([selectShown.answerDigest, selectShown.optionId, selectShown.irreversible], [null, "b", true]);
  refusedWith(await tryJudgment({ ...select, shown: { ...selectShown, optionId: "a" } }, "confirm"), /AMUX_DM_JUDGMENT_SHOWN/);
  assert.equal(await tryJudgment({ ...select, shown: selectShown }, "confirm"), null);
  // A body erased on a privacy request since Admin showed it cannot be confirmed; a rejection still can.
  const erased = await prisma.$transaction((tx) => eraseDecisionMakerBodies(tx, { session: operator(), requestId: basis.requestId, fields: ["dm_rationale"] }));
  assert.equal(erased.deleted, true);
  assert.deepEqual(await judge(basis.requestId, { kind: "confirm", shown }), { recorded: false, reason: "shown_mismatch" });
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm"), /AMUX_DM_JUDGMENT_SHOWN/);
  assert.equal((await judge(basis.requestId, { kind: "reject" })).recorded, true);
});

test("a judgment's audit is the person's own, of its transaction, naming the request", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  const cases: Array<[string, (tx: Prisma.TransactionClient, session: Session) => Promise<string>]> = [
    ["a system audit", (tx) => writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.confirm", targetType: REQUEST, targetId: basis.requestId, metadata: { request_id: basis.requestId } })],
    ["another action", (tx, session) => writeAudit(tx, { kind: "person", action: "amux.decision.reject", targetType: REQUEST, targetId: basis.requestId, session, metadata: { request_id: basis.requestId } })],
    ["another target type", (tx, session) => writeAudit(tx, { kind: "person", action: "amux.decision.confirm", targetType: EVENT, targetId: basis.requestId, session, metadata: { request_id: basis.requestId } })],
    ["another request", (tx, session) => writeAudit(tx, { kind: "person", action: "amux.decision.confirm", targetType: REQUEST, targetId: randomUUID(), session, metadata: { request_id: basis.requestId } })],
    ["no request in its metadata", (tx, session) => writeAudit(tx, { kind: "person", action: "amux.decision.confirm", targetType: REQUEST, targetId: basis.requestId, session })],
    ["another person", (tx) => judgmentAudit(tx, basis.requestId, "confirm", operator())],
  ];
  for (const [label, audit] of cases) {
    refusedWith(await tryJudgment({ ...basis, shown }, "confirm", (row) => row, audit), /AMUX_DM_JUDGMENT_UNAUDITED/);
    assert.ok(label);
  }
  // An audit of an earlier transaction does not carry a later judgment.
  const earlier = await prisma.$transaction((tx) => judgmentAudit(tx, basis.requestId, "reject", operator("dm-operator-earlier")));
  refusedWith(
    await tryJudgment({ ...basis, shown }, "reject", (row) => ({ ...row, actorUserId: "dm-operator-earlier", auditLogId: earlier }), (tx, session) => judgmentAudit(tx, basis.requestId, "reject", session)),
    /AMUX_DM_JUDGMENT_UNAUDITED/,
  );
  // A closing event of a judgment's kind needs its judgment row of the same transaction.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await judgmentAudit(tx, basis.requestId, "confirm", operator());
      await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "auditLogId") VALUES (${randomUUID()}, ${basis.requestId}, 'confirm', ${audit})`;
    }),
    /AMUX_DM_REQUEST_EVENT_UNAUDITED/,
  );
  // ... and, the guard aside, the replaced CHECK keeps an instance off a judgment's event.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" DISABLE TRIGGER "amux_decision_maker_request_event_guard"`);
      const audit = await judgmentAudit(tx, basis.requestId, "confirm", operator());
      await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "instance", "auditLogId") VALUES (${randomUUID()}, ${basis.requestId}, 'confirm', ${OPENAI}, ${audit})`;
    }),
    /AmuxDecisionMakerRequestEvent_instance_kind_check/,
  );
  // A judgment's kind is a value of the replaced kind CHECK; a kind outside it is not.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" DISABLE TRIGGER "amux_decision_maker_request_event_guard"`);
      const audit = await judgmentAudit(tx, basis.requestId, "confirm", operator());
      await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "instance", "auditLogId") VALUES (${randomUUID()}, ${basis.requestId}, 'approve', ${OPENAI}, ${audit})`;
    }),
    /AmuxDecisionMakerRequestEvent_kind_check/,
  );
});

test("an operator's answer belongs to an edited confirmation: before it, in its transaction, and never beside a confirm or a reject", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  // An edit names the answer it wrote, and no other digest.
  refusedWith(await tryJudgment({ ...basis, shown }, "edit_confirm", (row) => ({ ...row, operatorAnswerDigest: "f".repeat(64) })), /AMUX_DM_JUDGMENT_OPERATOR_ANSWER/);
  // An edit without its answer of this transaction is refused.
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, kind: "edit_confirm", operatorAnswerDigest: "f".repeat(64) })), /AMUX_DM_JUDGMENT_OPERATOR_ANSWER/);
  for (const kind of ["confirm", "reject"] as const) {
    refusedWith(
      await tryJudgment({ ...basis, shown }, kind, async (row, tx) => {
        const edit = await judgmentAudit(tx, basis.requestId, "edit_confirm", operator());
        const createdAtMs = (await readDecisionMakerRequestState(tx, basis.requestId))!.createdAtMs;
        await storeDecisionMakerOperatorAnswer(tx, { requestId: basis.requestId, requestCreatedAtMs: createdAtMs, text: "Use the locale too.", auditLogId: edit, keyRing: RING });
        return row;
      }),
      /AMUX_DM_JUDGMENT_OPERATOR_ANSWER/,
    );
  }
  // After a judgment no answer is stored.
  assert.equal((await judge(basis.requestId, { kind: "confirm", shown })).recorded, true);
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await judgmentAudit(tx, basis.requestId, "edit_confirm", operator());
      const createdAtMs = (await readDecisionMakerRequestState(tx, basis.requestId))!.createdAtMs;
      await storeDecisionMakerOperatorAnswer(tx, { requestId: basis.requestId, requestCreatedAtMs: createdAtMs, text: "Too late.", auditLogId: audit, keyRing: RING });
    }),
    /AMUX_DM_BODY_CLOSED/,
  );
});

test("no CHECK passes on NULL, and the mismatched items appear once each", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  // The guard set aside for the one insert, so each CHECK is what refuses the row.
  const unguarded = (change: (row: JudgmentRow) => JudgmentRow) => async (row: JudgmentRow, tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerJudgment" DISABLE TRIGGER "amux_decision_maker_judgment_guard"`);
    return change(row);
  };
  const cases: Array<[string, (row: JudgmentRow) => JudgmentRow, RegExp]> = [
    ["no irreversible flag", (row) => ({ ...row, shown: { ...shown, irreversible: null as unknown as boolean } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["no rationale", (row) => ({ ...row, shown: { ...shown, rationaleDigest: null as unknown as string } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["no snapshot state", (row) => ({ ...row, shown: { ...shown, snapshotState: null as unknown as "none" } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["a target without a snapshot", (row) => ({ ...row, shown: { ...shown, snapshotState: "none" } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["neither answer nor option", (row) => ({ ...row, shown: { ...shown, answerDigest: null } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["both answer and option", (row) => ({ ...row, shown: { ...shown, optionId: "b" } }), /AmuxDecisionMakerJudgment_shape_check/],
    ["an edit without its answer", (row) => ({ ...row, kind: "edit_confirm", operatorAnswerDigest: null }), /AmuxDecisionMakerJudgment_shape_check/],
    ["a confirm with an answer", (row) => ({ ...row, operatorAnswerDigest: "f".repeat(64) }), /AmuxDecisionMakerJudgment_shape_check/],
    ["a reject with shown values", (row) => ({ ...row, kind: "reject" }), /AmuxDecisionMakerJudgment_shape_check/],
    ["no mismatched items list", (row) => ({ ...row, mismatchedItems: null }), /AmuxDecisionMakerJudgment_mismatched_items_check/],
    ["mismatched without items", (row) => ({ ...row, declarationAccuracy: "mismatched", mismatchedItems: [] }), /AmuxDecisionMakerJudgment_mismatched_items_check/],
    ["matched with items", (row) => ({ ...row, declarationAccuracy: "matched", mismatchedItems: ["paths"] }), /AmuxDecisionMakerJudgment_mismatched_items_check/],
    ["an item outside the list", (row) => ({ ...row, declarationAccuracy: "mismatched", mismatchedItems: ["model"] }), /AmuxDecisionMakerJudgment_mismatched_items_check/],
    ["a NULL item", (row) => ({ ...row, declarationAccuracy: "mismatched", mismatchedItems: ["paths", null as unknown as string] }), /AmuxDecisionMakerJudgment_mismatched_items_check/],
    ["an accuracy outside the list", (row) => ({ ...row, declarationAccuracy: "correct" }), /AmuxDecisionMakerJudgment_declaration_accuracy_check/],
    ["an option id that is prose", (row) => ({ ...row, shown: { ...shown, answerDigest: null, optionId: "Use the model id" } }), /AmuxDecisionMakerJudgment_shown_option_id_format_check/],
    ["an upper-case digest", (row) => ({ ...row, shown: { ...shown, rationaleDigest: "A".repeat(64) } }), /AmuxDecisionMakerJudgment_digest_format_check/],
  ];
  for (const [label, change, pattern] of cases) {
    refusedWith(await tryJudgment({ ...basis, shown }, "confirm", unguarded(change)), pattern);
    assert.ok(label);
  }
  // With the guard in place: a repeated item is the guard's, and each other mistake is refused too.
  refusedWith(
    await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, declarationAccuracy: "mismatched", mismatchedItems: ["paths", "paths"] })),
    /AMUX_DM_JUDGMENT_ACCURACY/,
  );
  refusedWith(await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, mismatchedItems: null })), /AmuxDecisionMakerJudgment_mismatched_items_check/);
  // A mismatch with its items in any order is accepted.
  assert.equal(await tryJudgment({ ...basis, shown }, "confirm", (row) => ({ ...row, declarationAccuracy: "mismatched", mismatchedItems: ["paths", "resolution"] })), null);
});

test("judgments and delivery events are never changed or removed, and only READ COMMITTED writes them", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  assert.equal((await judge(basis.requestId, { kind: "confirm", shown })).recorded, true);
  assert.equal((await prisma.$transaction((tx) => recordDecisionMakerDelivery(tx, { requestId: basis.requestId }))).recorded, true);
  for (const statement of [
    `UPDATE "AmuxDecisionMakerJudgment" SET "declarationAccuracy" = 'matched'`,
    `DELETE FROM "AmuxDecisionMakerJudgment"`,
  ]) {
    await rejectsWith(prisma.$executeRawUnsafe(statement), /AMUX_DM_JUDGMENT_IMMUTABLE/);
  }
  for (const statement of [`UPDATE "AmuxDecisionMakerDeliveryEvent" SET "kind" = 'delivery_receipt'`, `DELETE FROM "AmuxDecisionMakerDeliveryEvent"`]) {
    await rejectsWith(prisma.$executeRawUnsafe(statement), /AMUX_DM_DELIVERY_IMMUTABLE/);
  }
  // The closing event is the ledger's and is never changed either.
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${basis.requestId} AND "kind" = 'confirm'`, /AMUX_DM_REQUEST_EVENT_IMMUTABLE/);
  const other = await proposed();
  const otherShown = await shownOf(other.requestId);
  for (const isolationLevel of [Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable]) {
    await rejectsWith(
      prisma.$transaction(
        async (tx) => {
          const session = operator();
          const audit = await judgmentAudit(tx, other.requestId, "confirm", session);
          await insertJudgmentRow(tx, { ...other, kind: "confirm", actorUserId: session.user!.id!, shown: otherShown, auditLogId: audit });
        },
        { isolationLevel },
      ),
      /AMUX_DM_JUDGMENT_ISOLATION/,
    );
    await rejectsWith(
      prisma.$transaction(
        async (tx) => {
          const id = randomUUID();
          const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.deliver", targetType: DELIVERY, targetId: id });
          await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerDeliveryEvent" ("id", "requestId", "kind", "actorKind", "auditLogId") VALUES (${id}, ${basis.requestId}, 'delivery_receipt', 'system', ${audit})`;
        },
        { isolationLevel },
      ),
      /AMUX_DM_DELIVERY_ISOLATION/,
    );
  }
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type DeliveryRow = { kind: string; outcome?: string | null; actorKind?: string; actorUserId?: string | null; auditLogId: string; id?: string; sequence?: number };

const insertDeliveryRow = (tx: Prisma.TransactionClient, requestId: string, row: DeliveryRow) =>
  row.sequence === undefined
    ? tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerDeliveryEvent" ("id", "requestId", "kind", "outcome", "actorKind", "actorUserId", "auditLogId")
        VALUES (${row.id ?? randomUUID()}, ${requestId}, ${row.kind}, ${row.outcome ?? null}::text, ${row.actorKind ?? "system"},
                ${row.actorUserId ?? null}::text, ${row.auditLogId})
      `
    : tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerDeliveryEvent" ("id", "sequence", "requestId", "kind", "outcome", "actorKind", "actorUserId", "auditLogId")
        VALUES (${row.id ?? randomUUID()}, ${row.sequence}, ${requestId}, ${row.kind}, ${row.outcome ?? null}::text, ${row.actorKind ?? "system"},
                ${row.actorUserId ?? null}::text, ${row.auditLogId})
      `;

/** A system delivery event with the router's audit of its own transaction, written past the store. */
const directDelivery = (requestId: string, kind: "deliver" | "delivery_receipt" | "delivery_unknown", audit?: (tx: Prisma.TransactionClient, id: string) => Promise<string>) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const auditLogId = audit
      ? await audit(tx, id)
      : await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: kind === "delivery_unknown" ? "amux.decision.delivery_unknown" : "amux.decision.deliver", targetType: DELIVERY, targetId: id });
    await insertDeliveryRow(tx, requestId, { id, kind, auditLogId });
  });

test("delivery: one decision after a confirmation and never under the kill switch, one outcome, one resolution after unknown", async () => {
  const confirmed = await proposed();
  const deliver = (requestId: string) => prisma.$transaction((tx) => recordDecisionMakerDelivery(tx, { requestId }));
  const outcome = (requestId: string, value: "receipt" | "unknown") => prisma.$transaction((tx) => recordDecisionMakerDeliveryOutcome(tx, { requestId, outcome: value }));
  // Before a confirmation: nothing to deliver, by the store and the guard.
  assert.deepEqual(await deliver(confirmed.requestId), { recorded: false, reason: "not_confirmed" });
  await rejectsWith(directDelivery(confirmed.requestId, "deliver"), /AMUX_DM_DELIVERY_TRANSITION/);
  assert.equal((await judge(confirmed.requestId, { kind: "confirm", shown: await shownOf(confirmed.requestId) })).recorded, true);
  // Before the decision: no outcome.
  assert.deepEqual(await outcome(confirmed.requestId, "receipt"), { recorded: false, reason: "not_delivered" });
  await rejectsWith(directDelivery(confirmed.requestId, "delivery_receipt"), /AMUX_DM_DELIVERY_TRANSITION/);
  // Under the kill switch: no decision, by the store and the guard.
  await setSwitch("kill_switch", "on");
  assert.deepEqual(await deliver(confirmed.requestId), { recorded: false, reason: "kill_switch_on" });
  await rejectsWith(directDelivery(confirmed.requestId, "deliver"), /AMUX_DM_DELIVERY_SWITCH/);
  await setSwitch("kill_switch", "off");
  const decided = await deliver(confirmed.requestId);
  assert.equal(decided.recorded, true);
  if (!decided.recorded) return;
  assert.equal(decided.judgmentKind, "confirm");
  // Consumed once: by the store, the guard and the index.
  assert.deepEqual(await deliver(confirmed.requestId), { recorded: false, reason: "already_delivered" });
  await rejectsWith(directDelivery(confirmed.requestId, "deliver"), /AMUX_DM_DELIVERY_TRANSITION/);
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerDeliveryEvent" DISABLE TRIGGER "amux_decision_maker_delivery_event_guard"`);
      const id = randomUUID();
      const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.deliver", targetType: DELIVERY, targetId: id });
      await insertDeliveryRow(tx, confirmed.requestId, { id, kind: "deliver", auditLogId: audit });
    }),
    /AmuxDecisionMakerDeliveryEvent_one_deliver_key|unique/i,
  );
  // The outcome is recorded under the kill switch as well: it records what happened.
  await setSwitch("kill_switch", "on");
  const unknown = await outcome(confirmed.requestId, "unknown");
  assert.equal(unknown.recorded, true);
  assert.deepEqual(await outcome(confirmed.requestId, "receipt"), { recorded: false, reason: "outcome_recorded" });
  await rejectsWith(directDelivery(confirmed.requestId, "delivery_receipt"), /AMUX_DM_DELIVERY_TRANSITION/);
  // A person resolves it once, under the kill switch too (section 6's table: a person's operation).
  const person = operator("dm-operator-resolve");
  const resolve = (value: "delivered" | "not_delivered") =>
    prisma.$transaction((tx) => resolveDecisionMakerDeliveryUnknown(tx, { session: person, requestId: confirmed.requestId, outcome: value }));
  const resolved = await resolve("not_delivered");
  assert.equal(resolved.recorded, true);
  assert.deepEqual(await resolve("delivered"), { recorded: false, reason: "already_resolved" });
  assert.deepEqual(await readDecisionMakerDeliveryState(prisma, confirmed.requestId), {
    requestId: confirmed.requestId,
    judgmentKind: "confirm",
    delivered: true,
    outcome: "unknown",
    resolution: "not_delivered",
  });
  const rows = await prisma.$queryRaw<Array<{ kind: string; outcome: string | null; actorKind: string; actorUserId: string | null }>>`
    SELECT "kind", "outcome", "actorKind", "actorUserId" FROM "AmuxDecisionMakerDeliveryEvent" WHERE "requestId" = ${confirmed.requestId} ORDER BY "sequence"
  `;
  assert.deepEqual(rows, [
    { kind: "deliver", outcome: null, actorKind: "system", actorUserId: null },
    { kind: "delivery_unknown", outcome: null, actorKind: "system", actorUserId: null },
    { kind: "delivery_unknown_resolve", outcome: "not_delivered", actorKind: "human", actorUserId: "dm-operator-resolve" },
  ]);
  await setSwitch("kill_switch", "off");

  // A rejection is never delivered; a receipt settles a delivery, and leaves nothing to resolve.
  const rejected = await proposed();
  assert.equal((await judge(rejected.requestId, { kind: "reject" })).recorded, true);
  assert.deepEqual(await deliver(rejected.requestId), { recorded: false, reason: "not_confirmed" });
  await rejectsWith(directDelivery(rejected.requestId, "deliver"), /AMUX_DM_DELIVERY_TRANSITION/);
  const edited = await proposed();
  assert.equal((await judge(edited.requestId, { kind: "edit_confirm", shown: await shownOf(edited.requestId), operatorAnswer: "Use both." })).recorded, true);
  const editedDecision = await deliver(edited.requestId);
  assert.equal(editedDecision.recorded && editedDecision.judgmentKind, "edit_confirm");
  assert.equal((await outcome(edited.requestId, "receipt")).recorded, true);
  assert.deepEqual(
    await prisma.$transaction((tx) => resolveDecisionMakerDeliveryUnknown(tx, { session: person, requestId: edited.requestId, outcome: "delivered" })),
    { recorded: false, reason: "not_unknown" },
  );
});

test("each delivery event needs its own audit -- the router's, or the person's for a resolution -- and a rising sequence", async () => {
  const basis = await proposed();
  assert.equal((await judge(basis.requestId, { kind: "confirm", shown: await shownOf(basis.requestId) })).recorded, true);
  const wrong: Array<[string, (tx: Prisma.TransactionClient, id: string) => Promise<string>]> = [
    ["an instance's actor", (tx, id) => writeAudit(tx, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.deliver", targetType: DELIVERY, targetId: id })],
    ["the unknown outcome's action", (tx, id) => writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.delivery_unknown", targetType: DELIVERY, targetId: id })],
    ["another target", (tx) => writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.deliver", targetType: DELIVERY, targetId: randomUUID() })],
    ["a person", (tx, id) => writeAudit(tx, { kind: "person", action: "amux.decision.deliver", targetType: DELIVERY, targetId: id })],
  ];
  for (const [label, audit] of wrong) {
    await rejectsWith(directDelivery(basis.requestId, "deliver", audit), /AMUX_DM_DELIVERY_UNAUDITED/);
    assert.ok(label);
  }
  await directDelivery(basis.requestId, "deliver");
  // A receipt carries the router's deliver action too; the unknown outcome its own.
  await rejectsWith(
    directDelivery(basis.requestId, "delivery_unknown", (tx, id) => writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.deliver", targetType: DELIVERY, targetId: id })),
    /AMUX_DM_DELIVERY_UNAUDITED/,
  );
  await directDelivery(basis.requestId, "delivery_unknown");
  // A resolution is a person's own, with an outcome.
  const resolveWith = (row: Omit<DeliveryRow, "auditLogId">, audit: (tx: Prisma.TransactionClient, id: string) => Promise<string>) =>
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await insertDeliveryRow(tx, basis.requestId, { ...row, id, auditLogId: await audit(tx, id) });
    });
  const person = operator("dm-operator-direct");
  const personAudit = (tx: Prisma.TransactionClient, id: string) =>
    writeAudit(tx, { kind: "person", action: "amux.decision.delivery_unknown_resolve", targetType: DELIVERY, targetId: id, session: person });
  await rejectsWith(
    resolveWith({ kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "human", actorUserId: "dm-operator-other" }, personAudit),
    /AMUX_DM_DELIVERY_UNAUDITED/,
  );
  await rejectsWith(
    resolveWith({ kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "human", actorUserId: "dm-operator-direct" }, (tx, id) =>
      writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.delivery_unknown_resolve", targetType: DELIVERY, targetId: id }),
    ),
    /AMUX_DM_DELIVERY_UNAUDITED/,
  );
  // The shape on NULL, the guard set aside for the one insert: a resolution without its outcome or
  // its person, and a system event naming either.
  for (const row of [
    { kind: "delivery_unknown_resolve", outcome: null, actorKind: "human", actorUserId: "dm-operator-direct" },
    { kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "human", actorUserId: null },
    { kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "system", actorUserId: null },
    { kind: "delivery_receipt", outcome: "delivered", actorKind: "system", actorUserId: null },
    { kind: "delivery_receipt", outcome: null, actorKind: "system", actorUserId: "dm-operator-direct" },
    { kind: "delivery_receipt", outcome: null, actorKind: "human", actorUserId: "dm-operator-direct" },
  ]) {
    await rejectsWith(
      resolveWith(row, async (tx, id) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerDeliveryEvent" DISABLE TRIGGER "amux_decision_maker_delivery_event_guard"`);
        return personAudit(tx, id);
      }),
      /AmuxDecisionMakerDeliveryEvent_shape_check/,
    );
  }
  // With the guard in place a missing outcome passes the person's audit and meets the CHECK.
  await rejectsWith(
    resolveWith({ kind: "delivery_unknown_resolve", outcome: null, actorKind: "human", actorUserId: "dm-operator-direct" }, personAudit),
    /AmuxDecisionMakerDeliveryEvent_shape_check/,
  );
  await rejectsWith(resolveWith({ kind: "delivery_unknown_resolve", outcome: "maybe", actorKind: "human", actorUserId: "dm-operator-direct" }, personAudit), /AmuxDecisionMakerDeliveryEvent_outcome_check/);
  // Numbered below the request's newest event.
  await rejectsWith(resolveWith({ kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "human", actorUserId: "dm-operator-direct", sequence: 1 }, personAudit), /AMUX_DM_DELIVERY_OUT_OF_ORDER/);
  await resolveWith({ kind: "delivery_unknown_resolve", outcome: "delivered", actorKind: "human", actorUserId: "dm-operator-direct" }, personAudit);
  assert.equal((await readDecisionMakerDeliveryState(prisma, basis.requestId)).resolution, "delivered");
});

// ---------------------------------------------------------------------------
// The statement budget, through the AMUX boundary
// ---------------------------------------------------------------------------

test("an edited confirmation and a delivery decision commit through the AMUX boundary's 12 calls", async () => {
  const basis = await proposed();
  const shown = await shownOf(basis.requestId);
  const boundary = { operation: "dm_judgment_test", prismaCallCeiling: 12, isolation: "mutation" as const };
  const written = await withAmuxDbBoundary(boundary, (tx) =>
    recordDecisionMakerJudgment(tx, { session: operator(), requestId: basis.requestId, kind: "edit_confirm", shown, operatorAnswer: "Use both.", keyRing: RING }),
  );
  assert.equal(written.recorded, true);
  const decided = await withAmuxDbBoundary(boundary, (tx) => recordDecisionMakerDelivery(tx, { requestId: basis.requestId }));
  assert.equal(decided.recorded, true);
});

// 2026-10-09: the card text a routing stores sits beside every later body of its request. At
// every cap -- a 16 KiB card, an 8 KiB answer, a 4 KiB rationale and an 8 KiB edited answer --
// the request holds 36 KiB, under section 10's 40 KiB, and Admin still reads the card after the
// judgment closed the request.
test("a proposal routed with its card text at the cap takes the longest answers and an edited answer", async () => {
  const card = { ...CARD, context: "" };
  card.context = "x".repeat(16 * 1024 - Buffer.byteLength(dmCardText(card), "utf8"));
  const output: Output = { kind: "free_text", answer: "a".repeat(8 * 1024), rationale: "r".repeat(4 * 1024), irreversible: false };
  const basis = await proposed(output, "claude", { card, withCardText: true });
  const shown = await shownOf(basis.requestId);
  const boundary = { operation: "dm_judgment_card_text_test", prismaCallCeiling: 12, isolation: "mutation" as const };
  const written = await withAmuxDbBoundary(boundary, (tx) =>
    recordDecisionMakerJudgment(tx, { session: operator(), requestId: basis.requestId, kind: "edit_confirm", shown, operatorAnswer: "o".repeat(8 * 1024), keyRing: RING }),
  );
  assert.equal(written.recorded, true);
  const sizes = await prisma.$queryRaw<Array<{ field: string; octets: number }>>`
    SELECT "field", octet_length("text") AS "octets" FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${basis.requestId} ORDER BY "field"
  `;
  assert.deepEqual(sizes, [
    { field: "card_text", octets: 16 * 1024 },
    { field: "dm_answer", octets: 8 * 1024 },
    { field: "dm_rationale", octets: 4 * 1024 },
    { field: "operator_answer", octets: 8 * 1024 },
  ]);
  assert.equal((await eventsOf(basis.requestId)).at(-1)!.kind, "edit_confirm");
  const read = await readDecisionMakerCardText(prisma, basis.requestId);
  assert.deepEqual(read?.card, card);
  assert.equal(read?.digest, dmBodyDigest(basis.requestKey, "card_text", dmCardText(card)));
});

// ---------------------------------------------------------------------------
// Section 4's report
// ---------------------------------------------------------------------------

test("section 4's report counts each instance's judgments over their own denominators", async () => {
  const empty = await readDecisionMakerDeclarationAccuracyReport(prisma);
  for (const entry of empty.instances) {
    assert.equal(entry.decidedProposals.status, "insufficient_evidence");
    assert.equal(entry.daysSinceFirstProposal.status, "insufficient_evidence");
    assert.equal(entry.matchedOverJudged.status, "insufficient_evidence");
  }
  const first = await proposed();
  const second = await proposed();
  const third = await proposed();
  await proposed();
  assert.equal((await judge(first.requestId, { kind: "confirm", shown: await shownOf(first.requestId), accuracy: { accuracy: "matched" } })).recorded, true);
  assert.equal(
    (await judge(second.requestId, { kind: "edit_confirm", shown: await shownOf(second.requestId), operatorAnswer: "Use both.", accuracy: { accuracy: "mismatched", mismatchedItems: ["paths"] } })).recorded,
    true,
  );
  assert.equal((await judge(third.requestId, { kind: "reject" })).recorded, true);
  const report = await readDecisionMakerDeclarationAccuracyReport(prisma);
  const openai = report.instances.find((entry) => entry.instance === OPENAI)!;
  assert.deepEqual(openai.decidedProposals, { status: "measured", numerator: 3, denominator: 4, value: 0.75 });
  assert.deepEqual(openai.confirmedWithoutEdit, { status: "measured", numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(openai.matchedOverJudged, { status: "measured", numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(openai.notJudged, { status: "measured", numerator: 1, denominator: 3, value: 1 / 3 });
  assert.equal(openai.daysSinceFirstProposal.status === "measured" && openai.daysSinceFirstProposal.days, 0);
  const anthropic = report.instances.find((entry) => entry.instance === "decision-maker-anthropic")!;
  assert.equal(anthropic.decidedProposals.status, "insufficient_evidence");
  // The report changed no switch.
  const switches = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS "n" FROM "AmuxDecisionMakerSwitchEvent"`;
  assert.equal(Number(switches[0]!.n), 2);
});

// ---------------------------------------------------------------------------
// The S1d review follow-up: the stale close at 720 hours
// ---------------------------------------------------------------------------

/** A request routed to a DM, created `ageMs` ago by the database clock (its guard set aside for the one insert). */
const backdatedRequest = (ageMs: number) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const auditLogId = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: id });
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" DISABLE TRIGGER "amux_decision_maker_request_guard"`);
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequest"
        ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
         "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
         "scannerVersion", "route", "instance", "refusalCodes", "auditLogId", "createdAt", "assignmentDeadlineAt")
      SELECT ${id}, ${`card-stale-${id}`}, 1, 'worker.claude-1', 'session:1', 1, 'claude', ${"a".repeat(64)}, 1, 'v1',
             'authority-manifest-1', 'v1', 'dm_proposal', ${OPENAI}, ARRAY[]::text[], ${auditLogId},
             t."createdAt", t."createdAt" + INTERVAL '2 minutes'
      FROM (SELECT date_trunc('milliseconds', clock_timestamp() - ${ageMs} * INTERVAL '1 millisecond') AS "createdAt") t
    `;
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" ENABLE TRIGGER "amux_decision_maker_request_guard"`);
    return id;
  });

/**
 * A POSIX time zone whose daylight saving began ten days ago (and ends in 170
 * days), by the database clock's day of the year: a 30-day calendar interval
 * that spans it is 719 hours long. Deterministic whatever the date of the run.
 */
const zoneWithRecentDstStart = async () => {
  const doy = Number((await prisma.$queryRaw<Array<{ doy: number }>>`SELECT extract(doy FROM clock_timestamp() AT TIME ZONE 'UTC')::int AS "doy"`)[0]!.doy);
  return `XST0XDT,${(doy - 1 - 10 + 365) % 365}/0,${(doy - 1 + 170) % 365}/0`;
};

/** A stale close written past the store, in the given session time zone, under the router's audit. */
const directStaleClose = (requestId: string, zone: string) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
    const id = randomUUID();
    const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.stale_close", targetType: EVENT, targetId: id });
    await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "auditLogId") VALUES (${id}, ${requestId}, 'stale_close', ${audit})`;
  });

test("an open request closes as stale 720 hours after its creation, also across a daylight-saving change in the session's time zone", async () => {
  const zone = await zoneWithRecentDstStart();
  // The zone is what the test claims: a 30-day calendar interval across it is 719 hours, so the
  // previous guard would have closed a request 719.5 hours old. One clock reading anchors every
  // term: clock_timestamp() moves between calls inside a statement, and two readings a few
  // microseconds apart once made the 719 come back as 718.9999999997.
  const probe = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
    return tx.$queryRaw<Array<{ calendar: boolean; fixed: boolean; hours: number }>>`
      SELECT
        (t."now" - INTERVAL '719 hours 30 minutes') + INTERVAL '30 days' <= t."now" AS "calendar",
        (t."now" - INTERVAL '719 hours 30 minutes') + INTERVAL '720 hours' <= t."now" AS "fixed",
        (extract(epoch FROM ((t."now" - INTERVAL '30 days') + INTERVAL '30 days') - (t."now" - INTERVAL '30 days')) / 3600)::float8 AS "hours"
      FROM (SELECT clock_timestamp() AS "now") t
    `;
  });
  assert.deepEqual(probe, [{ calendar: true, fixed: false, hours: 719 }]);

  for (const timeZone of ["UTC", zone]) {
    const young = await backdatedRequest(719.5 * HOUR);
    // The store counts 720 hours exactly, and the guard now agrees in any session time zone.
    assert.deepEqual(await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: young })), { recorded: false, reason: "not_stale" });
    await rejectsWith(directStaleClose(young, timeZone), /AMUX_DM_REQUEST_EVENT_TRANSITION/);
    const old = await backdatedRequest(720 * HOUR + 60_000);
    await directStaleClose(old, timeZone);
    assert.equal((await eventsOf(old)).at(-1)!.kind, "stale_close");
    const throughStore = await backdatedRequest(720 * HOUR + 60_000);
    assert.equal((await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: throughStore }))).recorded, true);
  }
});
