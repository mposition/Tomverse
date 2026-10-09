import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  DM_KEY_PERIOD_MS,
  dmBodyDigest,
  dmDigestKeyCheck,
  dmKeyPeriodOf,
  dmKeyPeriodStartMs,
  dmOptionSetDigest,
  dmRequestDigestKey,
  dmResultDigest,
} from "@/lib/amux/decisionMakerBodyCore";
import {
  DecisionMakerBodyWriteError,
  assignDecisionMakerRequestWithDigestKey,
  destroyDecisionMakerDigestKey,
  eraseDecisionMakerBodies,
  listDecisionMakerPurgeCandidates,
  purgeDecisionMakerBodies,
  readDecisionMakerBodies,
  readDecisionMakerBodyRetention,
  readDecisionMakerCardText,
  readDecisionMakerResultDetail,
  recordDecisionMakerLegalHold,
  recordDecisionMakerRequestWithCardText,
  rotateDecisionMakerDigestKey,
  submitDecisionMakerOutput,
} from "@/lib/amux/decisionMakerBodyStore";
import { dmCardText } from "@/lib/amux/decisionMakerCore";
import {
  DecisionMakerRequestWriteError,
  discardDecisionMakerAssignment,
  readDecisionMakerRequestState,
  recordDecisionMakerRequest,
  recordDecisionMakerTransmitIntent,
  staleCloseDecisionMakerRequest,
} from "@/lib/amux/decisionMakerRequestStore";
import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { prisma } from "@/lib/prisma";

// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// stage S1d, against PostgreSQL through the migration history
// (20261008120000_amux_decision_maker_body_store), in the agents lane of the
// DB integration suite.
//
// §12's blocking test covered here: "보존 사건 표의 삽입 조건(retention_set
// 하나, hold 전이 순서)과 본문 삭제 조건 테스트". The rest cover what the
// migration header says the database enforces: the body CHECKs and caps, one
// row per field, the audit row of the same transaction for every row and every
// delete, the key period and its registered key, the stale close and its
// retention 90 days after the close, the purge only after the retention with
// no hold open, the privacy erase, the key destruction refused while a body, a
// hold or an open request of its period remains, no update, READ COMMITTED
// only, and every operation section 6's table allows under the kill switch.
// The S1c review minor (a switch read that fails aborts the transaction) is
// exercised here too. The writer's own statements are counted in
// tests/amuxDecisionMakerBody.test.mjs.

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

// The tables refuse DELETE (or allow it only under their rules); TRUNCATE
// fires no row trigger, so each test starts empty.
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

beforeEach(async () => {
  await resetAll();
  await setSwitch("decision-maker-openai", "proposal");
  await setSwitch("decision-maker-anthropic", "proposal");
});

after(async () => {
  await resetAll();
  await prisma.$disconnect();
});

const REQUEST = "AmuxDecisionMakerRequest";
const EVENT = "AmuxDecisionMakerRequestEvent";
const OPENAI = "decision-maker-openai";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const CHECK = dmDigestKeyCheck(KEY);

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

const dbNowMs = async () =>
  Number((await prisma.$queryRaw<Array<{ now: bigint }>>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "now"`)[0]!.now);

const rotate = (keyPeriod: number, key = KEY) =>
  prisma.$transaction((tx) => rotateDecisionMakerDigestKey(tx, { keyPeriod, keyRing: new Map([[keyPeriod, key]]) }));

let cardCounter = 0;

type BodyRow = { field: string; text: string; keyPeriod?: number; keyCheck?: string; digest?: string; auditLogId: string };

const insertBodyRow = (tx: Prisma.TransactionClient, requestId: string, keyPeriod: number, row: BodyRow) =>
  tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerBody" ("id", "requestId", "field", "text", "keyPeriod", "keyCheck", "digest", "auditLogId")
    VALUES (${randomUUID()}, ${requestId}, ${row.field}, ${row.text}, ${row.keyPeriod ?? keyPeriod}, ${row.keyCheck ?? CHECK},
            ${row.digest ?? dmBodyDigest(dmRequestDigestKey(KEY, requestId), "card_text", row.text)}, ${row.auditLogId})
  `;

/**
 * A request routed to a DM, created `ageMs` ago by the database clock, and
 * optionally its card text stored in the same transaction under the route
 * audit. The request guard sets `createdAt` itself, so it is disabled for the
 * request insert only, in the test's own transaction.
 */
const backdatedRequest = (
  ageMs: number,
  options: { card?: string | null; route?: "dm_proposal" | "operator"; cardAudit?: "own" | "none" } = {},
) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    cardCounter += 1;
    const route = options.route ?? "dm_proposal";
    const auditLogId = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: id });
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" DISABLE TRIGGER "amux_decision_maker_request_guard"`);
    const rows = await tx.$queryRaw<Array<{ createdAtEpochMs: bigint }>>`
      INSERT INTO "AmuxDecisionMakerRequest"
        ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
         "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
         "scannerVersion", "route", "instance", "refusalCodes", "auditLogId", "createdAt", "assignmentDeadlineAt")
      SELECT ${id}, ${`card-body-${cardCounter}`}, 1, 'worker.claude-1', 'session:1', 1, 'claude', ${DIGEST_A}, 1, 'v1',
             'authority-manifest-1', 'v1', ${route}, ${OPENAI},
             ${route === "operator" ? ["instance_off"] : []}::text[], ${auditLogId},
             t."createdAt", t."createdAt" + INTERVAL '2 minutes'
      FROM (SELECT date_trunc('milliseconds', clock_timestamp() - ${ageMs} * INTERVAL '1 millisecond') AS "createdAt") t
      RETURNING floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
    `;
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" ENABLE TRIGGER "amux_decision_maker_request_guard"`);
    const createdAtMs = Number(rows[0]!.createdAtEpochMs);
    const keyPeriod = dmKeyPeriodOf(createdAtMs);
    if (options.card) {
      const cardAudit =
        options.cardAudit === "none"
          ? await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.assign", targetType: REQUEST, targetId: id })
          : auditLogId;
      await insertBodyRow(tx, id, keyPeriod, { field: "card_text", text: options.card, auditLogId: cardAudit });
    }
    return { id, createdAtMs, keyPeriod, auditLogId };
  });

/**
 * The request's closing event, `ageMs` ago by the database clock, under the
 * router's audit of the same transaction. The ledger's guard is disabled for
 * this one insert so the close can be placed in the past; the closing trigger
 * of this stage is not, and writes the retention from the close.
 */
const backdatedClose = (requestId: string, ageMs: number, kind: "stale_close" | "assign_discarded" = "stale_close") =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const auditLogId = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: `amux.decision.${kind}`, targetType: EVENT, targetId: id });
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" DISABLE TRIGGER "amux_decision_maker_request_event_guard"`);
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "auditLogId", "createdAt")
      SELECT ${id}, ${requestId}, ${kind}, ${auditLogId}, date_trunc('milliseconds', clock_timestamp() - ${ageMs} * INTERVAL '1 millisecond')
    `;
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" ENABLE TRIGGER "amux_decision_maker_request_event_guard"`);
    return id;
  });

const retentionRows = (requestId: string) =>
  prisma.$queryRaw<Array<{ kind: string; retentionUntilMs: bigint | null; actorKind: string; actorUserId: string | null; auditLogId: string; keyPeriod: number }>>`
    SELECT "kind", floor(extract(epoch FROM "retentionUntil") * 1000)::bigint AS "retentionUntilMs", "actorKind", "actorUserId", "auditLogId", "keyPeriod"
    FROM "AmuxDecisionMakerRetentionEvent" WHERE "requestId" = ${requestId} ORDER BY "sequence"
  `;

const bodyFields = async (requestId: string) =>
  (await prisma.$queryRaw<Array<{ field: string }>>`SELECT "field" FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${requestId} ORDER BY "field"`).map(
    (row) => row.field,
  );

/** The current key period by the database clock, rotated in with KEY. */
const currentPeriod = async () => {
  const period = dmKeyPeriodOf(await dbNowMs());
  assert.equal((await rotate(period)).recorded, true);
  return period;
};

/**
 * The current period and the `back` periods before it, rotated in with KEY:
 * a request backdated by up to that many periods can store its card.
 */
const rotateRecentPeriods = async (back = 5) => {
  const current = dmKeyPeriodOf(await dbNowMs());
  for (let period = current - back; period <= current; period += 1) {
    assert.equal((await rotate(period)).recorded, true);
  }
  return current;
};

/** A request in an earlier key period, `periodsBack` periods back, a day into it. */
const ageIntoPeriod = async (periodsBack: number) => {
  const now = await dbNowMs();
  const period = dmKeyPeriodOf(now) - periodsBack;
  return { period, ageMs: now - (dmKeyPeriodStartMs(period) + DAY) };
};

// ---------------------------------------------------------------------------
// Bodies: caps, linkage, key, immutability
// ---------------------------------------------------------------------------

test("a body holds one of the five fields, within its cap in bytes, once per field", async () => {
  const period = await currentPeriod();
  const inserts: Array<[BodyRow, RegExp]> = [
    // Not one of the five: the guard finds nothing it could belong to before the CHECK is reached.
    [{ field: "dm_verdict", text: "x", auditLogId: "" }, /AMUX_DM_BODY_UNAUDITED|AmuxDecisionMakerBody_field_check/],
    [{ field: "card_text", text: "", auditLogId: "" }, /AmuxDecisionMakerBody_text_size_check/],
    [{ field: "card_text", text: "x".repeat(16 * 1024 + 1), auditLogId: "" }, /AmuxDecisionMakerBody_text_size_check/],
    // Bytes, not characters: 5,462 three-byte characters are 16,386 bytes.
    [{ field: "card_text", text: "가".repeat(5_462), auditLogId: "" }, /AmuxDecisionMakerBody_text_size_check/],
    [{ field: "card_text", text: "x", digest: "A".repeat(64), auditLogId: "" }, /AmuxDecisionMakerBody_digest_format_check/],
    // Not the registered key check value: the guard's refusal comes first.
    [{ field: "card_text", text: "x", keyCheck: "short", auditLogId: "" }, /AMUX_DM_BODY_KEY|AmuxDecisionMakerBody_digest_format_check/],
  ];
  for (const [row, pattern] of inserts) {
    await rejectsWith(
      prisma.$transaction(async (tx) => {
        const created = await backdatedRequestIn(tx);
        await insertBodyRow(tx, created.id, period, { ...row, auditLogId: created.auditLogId });
      }),
      pattern,
    );
  }
  // At the cap exactly it is stored; a second card text for the request is not.
  const stored = await prisma.$transaction(async (tx) => {
    const created = await backdatedRequestIn(tx);
    await insertBodyRow(tx, created.id, period, { field: "card_text", text: "가".repeat(5_461) + "x", auditLogId: created.auditLogId });
    return created.id;
  });
  assert.deepEqual(await bodyFields(stored), ["card_text"]);
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const created = await backdatedRequestIn(tx);
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "one", auditLogId: created.auditLogId });
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "two", auditLogId: created.auditLogId });
    }),
    /AmuxDecisionMakerBody_requestId_field_key|unique/i,
  );
});

/** A fresh request routed to a DM, inserted through its guard in the caller's transaction. */
const backdatedRequestIn = async (tx: Prisma.TransactionClient, route: "dm_proposal" | "operator" = "dm_proposal") => {
  const id = randomUUID();
  cardCounter += 1;
  const auditLogId = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: id });
  await tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerRequest"
      ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
       "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
       "scannerVersion", "route", "instance", "refusalCodes", "auditLogId", "assignmentDeadlineAt")
    VALUES (${id}, ${`card-body-${cardCounter}`}, 1, 'worker.claude-1', 'session:1', 1, 'claude', ${DIGEST_A}, 1, 'v1',
            'authority-manifest-1', 'v1', ${route}, ${OPENAI}, ${route === "operator" ? ["instance_off"] : []}::text[],
            ${auditLogId}, '2001-01-01T00:00:00Z'::timestamptz)
  `;
  return { id, auditLogId };
};

test("a card text belongs to its own routing: an open request routed to a DM, under its own route audit", async () => {
  const period = await currentPeriod();
  // Accepted with the request's own route audit of the same transaction.
  await prisma.$transaction(async (tx) => {
    const created = await backdatedRequestIn(tx);
    await insertBodyRow(tx, created.id, period, { field: "card_text", text: "Pick a cache key layout.", auditLogId: created.auditLogId });
  });
  // Not under another audit of the transaction, nor another request's route.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const created = await backdatedRequestIn(tx);
      const other = await backdatedRequestIn(tx);
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "x", auditLogId: other.auditLogId });
    }),
    /AMUX_DM_BODY_UNAUDITED/,
  );
  // Not for a request routed to the operator, which is closed from its creation.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const created = await backdatedRequestIn(tx, "operator");
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "x", auditLogId: created.auditLogId });
    }),
    /AMUX_DM_BODY_CLOSED/,
  );
  // Not in a transaction after the routing.
  const earlier = await backdatedRequest(0);
  await rejectsWith(
    prisma.$transaction((tx) => insertBodyRow(tx, earlier.id, period, { field: "card_text", text: "x", auditLogId: earlier.auditLogId })),
    /AMUX_DM_BODY_UNAUDITED/,
  );
  // An operator's answer needs a person's edit_confirm naming the request.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await writeAudit(tx, { kind: "person", action: "amux.decision.edit_confirm", targetType: REQUEST, targetId: earlier.id, metadata: { request_id: randomUUID() } });
      await insertBodyRow(tx, earlier.id, period, { field: "operator_answer", text: "x", auditLogId: audit });
    }),
    /AMUX_DM_BODY_UNAUDITED/,
  );
  // ... and targeting it: an edit_confirm aimed at another row does not carry this request's answer.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await writeAudit(tx, { kind: "person", action: "amux.decision.edit_confirm", targetType: REQUEST, targetId: randomUUID(), metadata: { request_id: earlier.id } });
      await insertBodyRow(tx, earlier.id, period, { field: "operator_answer", text: "x", auditLogId: audit });
    }),
    /AMUX_DM_BODY_UNAUDITED/,
  );
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await writeAudit(tx, { kind: "person", action: "amux.decision.edit_confirm", targetType: EVENT, targetId: earlier.id, metadata: { request_id: earlier.id } });
      await insertBodyRow(tx, earlier.id, period, { field: "operator_answer", text: "x", auditLogId: audit });
    }),
    /AMUX_DM_BODY_UNAUDITED/,
  );
  await prisma.$transaction(async (tx) => {
    const audit = await writeAudit(tx, { kind: "person", action: "amux.decision.edit_confirm", targetType: REQUEST, targetId: earlier.id, metadata: { request_id: earlier.id } });
    await insertBodyRow(tx, earlier.id, period, { field: "operator_answer", text: "Use the locale too.", auditLogId: audit });
  });
  assert.deepEqual(await bodyFields(earlier.id), ["operator_answer"]);
});

test("a body is keyed by its request's period and that period's registered key, never another", async () => {
  const period = dmKeyPeriodOf(await dbNowMs());
  // No key registered for the period yet.
  await rejectsWith(backdatedRequest(0, { card: "x" }), /AMUX_DM_BODY_KEY(?!_PERIOD)/);
  await rotate(period);
  await backdatedRequest(0, { card: "x" });
  // Another key's check value, or another period.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const created = await backdatedRequestIn(tx);
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "x", keyCheck: dmDigestKeyCheck(OTHER_KEY), auditLogId: created.auditLogId });
    }),
    /AMUX_DM_BODY_KEY(?!_PERIOD)/,
  );
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const created = await backdatedRequestIn(tx);
      await insertBodyRow(tx, created.id, period, { field: "card_text", text: "x", keyPeriod: period - 1, auditLogId: created.auditLogId });
    }),
    /AMUX_DM_BODY_KEY_PERIOD/,
  );
});

test("a body is never changed, and only READ COMMITTED writes one", async () => {
  await currentPeriod();
  const created = await backdatedRequest(0, { card: "Pick a cache key layout." });
  await rejectsWith(
    prisma.$executeRaw`UPDATE "AmuxDecisionMakerBody" SET "text" = 'changed' WHERE "requestId" = ${created.id}`,
    /AMUX_DM_BODY_IMMUTABLE/,
  );
  await rejectsWith(
    prisma.$transaction(
      async (tx) => {
        const audit = await writeAudit(tx, { kind: "person", action: "amux.decision.edit_confirm", targetType: REQUEST, targetId: created.id, metadata: { request_id: created.id } });
        await insertBodyRow(tx, created.id, created.keyPeriod, { field: "operator_answer", text: "x", auditLogId: audit });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    ),
    /AMUX_DM_BODY_ISOLATION/,
  );
});

// ---------------------------------------------------------------------------
// The card text, stored by the routing itself (2026-10-09): the request and
// its card text are written together through the stores, never by SQL here.
// ---------------------------------------------------------------------------

const routingBindingFor = (askingProvider = "claude") => ({
  cardId: `card-text-${randomUUID()}`,
  questionRevision: 1,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:7",
  amuxSessionAttempt: 1,
  askingProvider,
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
});

const ROUTED_CARD = {
  askType: "decision",
  resolution: null,
  type: "task",
  tags: ["needs:you"],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: [
    { id: "a", label: "Model id only" },
    { id: "b", label: "Model id and locale" },
  ],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.\nQuoted \"exactly\", with a back\\slash.",
  contextPaths: ["lib/cache.ts"],
};

/** The route transaction's whole budget: the boundary's setup and fence, the routing and its card text. */
const ROUTE_BOUNDARY = { operation: "dm_route_card_text_test", prismaCallCeiling: 12, isolation: "mutation" as const };

test("a question routed to a DM keeps its card text from its own routing, and Admin reads it back", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const binding = routingBindingFor();
  // A card at §5's cap exactly, so the stored text is the largest the router sends.
  const card = { ...ROUTED_CARD, context: "" };
  card.context = "x".repeat(16 * 1024 - Buffer.byteLength(dmCardText(card), "utf8"));
  assert.equal(Buffer.byteLength(dmCardText(card), "utf8"), 16 * 1024);
  for (const routedCard of [ROUTED_CARD, card]) {
    const routedBinding = routedCard === ROUTED_CARD ? binding : routingBindingFor();
    const routed = await withAmuxDbBoundary(ROUTE_BOUNDARY, (tx) =>
      recordDecisionMakerRequestWithCardText(tx, { binding: routedBinding, card: routedCard, keyRing: ring }),
    );
    assert.equal(routed.created, true);
    assert.equal(routed.route, "dm_proposal");
    const text = dmCardText(routedCard);
    const digest = dmBodyDigest(dmRequestDigestKey(KEY, routed.requestId), "card_text", text);
    assert.deepEqual(routed.cardText, { digest, keyPeriod: period, bytes: Buffer.byteLength(text, "utf8") });
    // What Admin shows: the card as routed, its stored text and its keyed digest.
    const read = await readDecisionMakerCardText(prisma, routed.requestId);
    assert.ok(read);
    assert.deepEqual(read.card, routedCard);
    assert.equal(read.text, text);
    assert.equal(read.digest, digest);
    assert.equal(read.keyPeriod, period);
    // One body, bound to the request row's own route audit -- the router's, of the routing's transaction.
    const rows = await prisma.$queryRaw<Array<{ bodyAudit: string; requestAudit: string; action: string; actor: string; octets: number }>>`
      SELECT b."auditLogId" AS "bodyAudit", r."auditLogId" AS "requestAudit", a."action", a."metadata" ->> 'systemActor' AS "actor",
             octet_length(b."text") AS "octets"
      FROM "AmuxDecisionMakerBody" b
      JOIN "AmuxDecisionMakerRequest" r ON r."id" = b."requestId"
      JOIN "AdminAuditLog" a ON a."id" = b."auditLogId"
      WHERE b."requestId" = ${routed.requestId}
    `;
    assert.deepEqual(rows, [
      {
        bodyAudit: routed.routeAuditLogId,
        requestAudit: routed.routeAuditLogId,
        action: "amux.decision.route",
        actor: "amux-decision-router",
        octets: Buffer.byteLength(text, "utf8"),
      },
    ]);
    assert.deepEqual((await readDecisionMakerBodies(prisma, routed.requestId)).map((body) => [body.field, body.digest]), [["card_text", digest]]);
    // The audit entry names the request, never the card.
    const audit = await prisma.$queryRaw<Array<{ metadata: unknown; summary: string }>>`
      SELECT "metadata", "summary" FROM "AdminAuditLog" WHERE "id" = ${routed.routeAuditLogId}
    `;
    assert.doesNotMatch(JSON.stringify(audit), /cache key|Model id only|xxxxxxxx/);
  }
  // The same question again: its first routing stands, with its one card text.
  const first = (await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "AmuxDecisionMakerRequest" WHERE "cardId" = ${binding.cardId}`)[0]!.id;
  const again = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx, { binding, card: ROUTED_CARD, keyRing: ring }));
  assert.deepEqual([again.created, again.requestId, again.sameBinding, again.cardText], [false, first, true, null]);
  assert.deepEqual(await bodyFields(first), ["card_text"]);
  // And it cannot be stored again later: the guard binds a card text to the routing's own transaction.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: first });
      await insertBodyRow(tx, first, period, { field: "card_text", text: "Another card.", auditLogId: audit });
    }),
    /AMUX_DM_BODY_UNAUDITED|AmuxDecisionMakerBody_requestId_field_key|unique/i,
  );
});

test("a question routed to the operator stores no card text, and one the registry cannot key leaves no request", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  // Built at runtime, so no literal in this file looks like a credential.
  const pat = ["gh", "p_", "d".repeat(36)].join("");
  const operatorCases: Array<[ReturnType<typeof routingBindingFor>, typeof ROUTED_CARD, string]> = [
    [routingBindingFor("gemini"), ROUTED_CARD, "provider_unverified"],
    [routingBindingFor(), { ...ROUTED_CARD, question: "Deploy the cache to production?" }, "irreversible_term"],
    // Section 3-8: a card with a secret is never sent to a DM, and never stored.
    [routingBindingFor(), { ...ROUTED_CARD, context: `see ${pat}` }, "card_secret_detected"],
    // Section 5: over 16 KiB of card text.
    [routingBindingFor(), { ...ROUTED_CARD, context: "x".repeat(16 * 1024) }, "input_limit_exceeded"],
  ];
  for (const [binding, card, refusal] of operatorCases) {
    const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx, { binding, card, keyRing: ring }));
    assert.equal(routed.created, true, refusal);
    assert.equal(routed.route, "operator", refusal);
    assert.deepEqual(routed.refusalCodes, [refusal]);
    assert.equal(routed.cardText, null, refusal);
    assert.equal(await readDecisionMakerCardText(prisma, routed.requestId), null, refusal);
    assert.deepEqual(await bodyFields(routed.requestId), [], refusal);
  }
  // The ring's key for the period is not the registered one: the card text is not stored, the
  // store says so, and the routing's audit and request roll back with it.
  const binding = routingBindingFor();
  const audits = async () =>
    Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS "n" FROM "AdminAuditLog" WHERE "action" = 'amux.decision.route'`)[0]!.n);
  const before = await audits();
  let caught: unknown = null;
  try {
    await prisma.$transaction((tx) =>
      recordDecisionMakerRequestWithCardText(tx, { binding, card: ROUTED_CARD, keyRing: new Map([[period, OTHER_KEY]]) }),
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DecisionMakerBodyWriteError, String(caught));
  assert.equal((caught as DecisionMakerBodyWriteError).code, "digest_key_unavailable");
  assert.deepEqual(await prisma.$queryRaw`SELECT 1 FROM "AmuxDecisionMakerRequest" WHERE "cardId" = ${binding.cardId}`, []);
  assert.equal(await audits(), before);
  // The registered key routes the same question, with its card text.
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequestWithCardText(tx, { binding, card: ROUTED_CARD, keyRing: ring }));
  assert.equal(routed.route, "dm_proposal");
  assert.deepEqual(await bodyFields(routed.requestId), ["card_text"]);
});

// ---------------------------------------------------------------------------
// The DM's output: the app's digest, its bodies, and the kill switch
// ---------------------------------------------------------------------------

const OPTIONS = [
  { id: "a", label: "Model id only" },
  { id: "b", label: "Model id and locale" },
];

const routeAssignAndTransmit = async (ring: Map<number, Buffer>) => {
  const binding = {
    cardId: `card-output-${randomUUID()}`,
    questionRevision: 1,
    askingWorkerId: "worker.claude-1",
    amuxSessionId: "session:7",
    amuxSessionAttempt: 1,
    askingProvider: "claude",
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
  };
  const card = {
    askType: "decision",
    resolution: null,
    type: "task",
    tags: [],
    title: "Pick a cache key layout",
    question: "Should the cache key include the locale or only the model id?",
    options: OPTIONS,
    unblocks: "The cache module can be finished.",
    context: "Both layouts pass the current tests.",
    contextPaths: ["lib/cache.ts"],
  };
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequest(tx, { binding, card, keyRing: ring }));
  assert.equal(routed.route, "dm_proposal");
  const assigned = await prisma.$transaction((tx) =>
    assignDecisionMakerRequestWithDigestKey(tx, { requestId: routed.requestId, requireLeaseAt: () => {}, keyRing: ring }),
  );
  assert.equal(assigned.recorded, true);
  const requestKey = (assigned as { requestKey: Buffer }).requestKey;
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  const intent = await prisma.$transaction((tx) =>
    recordDecisionMakerTransmitIntent(tx, { requestId: routed.requestId, instance: OPENAI, transmission, requireLeaseAt: () => {} }),
  );
  assert.equal(intent.recorded, true);
  // A result repeats every stored binding value but the provider, which its instance already is.
  const stored: Record<string, unknown> = { ...(await readDecisionMakerRequestState(prisma, routed.requestId))!.binding };
  delete stored.askingProvider;
  return { requestId: routed.requestId, requestKey, resultBinding: { ...stored, transmission } };
};

const resultEvents = (requestId: string) =>
  prisma.$queryRaw<Array<{ kind: string }>>`
    SELECT "kind" FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} AND "kind" IN ('result', 'result_rejected')
  `;

test("the option set is the store's keyed digest of the card's options, and a result must bring the same options", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const { requestId, requestKey, resultBinding } = await routeAssignAndTransmit(ring);
  const state = (await readDecisionMakerRequestState(prisma, requestId))!;
  // Keyed under the request's own key, never a plain hash of the labels.
  assert.equal(state.binding.optionSetDigest, dmOptionSetDigest(requestKey, OPTIONS));
  const submitWith = (options: Array<{ id: string; label: string }>, optionId: string) =>
    prisma.$transaction((tx) =>
      submitDecisionMakerOutput(tx, {
        requestId,
        instance: OPENAI,
        binding: resultBinding,
        output: { kind: "output", raw: JSON.stringify({ kind: "select", optionId, rationale: "r", irreversible: false }), options },
        requireLeaseAt: () => {},
        keyRing: ring,
      }),
    );
  // A fake id added to the output and the list, or a real one dropped to force a validation failure:
  // both refused before the ledger is touched.
  assert.deepEqual(await submitWith([...OPTIONS, { id: "c", label: "Ship it" }], "c"), { status: "option_set_mismatch" });
  assert.deepEqual(await submitWith(OPTIONS.slice(0, 1), "b"), { status: "option_set_mismatch" });
  // The request's own options, but the ring holds another key for the period than the registered
  // one: the digest cannot match, and the store says why -- the key, never the options.
  const underOtherKey = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, {
      requestId,
      instance: OPENAI,
      binding: resultBinding,
      output: { kind: "output", raw: JSON.stringify({ kind: "select", optionId: "a", rationale: "r", irreversible: false }), options: OPTIONS },
      requireLeaseAt: () => {},
      keyRing: new Map([[period, OTHER_KEY]]),
    }),
  );
  assert.deepEqual(underOtherKey, { status: "digest_key_unavailable" });
  assert.deepEqual(await resultEvents(requestId), []);
  assert.deepEqual(await prisma.$queryRaw`SELECT 1 FROM "AmuxDecisionMakerResultDetail" WHERE "requestId" = ${requestId}`, []);
  // The request's own options, in any order, are accepted.
  const accepted = await submitWith([...OPTIONS].reverse(), "b");
  assert.equal(accepted.status === "submitted" && accepted.result.status, "accepted");
});

test("a DM output is digested by the app under the request key, and its detail and bodies are stored with the result", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const { requestId, requestKey, resultBinding } = await routeAssignAndTransmit(ring);
  // The broker's key is the request key the database's period key derives.
  assert.deepEqual(requestKey, dmRequestDigestKey(KEY, requestId));

  const raw = JSON.stringify({ kind: "free_text", answer: "Use the model id only.", rationale: "The locale is already in the path.", irreversible: true });
  const submit = () =>
    prisma.$transaction((tx) =>
      submitDecisionMakerOutput(tx, { requestId, instance: OPENAI, binding: resultBinding, output: { kind: "output", raw, options: OPTIONS }, requireLeaseAt: () => {}, keyRing: ring }),
    );
  const first = await submit();
  assert.equal(first.status, "submitted");
  if (first.status !== "submitted") return;
  assert.equal(first.result.status, "accepted");
  assert.equal(first.resultDigest, dmResultDigest(requestKey, { kind: "output", raw }));
  assert.deepEqual(first.storedFields, ["dm_answer", "dm_rationale"]);
  const ledger = await prisma.$queryRaw<Array<{ resultDigest: string }>>`
    SELECT "resultDigest" FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} AND "kind" = 'result'
  `;
  assert.deepEqual(ledger, [{ resultDigest: first.resultDigest }]);
  // Section 6: the irreversible flag is kept with the result, for Admin to show first.
  const detail = await prisma.$transaction((tx) => readDecisionMakerResultDetail(tx, requestId));
  assert.deepEqual(detail && [detail.resultKind, detail.outputKind, detail.optionId, detail.irreversible, detail.keyPeriod], [
    "proposal",
    "free_text",
    null,
    true,
    period,
  ]);
  const bodies = await prisma.$transaction((tx) => readDecisionMakerBodies(tx, requestId));
  assert.deepEqual(
    bodies.map((body) => [body.field, body.text, body.digest, body.keyPeriod]),
    [
      ["dm_answer", "Use the model id only.", dmBodyDigest(requestKey, "dm_answer", "Use the model id only."), period],
      ["dm_rationale", "The locale is already in the path.", dmBodyDigest(requestKey, "dm_rationale", "The locale is already in the path."), period],
    ],
  );
  // The same output again is the same pair: the ledger's result, and no second detail or bodies.
  const again = await submit();
  assert.equal(again.status === "submitted" && again.result.status, "existing");
  assert.equal((await bodyFields(requestId)).length, 2);

  // A DM field's body needs the request's result of its kind, recorded in its own transaction.
  const resultAudit = (await prisma.$queryRaw<Array<{ auditLogId: string }>>`
    SELECT "auditLogId" FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} AND "kind" = 'result'
  `)[0]!.auditLogId;
  for (const field of ["dm_escalation_reason", "dm_answer"]) {
    await rejectsWith(
      prisma.$transaction((tx) => insertBodyRow(tx, requestId, period, { field, text: "late", auditLogId: resultAudit })),
      /AMUX_DM_BODY_UNAUDITED|AmuxDecisionMakerBody_requestId_field_key|unique/i,
    );
  }
  // The detail is never changed or removed.
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerResultDetail" SET "irreversible" = false`, /AMUX_DM_RESULT_DETAIL_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerResultDetail"`, /AMUX_DM_RESULT_DETAIL_IMMUTABLE/);
});

test("a select keeps its chosen option, and a timeout has a detail with no output", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const chosen = await routeAssignAndTransmit(ring);
  const select = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, {
      requestId: chosen.requestId,
      instance: OPENAI,
      binding: chosen.resultBinding,
      output: { kind: "output", raw: JSON.stringify({ kind: "select", optionId: "b", rationale: "Smaller key.", irreversible: false }), options: OPTIONS },
      requireLeaseAt: () => {},
      keyRing: ring,
    }),
  );
  assert.equal(select.status === "submitted" && select.result.status, "accepted");
  const selected = await prisma.$transaction((tx) => readDecisionMakerResultDetail(tx, chosen.requestId));
  assert.deepEqual(selected && [selected.resultKind, selected.outputKind, selected.optionId, selected.irreversible], ["proposal", "select", "b", false]);

  const timedOut = await routeAssignAndTransmit(ring);
  const timeout = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, { requestId: timedOut.requestId, instance: OPENAI, binding: timedOut.resultBinding, output: { kind: "timeout" }, requireLeaseAt: () => {}, keyRing: ring }),
  );
  assert.equal(timeout.status === "submitted" && timeout.result.status, "accepted");
  const detail = await prisma.$transaction((tx) => readDecisionMakerResultDetail(tx, timedOut.requestId));
  assert.deepEqual(detail && [detail.resultKind, detail.outputKind, detail.optionId, detail.irreversible], ["timeout", null, null, null]);
  assert.deepEqual(await bodyFields(timedOut.requestId), []);
});

test("no result of any kind commits under a key the registry does not hold", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const { requestId, resultBinding } = await routeAssignAndTransmit(ring);
  // The ring now holds another key for the period than the one registered.
  const other = new Map([[period, OTHER_KEY]]);
  for (const output of [{ kind: "timeout" }, { kind: "unavailable" }]) {
    let caught: unknown = null;
    try {
      await prisma.$transaction((tx) =>
        submitDecisionMakerOutput(tx, { requestId, instance: OPENAI, binding: resultBinding, output, requireLeaseAt: () => {}, keyRing: other }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DecisionMakerBodyWriteError, String(caught));
    assert.equal((caught as DecisionMakerBodyWriteError).code, "digest_key_unavailable");
  }
  // Rolled back: no result, no detail.
  assert.deepEqual(await resultEvents(requestId), []);

  // The database holds the same rule for a detail written past the store.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const eventId = randomUUID();
      const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.result", targetType: EVENT, targetId: eventId });
      await tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "instance", "inputPayloadDigest", "resultKind", "resultDigest", "auditLogId")
        VALUES (${eventId}, ${requestId}, 'result', ${OPENAI}, ${DIGEST_B}, 'timeout', ${DIGEST_A}, ${audit})
      `;
      await insertDetailRow(tx, { requestId, resultEventId: eventId, resultKind: "timeout", keyPeriod: period, keyCheck: dmDigestKeyCheck(OTHER_KEY), auditLogId: audit });
    }),
    /AMUX_DM_RESULT_DETAIL_KEY/,
  );
});

type DetailRow = {
  requestId: string;
  resultEventId: string;
  resultKind: string;
  outputKind?: string | null;
  optionId?: string | null;
  irreversible?: boolean | null;
  keyPeriod: number;
  keyCheck?: string;
  auditLogId: string;
};

const insertDetailRow = (tx: Prisma.TransactionClient, row: DetailRow) =>
  tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerResultDetail"
      ("id", "requestId", "resultEventId", "resultKind", "outputKind", "optionId", "irreversible", "keyPeriod", "keyCheck", "auditLogId")
    VALUES (${randomUUID()}, ${row.requestId}, ${row.resultEventId}, ${row.resultKind}, ${row.outputKind ?? null}::text,
            ${row.optionId ?? null}::text, ${row.irreversible ?? null}::boolean, ${row.keyPeriod}, ${row.keyCheck ?? CHECK}, ${row.auditLogId})
  `;

test("under the kill switch a proposal is rejected and stores no body and no detail", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const { requestId, resultBinding } = await routeAssignAndTransmit(ring);
  await setSwitch("kill_switch", "on");
  const raw = JSON.stringify({ kind: "select", optionId: "a", rationale: "Smaller key.", irreversible: false });
  const submitted = await prisma.$transaction((tx) =>
    submitDecisionMakerOutput(tx, { requestId, instance: OPENAI, binding: resultBinding, output: { kind: "output", raw, options: OPTIONS }, requireLeaseAt: () => {}, keyRing: ring }),
  );
  assert.equal(submitted.status === "submitted" && submitted.result.status, "rejected");
  assert.deepEqual(await bodyFields(requestId), []);
  assert.equal(await prisma.$transaction((tx) => readDecisionMakerResultDetail(tx, requestId)), null);
});

class RolledBack extends Error {
  constructor() {
    super("RolledBack");
  }
}

test("a result detail belongs to its request's result of the same transaction, kind and audit, in its own shape", async () => {
  const period = await currentPeriod();
  const ring = new Map([[period, KEY]]);
  const { requestId } = await routeAssignAndTransmit(ring);
  type Build = (eventId: string, audit: string, otherAudit: string) => Omit<DetailRow, "requestId">;
  /** A timeout result written past the store, then the detail the case builds, in one transaction rolled back. */
  const withResult = (build: Build, eventResultKind: "timeout" | "proposal" | "escalate" = "timeout") =>
    prisma.$transaction(async (tx) => {
      const eventId = randomUUID();
      const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.result", targetType: EVENT, targetId: eventId });
      const otherAudit = await writeAudit(tx, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.result", targetType: EVENT, targetId: randomUUID() });
      await tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "instance", "inputPayloadDigest", "resultKind", "resultDigest", "auditLogId")
        VALUES (${eventId}, ${requestId}, 'result', ${OPENAI}, ${DIGEST_B}, ${eventResultKind}, ${DIGEST_A}, ${audit})
      `;
      await insertDetailRow(tx, { requestId, ...build(eventId, audit, otherAudit) });
      throw new RolledBack();
    });
  // Accepted (and rolled back by the case itself).
  await rejectsWith(withResult((eventId, audit) => ({ resultEventId: eventId, resultKind: "timeout", keyPeriod: period, auditLogId: audit })), /RolledBack/);
  // Another kind than the result's, another audit row, another period.
  await rejectsWith(withResult((eventId, audit) => ({ resultEventId: eventId, resultKind: "unavailable", keyPeriod: period, auditLogId: audit })), /AMUX_DM_RESULT_DETAIL_UNLINKED/);
  await rejectsWith(withResult((eventId, _audit, otherAudit) => ({ resultEventId: eventId, resultKind: "timeout", keyPeriod: period, auditLogId: otherAudit })), /AMUX_DM_RESULT_DETAIL_UNLINKED/);
  await rejectsWith(withResult((eventId, audit) => ({ resultEventId: eventId, resultKind: "timeout", keyPeriod: period - 1, auditLogId: audit })), /AMUX_DM_RESULT_DETAIL_KEY_PERIOD/);
  // Each kind's shape: a timeout has no output.
  await rejectsWith(
    withResult((eventId, audit) => ({ resultEventId: eventId, resultKind: "timeout", outputKind: "select", optionId: "a", irreversible: false, keyPeriod: period, auditLogId: audit })),
    /AmuxDecisionMakerResultDetail_shape_check/,
  );
  // A CHECK passes when its expression is NULL: no NULL output kind, option or flag may stand in
  // for what a proposal or an escalation must carry, however the other columns are set.
  type Shape = Pick<DetailRow, "outputKind" | "optionId" | "irreversible">;
  const shaped = (resultKind: "proposal" | "escalate", shape: Shape) =>
    withResult((eventId, audit) => ({ resultEventId: eventId, resultKind, ...shape, keyPeriod: period, auditLogId: audit }), resultKind);
  for (const [resultKind, shape] of [
    ["proposal", { outputKind: null, optionId: null, irreversible: false }],
    ["proposal", { outputKind: null, optionId: null, irreversible: true }],
    ["proposal", { outputKind: null, optionId: "a", irreversible: true }],
    ["proposal", { outputKind: null, optionId: null, irreversible: null }],
    ["proposal", { outputKind: "select", optionId: null, irreversible: true }],
    ["proposal", { outputKind: "select", optionId: "a", irreversible: null }],
    ["proposal", { outputKind: "free_text", optionId: null, irreversible: null }],
    ["proposal", { outputKind: "escalate", optionId: null, irreversible: null }],
    ["escalate", { outputKind: null, optionId: null, irreversible: null }],
    ["escalate", { outputKind: null, optionId: "a", irreversible: false }],
    ["escalate", { outputKind: "escalate", optionId: null, irreversible: false }],
  ] as const) {
    await rejectsWith(shaped(resultKind, shape), /AmuxDecisionMakerResultDetail_shape_check/);
  }
  // What each kind must carry is accepted (and rolled back by the case itself).
  for (const [resultKind, shape] of [
    ["proposal", { outputKind: "select", optionId: "a", irreversible: true }],
    ["proposal", { outputKind: "free_text", optionId: null, irreversible: false }],
    ["escalate", { outputKind: "escalate", optionId: null, irreversible: null }],
  ] as const) {
    await rejectsWith(shaped(resultKind, shape), /RolledBack/);
  }
  // The option id grammar: no prose.
  await rejectsWith(
    prisma.$executeRaw`
      INSERT INTO "AmuxDecisionMakerResultDetail" ("id", "requestId", "resultEventId", "resultKind", "outputKind", "optionId", "irreversible", "keyPeriod", "keyCheck", "auditLogId")
      VALUES (${randomUUID()}, ${requestId}, ${randomUUID()}, 'proposal', 'select', 'Use the model id only', false, ${period}, ${CHECK}, 'x')
    `,
    /AmuxDecisionMakerResultDetail_option_id_format_check|AMUX_DM_RESULT_DETAIL_UNLINKED/,
  );
  // A result an earlier transaction recorded gains no detail later.
  const eventId = randomUUID();
  const audit = await prisma.$transaction(async (tx) => {
    const id = await writeAudit(tx, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.result", targetType: EVENT, targetId: eventId });
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "instance", "inputPayloadDigest", "resultKind", "resultDigest", "auditLogId")
      VALUES (${eventId}, ${requestId}, 'result', ${OPENAI}, ${DIGEST_B}, 'timeout', ${DIGEST_A}, ${id})
    `;
    return id;
  });
  await rejectsWith(
    prisma.$transaction((tx) => insertDetailRow(tx, { requestId, resultEventId: eventId, resultKind: "timeout", keyPeriod: period, auditLogId: audit })),
    /AMUX_DM_RESULT_DETAIL_UNLINKED/,
  );
});

// ---------------------------------------------------------------------------
// Retention: retention_set at the close, holds, stale close
// ---------------------------------------------------------------------------

test("a request's close writes its one retention_set, 90 days after the close by the database clock", async () => {
  await currentPeriod();
  // The stale close through the store, 30 days after creation.
  const stale = await backdatedRequest(31 * DAY, { card: null });
  const young = await backdatedRequest(29 * DAY, { card: null });
  assert.deepEqual(await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: young.id })), { recorded: false, reason: "not_stale" });
  const closed = await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: stale.id }));
  assert.equal(closed.recorded, true);
  if (!closed.recorded) return;
  const rows = await retentionRows(stale.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "retention_set");
  assert.equal(rows[0]!.actorKind, "system");
  assert.equal(rows[0]!.actorUserId, null);
  // Named by the closing event's own audit row.
  assert.equal(rows[0]!.auditLogId, closed.event.auditLogId);
  // Epoch milliseconds: the same instant whatever the session's time zone.
  assert.equal(Number(rows[0]!.retentionUntilMs), Date.parse(closed.event.createdAt) + 90 * DAY);
  assert.equal(rows[0]!.keyPeriod, stale.keyPeriod);
  assert.deepEqual(await retentionRows(young.id), []);

  // The assignment discarded closes too.
  const discarded = await backdatedRequest(0);
  await prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.assign", targetType: EVENT, targetId: id });
    await tx.$executeRaw`INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "auditLogId") VALUES (${id}, ${discarded.id}, 'assign', ${audit})`;
  });
  const discard = await prisma.$transaction((tx) => discardDecisionMakerAssignment(tx, { requestId: discarded.id }));
  assert.equal(discard.recorded, true);
  assert.deepEqual((await retentionRows(discarded.id)).map((row) => row.kind), ["retention_set"]);

  // Never a second one, and never one without its request's closing event of the same transaction.
  for (const [request, refusal] of [
    [stale, /AMUX_DM_RETENTION_TRANSITION/],
    [young, /AMUX_DM_RETENTION_UNAUDITED/],
  ] as const) {
    await rejectsWith(
      prisma.$transaction(async (tx) => {
        const audit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.stale_close", targetType: EVENT, targetId: randomUUID() });
        await tx.$executeRaw`
          INSERT INTO "AmuxDecisionMakerRetentionEvent" ("id", "requestId", "keyPeriod", "kind", "retentionUntil", "actorKind", "auditLogId")
          VALUES (${randomUUID()}, ${request.id}, ${request.keyPeriod}, 'retention_set', now(), 'system', ${audit})
        `;
      }),
      refusal,
    );
  }
});

test("a hold is set only when none is open and released only when one is, each by a person under its own audit", async () => {
  await currentPeriod();
  const created = await backdatedRequest(0);
  const person = operator("dm-operator-hold");
  const hold = (action: "set" | "release") =>
    prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: created.id, action }));
  assert.deepEqual(await hold("release"), { recorded: false, reason: "no_open_hold" });
  assert.equal((await hold("set")).recorded, true);
  assert.deepEqual(await hold("set"), { recorded: false, reason: "hold_open" });
  assert.equal((await hold("release")).recorded, true);
  assert.equal((await hold("set")).recorded, true);
  const rows = await retentionRows(created.id);
  assert.deepEqual(rows.map((row) => [row.kind, row.actorKind, row.actorUserId]), [
    ["hold_set", "human", "dm-operator-hold"],
    ["hold_release", "human", "dm-operator-hold"],
    ["hold_set", "human", "dm-operator-hold"],
  ]);
  const audits = await prisma.$queryRaw<Array<{ action: string; actorUserId: string | null; metadata: Record<string, unknown> }>>`
    SELECT "action", "actorUserId", "metadata" FROM "AdminAuditLog" WHERE "id" IN (${Prisma.join(rows.map((row) => row.auditLogId))})
  `;
  assert.ok(audits.every((audit) => audit.action === "amux.decision.legal_hold" && audit.actorUserId === "dm-operator-hold"));
  assert.ok(audits.every((audit) => !("systemActor" in audit.metadata)));
  assert.equal((await prisma.$transaction((tx) => readDecisionMakerBodyRetention(tx, created.id))).holdOpen, true);

  // The database refuses a second open hold, a hold without its own person's audit, and another period.
  const rawHold = (kind: string, audit: (tx: Prisma.TransactionClient, id: string) => Promise<string>, keyPeriod = created.keyPeriod) =>
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerRetentionEvent" ("id", "requestId", "keyPeriod", "kind", "actorKind", "actorUserId", "auditLogId")
        VALUES (${id}, ${created.id}, ${keyPeriod}, ${kind}, 'human', 'dm-operator-hold', ${await audit(tx, id)})
      `;
    });
  const ownAudit = (tx: Prisma.TransactionClient, id: string) =>
    writeAudit(tx, { kind: "person", session: person, action: "amux.decision.legal_hold", targetType: "AmuxDecisionMakerRetentionEvent", targetId: id });
  await rejectsWith(rawHold("hold_set", ownAudit), /AMUX_DM_RETENTION_TRANSITION/);
  await rejectsWith(
    rawHold("hold_release", (tx, id) => writeAudit(tx, { kind: "person", action: "amux.decision.legal_hold", targetType: "AmuxDecisionMakerRetentionEvent", targetId: id })),
    /AMUX_DM_RETENTION_UNAUDITED/,
  );
  await rejectsWith(
    rawHold("hold_release", (tx, id) => writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.legal_hold", targetType: "AmuxDecisionMakerRetentionEvent", targetId: id })),
    /AMUX_DM_RETENTION_(UNAUDITED|actor_shape)|AmuxDecisionMakerRetentionEvent_actor_shape_check/,
  );
  await rejectsWith(rawHold("hold_release", ownAudit, created.keyPeriod + 1), /AMUX_DM_RETENTION_KEY_PERIOD/);
  await rawHold("hold_release", ownAudit);
  // Never changed or removed.
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerRetentionEvent" SET "kind" = 'hold_release'`, /AMUX_DM_RETENTION_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerRetentionEvent"`, /AMUX_DM_RETENTION_IMMUTABLE/);
});

// ---------------------------------------------------------------------------
// Deletes: the expiry purge and the privacy erase
// ---------------------------------------------------------------------------

test("the purge deletes a request's bodies only after its retention, with no hold open, under the router's audit", async () => {
  await rotateRecentPeriods();
  const person = operator();
  const purge = (requestId: string) => prisma.$transaction((tx) => purgeDecisionMakerBodies(tx, { requestId }));

  // Open: no retention yet.
  const open = await backdatedRequest(0, { card: "Pick a cache key layout." });
  assert.deepEqual(await purge(open.id), { deleted: false, reason: "not_closed" });

  // Closed a day ago: retained for 89 more days.
  const recent = await backdatedRequest(2 * DAY, { card: "Pick a cache key layout." });
  await backdatedClose(recent.id, DAY);
  assert.deepEqual(await purge(recent.id), { deleted: false, reason: "retained" });

  // Closed 91 days ago: purged, unless a hold is open.
  const old = await backdatedRequest(120 * DAY, { card: "Pick a cache key layout." });
  await backdatedClose(old.id, 91 * DAY);
  assert.deepEqual(await prisma.$transaction((tx) => listDecisionMakerPurgeCandidates(tx, { limit: 10 })), [old.id]);
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: old.id, action: "set" }));
  assert.deepEqual(await purge(old.id), { deleted: false, reason: "held" });
  assert.deepEqual(await prisma.$transaction((tx) => listDecisionMakerPurgeCandidates(tx, { limit: 10 })), []);
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: old.id, action: "release" }));
  const purged = await purge(old.id);
  assert.equal(purged.deleted, true);
  assert.deepEqual(await bodyFields(old.id), []);
  // A lost outcome is settled by reading: no row remains.
  assert.deepEqual((await prisma.$transaction((tx) => readDecisionMakerBodyRetention(tx, old.id))).bodyFields, []);
  if (purged.deleted) {
    const audit = (await prisma.$queryRaw<Array<{ action: string; targetId: string; metadata: Record<string, unknown> }>>`
      SELECT "action", "targetId", "metadata" FROM "AdminAuditLog" WHERE "id" = ${purged.auditLogId}
    `)[0]!;
    assert.equal(audit.action, "amux.decision.body_purge");
    assert.equal(audit.targetId, old.id);
    assert.deepEqual(audit.metadata, { request_id: old.id, fields: ["card_text"], body_count: "1", systemActor: "amux-decision-router" });
  }

  // The database refuses a delete with no audit, before the retention, under a hold, or of a field the audit does not list.
  const rawPurge = (requestId: string, fields: string[]) =>
    prisma.$transaction(async (tx) => {
      await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.body_purge", targetType: REQUEST, targetId: requestId, metadata: { request_id: requestId, fields } });
      await tx.$executeRaw`DELETE FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${requestId}`;
    });
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${open.id}`, /AMUX_DM_BODY_DELETE_UNAUDITED/);
  await rejectsWith(rawPurge(recent.id, ["card_text"]), /AMUX_DM_BODY_RETAINED/);
  const older = await backdatedRequest(120 * DAY, { card: "Pick a cache key layout." });
  await backdatedClose(older.id, 91 * DAY);
  await rejectsWith(rawPurge(older.id, ["dm_answer"]), /AMUX_DM_BODY_DELETE_UNAUDITED/);
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: older.id, action: "set" }));
  await rejectsWith(rawPurge(older.id, ["card_text"]), /AMUX_DM_BODY_HELD/);
  assert.deepEqual(await bodyFields(older.id), ["card_text"]);
});

test("a person erases bodies on a confirmed privacy request, before the retention, but never under a hold", async () => {
  await currentPeriod();
  const person = operator("dm-operator-erase");
  const created = await backdatedRequest(0, { card: "My name is in this card." });
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: created.id, action: "set" }));
  const erase = () => prisma.$transaction((tx) => eraseDecisionMakerBodies(tx, { session: person, requestId: created.id, fields: ["card_text"] }));
  assert.deepEqual(await erase(), { deleted: false, reason: "held" });
  // A raw erase under the hold is the database's refusal too.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await writeAudit(tx, { kind: "person", session: person, action: "amux.decision.body_erase", targetType: REQUEST, targetId: created.id, metadata: { request_id: created.id, fields: ["card_text"] } });
      await tx.$executeRaw`DELETE FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${created.id}`;
    }),
    /AMUX_DM_BODY_HELD/,
  );
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: created.id, action: "release" }));
  const erased = await erase();
  assert.equal(erased.deleted, true);
  assert.deepEqual(await bodyFields(created.id), []);
  if (erased.deleted) {
    const audit = (await prisma.$queryRaw<Array<{ action: string; actorUserId: string | null; metadata: Record<string, unknown> }>>`
      SELECT "action", "actorUserId", "metadata" FROM "AdminAuditLog" WHERE "id" = ${erased.auditLogId}
    `)[0]!;
    assert.equal(audit.action, "amux.decision.body_erase");
    assert.equal(audit.actorUserId, "dm-operator-erase");
    assert.deepEqual(audit.metadata, { request_id: created.id, fields: ["card_text"], body_count: "1" });
  }
  // The system cannot erase: a body_erase by a system actor authorizes nothing.
  const other = await backdatedRequest(0, { card: "x" });
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.body_erase", targetType: REQUEST, targetId: other.id, metadata: { request_id: other.id, fields: ["card_text"] } });
      await tx.$executeRaw`DELETE FROM "AmuxDecisionMakerBody" WHERE "requestId" = ${other.id}`;
    }),
    /AMUX_DM_BODY_DELETE_UNAUDITED/,
  );
});

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

test("a key period is rotated in once, and destroyed only when no body, hold or open request of it remains", async () => {
  const { period, ageMs } = await ageIntoPeriod(5);
  const destroy = (keyPeriod: number) => prisma.$transaction((tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod }));
  assert.deepEqual(await destroy(period), { recorded: false, reason: "not_registered" });
  assert.equal((await rotate(period)).recorded, true);
  assert.deepEqual(await rotate(period), { recorded: false, reason: "already_registered" });
  const current = dmKeyPeriodOf(await dbNowMs());
  assert.deepEqual(await rotate(current + 2), { recorded: false, reason: "period_too_far_ahead" });
  assert.equal((await rotate(current)).recorded, true);
  assert.deepEqual(await destroy(current), { recorded: false, reason: "period_not_ended" });

  // An open request of the period: a body could still come.
  const created = await backdatedRequest(ageMs, { card: "Pick a cache key layout." });
  assert.equal(created.keyPeriod, period);
  assert.deepEqual(await destroy(period), { recorded: false, reason: "bodies_remain" });
  await backdatedClose(created.id, 91 * DAY);
  assert.deepEqual(await destroy(period), { recorded: false, reason: "bodies_remain" });
  // A hold keeps the key even once the bodies are gone.
  await prisma.$transaction((tx) => purgeDecisionMakerBodies(tx, { requestId: created.id }));
  const person = operator();
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: created.id, action: "set" }));
  assert.deepEqual(await destroy(period), { recorded: false, reason: "hold_open" });
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: created.id, action: "release" }));
  // An open request routed to a DM, with no body.
  const bare = await backdatedRequest(ageMs);
  assert.deepEqual(await destroy(period), { recorded: false, reason: "requests_open" });
  await backdatedClose(bare.id, 91 * DAY);

  const destroyed = await destroy(period);
  assert.equal(destroyed.recorded, true);
  assert.deepEqual(await destroy(period), { recorded: false, reason: "already_destroyed" });
  assert.deepEqual(await rotate(period), { recorded: false, reason: "destroyed" });
  // From the record on, no body of the period can be stored, whatever the key ring holds.
  await rejectsWith(backdatedRequest(ageMs, { card: "x" }), /AMUX_DM_BODY_KEY/);
  const audits = await prisma.$queryRaw<Array<{ action: string; metadata: Record<string, unknown> }>>`
    SELECT a."action", a."metadata" FROM "AdminAuditLog" a JOIN "AmuxDecisionMakerDigestKeyEvent" k ON k."auditLogId" = a."id"
    WHERE k."keyPeriod" = ${period} ORDER BY k."sequence"
  `;
  assert.deepEqual(audits.map((audit) => audit.action), ["amux.decision.digest_key_rotate", "amux.decision.digest_key_destroy"]);
  assert.ok(audits.every((audit) => audit.metadata.systemActor === "amux-decision-router"));
  // No key and no key check value in the audit.
  assert.ok(audits.every((audit) => !JSON.stringify(audit.metadata).includes(CHECK)));
});

test("the database refuses a key event out of order, without its audit, or changed", async () => {
  const { period, ageMs } = await ageIntoPeriod(5);
  const rawKeyEvent = (kind: "rotate" | "destroy", keyPeriod: number, audit: "own" | "none" | "person") =>
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const auditLogId =
        audit === "none"
          ? await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route", targetType: REQUEST, targetId: id })
          : audit === "person"
            ? await writeAudit(tx, { kind: "person", action: `amux.decision.digest_key_${kind}`, targetType: "AmuxDecisionMakerDigestKeyEvent", targetId: id })
            : await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: `amux.decision.digest_key_${kind}`, targetType: "AmuxDecisionMakerDigestKeyEvent", targetId: id });
      await tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerDigestKeyEvent" ("id", "keyPeriod", "kind", "keyCheck", "auditLogId")
        VALUES (${id}, ${keyPeriod}, ${kind}, ${kind === "rotate" ? CHECK : null}, ${auditLogId})
      `;
    });
  await rejectsWith(rawKeyEvent("rotate", period, "none"), /AMUX_DM_DIGEST_KEY_UNAUDITED/);
  await rejectsWith(rawKeyEvent("rotate", period, "person"), /AMUX_DM_DIGEST_KEY_UNAUDITED/);
  await rejectsWith(rawKeyEvent("destroy", period, "own"), /AMUX_DM_DIGEST_KEY_TRANSITION/);
  await rawKeyEvent("rotate", period, "own");
  await rejectsWith(rawKeyEvent("rotate", period, "own"), /AMUX_DM_DIGEST_KEY_TRANSITION/);
  const created = await backdatedRequest(ageMs, { card: "x" });
  await rejectsWith(rawKeyEvent("destroy", period, "own"), /AMUX_DM_DIGEST_KEY_BODIES/);
  await backdatedClose(created.id, 91 * DAY);
  await prisma.$transaction((tx) => purgeDecisionMakerBodies(tx, { requestId: created.id }));
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: operator(), requestId: created.id, action: "set" }));
  await rejectsWith(rawKeyEvent("destroy", period, "own"), /AMUX_DM_DIGEST_KEY_HELD/);
  // An open request of the period, with no body.
  await backdatedRequest(ageMs);
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerDigestKeyEvent" SET "keyPeriod" = 0`, /AMUX_DM_DIGEST_KEY_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerDigestKeyEvent"`, /AMUX_DM_DIGEST_KEY_IMMUTABLE/);
  // A rotation without its key check value, past every rule of the guard.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const auditLogId = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.digest_key_rotate", targetType: "AmuxDecisionMakerDigestKeyEvent", targetId: id });
      await tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerDigestKeyEvent" ("id", "keyPeriod", "kind", "keyCheck", "auditLogId")
        VALUES (${id}, ${period + 1}, 'rotate', NULL, ${auditLogId})
      `;
    }),
    /AmuxDecisionMakerDigestKeyEvent_key_check_shape_check/,
  );
  // Under a hold the open request check is not reached; with the hold released it is.
  await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: operator(), requestId: created.id, action: "release" }));
  await rejectsWith(rawKeyEvent("destroy", period, "own"), /AMUX_DM_DIGEST_KEY_OPEN_REQUESTS/);
});

// ---------------------------------------------------------------------------
// Section 6's table: what stays allowed under the kill switch
// ---------------------------------------------------------------------------

test("under the kill switch the hold, the erase, the stale close, the purge and the key registry all stay allowed", async () => {
  const period = await rotateRecentPeriods();
  const { period: past } = await ageIntoPeriod(6);
  await rotate(past);
  const person = operator();
  const stale = await backdatedRequest(31 * DAY, { card: "Pick a cache key layout." });
  const expired = await backdatedRequest(120 * DAY, { card: "Pick a cache key layout." });
  await backdatedClose(expired.id, 91 * DAY);
  const erasable = await backdatedRequest(0, { card: "My name is in this card." });
  await setSwitch("kill_switch", "on");

  assert.equal((await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: stale.id, action: "set" }))).recorded, true);
  assert.equal((await prisma.$transaction((tx) => recordDecisionMakerLegalHold(tx, { session: person, requestId: stale.id, action: "release" }))).recorded, true);
  assert.equal((await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: stale.id }))).recorded, true);
  assert.deepEqual((await retentionRows(stale.id)).map((row) => row.kind), ["hold_set", "hold_release", "retention_set"]);
  assert.equal((await prisma.$transaction((tx) => purgeDecisionMakerBodies(tx, { requestId: expired.id }))).deleted, true);
  assert.equal(
    (await prisma.$transaction((tx) => eraseDecisionMakerBodies(tx, { session: person, requestId: erasable.id, fields: ["card_text"] }))).deleted,
    true,
  );
  assert.equal((await rotate(period + 1)).recorded, true);
  assert.equal((await prisma.$transaction((tx) => destroyDecisionMakerDigestKey(tx, { keyPeriod: past }))).recorded, true);
});

// ---------------------------------------------------------------------------
// The S1c review minor: a switch read that fails aborts the transaction
// ---------------------------------------------------------------------------

test("a switch read that fails reaches the caller as settings_unreadable, through the boundary, and writes nothing", async () => {
  const binding = {
    cardId: `card-unreadable-${randomUUID()}`,
    questionRevision: 1,
    askingWorkerId: "worker.claude-1",
    amuxSessionId: "session:7",
    amuxSessionAttempt: 1,
    askingProvider: "claude",
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
  };
  const card = {
    askType: "decision",
    resolution: null,
    type: "task",
    tags: [],
    title: "Pick a cache key layout",
    question: "Should the cache key include the locale or only the model id?",
    options: [{ id: "a", label: "Model id only" }],
    unblocks: "The cache module can be finished.",
    context: "Both layouts pass the current tests.",
    contextPaths: [],
  };
  const ring = new Map([[dmKeyPeriodOf(await dbNowMs()), KEY]]);
  const boundary = { operation: "dm_body_test", prismaCallCeiling: 12, isolation: "mutation" as const };
  let caught: unknown = null;
  try {
    await withAmuxDbBoundary(boundary, async (tx) => {
      // The switch table is out of reach for this one transaction, so the read fails in PostgreSQL.
      await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerSwitchEvent" RENAME TO "AmuxDecisionMakerSwitchEventAway"`);
      return recordDecisionMakerRequest(tx, { binding, card, keyRing: ring });
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DecisionMakerRequestWriteError, String(caught));
  assert.equal((caught as DecisionMakerRequestWriteError).code, "settings_unreadable");
  // Rolled back: no request, and the switch table where it was.
  assert.deepEqual(
    await prisma.$queryRaw`SELECT 1 FROM "AmuxDecisionMakerRequest" WHERE "cardId" = ${binding.cardId}`,
    [],
  );
  assert.ok(Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS "n" FROM "AmuxDecisionMakerSwitchEvent"`)[0]!.n) > 0);
  // And the same question routes normally once the switches read.
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequest(tx, { binding, card, keyRing: ring }));
  assert.equal(routed.created, true);
  assert.equal(routed.route, "dm_proposal");
});

test("the key period is the request's own, from its database clock", async () => {
  const now = await dbNowMs();
  const created = await backdatedRequest(0);
  assert.equal(created.keyPeriod, dmKeyPeriodOf(created.createdAtMs));
  assert.ok(Math.abs(created.createdAtMs - now) < 60_000);
  assert.equal(DM_KEY_PERIOD_MS, 30 * DAY);
});
