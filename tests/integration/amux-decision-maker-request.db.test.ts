import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { isAmuxLateCommitError } from "@/lib/amux/commitDeadlineCore";
import { withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  DM_COMMIT_RESERVE_MS,
  dmEventRefusal,
  dmEventSwitchRefusal,
  type DmEventAttempt,
  type DmEventRefusal,
} from "@/lib/amux/decisionMakerRequestCore";
import { dmKeyPeriodOf } from "@/lib/amux/decisionMakerBodyCore";
import { dmSwitchRoutingInput } from "@/lib/amux/decisionMakerSwitchCore";
import {
  readDecisionMakerSwitches,
  recordDecisionMakerSwitchByOperator,
} from "@/lib/amux/decisionMakerSwitchStore";
import {
  assignDecisionMakerRequest,
  discardDecisionMakerAssignment,
  lookupDecisionMakerResult,
  readDecisionMakerRequestState,
  readDecisionMakerThroughput,
  recordDecisionMakerRequest,
  recordDecisionMakerResultUnknown,
  recordDecisionMakerTransmitIntent,
  recordDecisionMakerTransmitOutcome,
  staleCloseDecisionMakerRequest,
  submitDecisionMakerResult,
} from "@/lib/amux/decisionMakerRequestStore";
import { prisma } from "@/lib/prisma";

// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// stage S1c, against PostgreSQL through the migration history
// (20261008090100_amux_decision_maker_request_ledger), in the agents lane of
// the DB integration suite.
//
// §12's blocking tests covered here: the COMMIT that reaches the database
// after its deadline is refused ("검사 시점에 마감을 넘긴 COMMIT 거부 DB
// 테스트"), one terminal result per request ("요청당 종결 결과 1개"), and a
// result submission settled by its (request, digest) pair without a second
// submission ("결과 제출 응답 유실 시 재제출 없이 조회로만 확정"). The rest cover
// what the migration header says the database enforces: the CHECKs, the audit
// row of the same transaction by the right actor and action, the transition
// graph (against the core's own dmEventRefusal() on every state read back
// from the database), the deadlines by the database clock, no update or
// delete, an increasing sequence, and READ COMMITTED only. The writer's own
// statements are counted in tests/amuxDecisionMakerRequest.test.mjs.

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

// The three tables refuse DELETE; TRUNCATE fires no row trigger, so each test
// starts from an empty ledger and empty switches. Since S1d (2026-10-08) the
// body, retention and result detail tables reference the request table and a closing event
// writes a retention row, so they are emptied with it.
const resetLedger = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AmuxDecisionMakerDeliveryEvent", "AmuxDecisionMakerJudgment", "AmuxDecisionMakerResultDetail", "AmuxDecisionMakerBody", "AmuxDecisionMakerRetentionEvent", "AmuxDecisionMakerRequestEvent", "AmuxDecisionMakerRequest", "AmuxDecisionMakerSwitchEvent" RESTART IDENTITY`,
  );

const switchOperator = () =>
  ({ user: { id: `dm-operator-${randomUUID()}`, email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

/** A person sets one switch through the switch store, in a transaction of its own. */
const setSwitch = (
  scope: "kill_switch" | "decision-maker-openai" | "decision-maker-anthropic",
  value: "on" | "off" | "proposal",
) => prisma.$transaction((tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope, value }));

// With no switch event both instances are off (§8: "기본 off"), which routes
// nothing to a DM; every test starts with both in proposal mode and the kill
// switch off, and the switch tests change that themselves.
beforeEach(async () => {
  await resetLedger();
  await setSwitch("decision-maker-openai", "proposal");
  await setSwitch("decision-maker-anthropic", "proposal");
});

after(async () => {
  await resetLedger();
  await prisma.$disconnect();
});

const REQUEST = "AmuxDecisionMakerRequest";
const EVENT = "AmuxDecisionMakerRequestEvent";
const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MINUTE = 60_000;

type SystemActor = "amux-decision-router" | "amux-decision-maker-openai" | "amux-decision-maker-anthropic";

/** A database refusal, found wherever Prisma put the message. Null accepts any refusal. */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp | null = null) => {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, "the database accepted what it must refuse");
  if (pattern === null) return caught;
  const record = caught as { meta?: unknown; cause?: unknown };
  const text = [String(caught), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" ");
  assert.match(text, pattern);
  return caught;
};

type Audit =
  | { kind: "system"; actor: SystemActor; action: string; targetType?: string; targetId?: string }
  | { kind: "person"; action: string; targetType?: string; targetId?: string }
  | { kind: "none" };

const writeAudit = async (tx: Prisma.TransactionClient, audit: Audit, targetType: string, id: string) => {
  if (audit.kind === "system") {
    return writeSystemAuditLog({
      tx,
      systemActor: audit.actor,
      action: audit.action,
      targetType: audit.targetType ?? targetType,
      targetId: audit.targetId ?? id,
      summary: "test",
    });
  }
  if (audit.kind === "person") {
    return writeAdminAuditLog({
      tx,
      session: { user: { id: `dm-operator-${randomUUID()}`, email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" } as Session,
      action: audit.action,
      targetType: audit.targetType ?? targetType,
      targetId: audit.targetId ?? id,
      summary: "test",
    });
  }
  return `no-such-audit-${randomUUID()}`;
};

type RequestRow = {
  cardId: string;
  questionRevision: number;
  askingWorkerId: string;
  amuxSessionId: string;
  amuxSessionAttempt: number;
  askingProvider: string;
  optionSetDigest: string;
  policyVersion: number;
  termListVersion: string;
  classificationVersion: string;
  scannerVersion: string;
  route: string;
  instance: string | null;
  refusalCodes: string[] | null;
};

let cardCounter = 0;
const requestRow = (overrides: Partial<RequestRow> = {}): RequestRow => {
  cardCounter += 1;
  return {
    cardId: `card-${cardCounter}`,
    questionRevision: 1,
    askingWorkerId: "worker.claude-1",
    amuxSessionId: "session:1",
    amuxSessionAttempt: 1,
    askingProvider: "claude",
    optionSetDigest: DIGEST_A,
    policyVersion: 1,
    termListVersion: "v1",
    classificationVersion: "authority-manifest-1",
    scannerVersion: "v1",
    route: "dm_proposal",
    instance: OPENAI,
    refusalCodes: [],
    ...overrides,
  };
};

const ROUTE_AUDIT: Audit = { kind: "system", actor: "amux-decision-router", action: "amux.decision.route" };

const insertRequestRow = (tx: Prisma.TransactionClient, id: string, row: RequestRow, auditLogId: string) =>
  tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerRequest"
      ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
       "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
       "scannerVersion", "route", "instance", "refusalCodes", "auditLogId", "createdAt", "assignmentDeadlineAt")
    VALUES
      (${id}, ${row.cardId}, ${row.questionRevision}, ${row.askingWorkerId}, ${row.amuxSessionId},
       ${row.amuxSessionAttempt}, ${row.askingProvider}, ${row.optionSetDigest}, ${row.policyVersion},
       ${row.termListVersion}, ${row.classificationVersion}, ${row.scannerVersion}, ${row.route},
       ${row.instance}, ${row.refusalCodes}::text[], ${auditLogId},
       '2001-01-01T00:00:00Z'::timestamptz, '2001-01-01T00:00:00Z'::timestamptz)
  `;

/** One request and its audit row in one transaction, written directly so a test can break either. */
const insertRequest = (row: RequestRow = requestRow(), audit: Audit = ROUTE_AUDIT) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertRequestRow(tx, id, row, await writeAudit(tx, audit, REQUEST, id));
    return id;
  });

type EventRow = {
  kind: string;
  instance?: string | null;
  vendor?: string | null;
  inputPayloadDigest?: string | null;
  snapshotState?: string | null;
  snapshotTargetSha?: string | null;
  snapshotManifestDigest?: string | null;
  resultKind?: string | null;
  resultDigest?: string | null;
  rejectionReason?: string | null;
  resultDeadlineAt?: string | null;
  sequence?: number;
};

const ROUTER_KINDS = new Set(["assign", "assign_discarded", "stale_close"]);
const actorFor = (kind: string, instance: string | null | undefined): SystemActor =>
  ROUTER_KINDS.has(kind)
    ? "amux-decision-router"
    : instance === ANTHROPIC
      ? "amux-decision-maker-anthropic"
      : "amux-decision-maker-openai";
const eventAudit = (event: EventRow): Audit => ({
  kind: "system",
  actor: actorFor(event.kind, event.instance),
  action: `amux.decision.${event.kind}`,
});

const insertEventRow = (tx: Prisma.TransactionClient, id: string, requestId: string, event: EventRow, auditLogId: string) =>
  event.sequence === undefined
    ? tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerRequestEvent"
          ("id", "requestId", "kind", "instance", "vendor", "inputPayloadDigest", "snapshotState",
           "snapshotTargetSha", "snapshotManifestDigest", "resultKind", "resultDigest", "rejectionReason",
           "resultDeadlineAt", "auditLogId", "createdAt")
        VALUES
          (${id}, ${requestId}, ${event.kind}, ${event.instance ?? null}, ${event.vendor ?? null},
           ${event.inputPayloadDigest ?? null}, ${event.snapshotState ?? null}, ${event.snapshotTargetSha ?? null},
           ${event.snapshotManifestDigest ?? null}, ${event.resultKind ?? null}, ${event.resultDigest ?? null},
           ${event.rejectionReason ?? null}, ${event.resultDeadlineAt ?? null}::timestamptz, ${auditLogId},
           '2001-01-01T00:00:00Z'::timestamptz)
      `
    : tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerRequestEvent"
          ("id", "sequence", "requestId", "kind", "instance", "auditLogId")
        VALUES
          (${id}, ${event.sequence}, ${requestId}, ${event.kind}, ${event.instance ?? null}, ${auditLogId})
      `;

/** One event and its audit row in one transaction. */
const insertEvent = (requestId: string, event: EventRow, audit: Audit = eventAudit(event)) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await insertEventRow(tx, id, requestId, event, await writeAudit(tx, audit, EVENT, id));
    return id;
  });

class RolledBack extends Error {}

/**
 * Whether the guard accepts an event, without keeping it: the event is
 * inserted with its correct audit, and the transaction is then rolled back.
 * Returns null when the insert was accepted, otherwise the refusal.
 */
const tryEvent = async (requestId: string, event: EventRow): Promise<unknown> => {
  try {
    await prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await insertEventRow(tx, id, requestId, event, await writeAudit(tx, eventAudit(event), EVENT, id));
      throw new RolledBack();
    });
  } catch (error) {
    return error instanceof RolledBack ? null : error;
  }
  throw new Error("unreachable");
};

const INTENT: EventRow = { kind: "transmit_intent", instance: OPENAI, vendor: "openai", inputPayloadDigest: DIGEST_B, snapshotState: "none" };
const RECEIPT: EventRow = { kind: "transmit_receipt", instance: OPENAI };
const PROPOSAL: EventRow = { kind: "result", instance: OPENAI, resultKind: "proposal", resultDigest: DIGEST_C, inputPayloadDigest: DIGEST_B };

const rowsOf = (requestId: string) =>
  prisma.$queryRaw<
    Array<{ id: string; sequence: bigint; kind: string; resultKind: string | null; resultDigest: string | null; createdAt: Date; resultDeadlineAt: Date | null }>
  >`SELECT "id", "sequence", "kind", "resultKind", "resultDigest", "createdAt", "resultDeadlineAt" FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} ORDER BY "sequence"`;

const dbNow = async () => (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0]!.now;

/**
 * A request created `ageMs` ago by the database clock. The request guard sets
 * `createdAt` itself, so it is disabled for this one insert in the test's own
 * transaction; the row still names a real route audit for its foreign key.
 */
const backdatedRequest = (ageMs: number, overrides: Partial<RequestRow> = {}) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const row = requestRow(overrides);
    const auditLogId = await writeAudit(tx, ROUTE_AUDIT, REQUEST, id);
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" DISABLE TRIGGER "amux_decision_maker_request_guard"`);
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequest"
        ("id", "cardId", "questionRevision", "askingWorkerId", "amuxSessionId", "amuxSessionAttempt",
         "askingProvider", "optionSetDigest", "policyVersion", "termListVersion", "classificationVersion",
         "scannerVersion", "route", "instance", "refusalCodes", "auditLogId", "createdAt", "assignmentDeadlineAt")
      SELECT ${id}, ${row.cardId}, ${row.questionRevision}, ${row.askingWorkerId}, ${row.amuxSessionId},
             ${row.amuxSessionAttempt}, ${row.askingProvider}, ${row.optionSetDigest}, ${row.policyVersion},
             ${row.termListVersion}, ${row.classificationVersion}, ${row.scannerVersion}, ${row.route},
             ${row.instance}, ${row.refusalCodes}::text[], ${auditLogId},
             t."createdAt", t."createdAt" + INTERVAL '2 minutes'
      FROM (SELECT date_trunc('milliseconds', clock_timestamp() - ${ageMs} * INTERVAL '1 millisecond') AS "createdAt") t
    `;
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequest" ENABLE TRIGGER "amux_decision_maker_request_guard"`);
    return id;
  });

/**
 * An assignment whose result deadline is `deadlineInMs` from now (negative:
 * already past), with a transmission intent when `transmitted`. Both guards
 * of the event table are disabled for these inserts only, in the test's own
 * transaction, so the deadline can be placed where the test needs it.
 */
const backdatedAssignment = (requestId: string, deadlineInMs: number, transmitted = true) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" DISABLE TRIGGER "amux_decision_maker_request_event_guard"`);
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" DISABLE TRIGGER "amux_decision_maker_request_event_commit_check"`);
    const assignId = randomUUID();
    const assignAudit = await writeAudit(tx, { kind: "system", actor: "amux-decision-router", action: "amux.decision.assign" }, EVENT, assignId);
    await tx.$executeRaw`
      INSERT INTO "AmuxDecisionMakerRequestEvent" ("id", "requestId", "kind", "resultDeadlineAt", "auditLogId", "createdAt")
      SELECT ${assignId}, ${requestId}, 'assign', t."deadline", ${assignAudit}, t."deadline" - INTERVAL '30 minutes'
      FROM (SELECT date_trunc('milliseconds', clock_timestamp() + ${deadlineInMs} * INTERVAL '1 millisecond') AS "deadline") t
    `;
    if (transmitted) {
      const intentId = randomUUID();
      const intentAudit = await writeAudit(tx, eventAudit(INTENT), EVENT, intentId);
      await insertEventRow(tx, intentId, requestId, INTENT, intentAudit);
    }
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" ENABLE TRIGGER "amux_decision_maker_request_event_commit_check"`);
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxDecisionMakerRequestEvent" ENABLE TRIGGER "amux_decision_maker_request_event_guard"`);
  });

// The routing store computes the option set digest itself, keyed by the period
// of the database clock (stage S1d): a key for the period around now and one
// more on each side.
const RING = new Map(
  [-1, 0, 1].map((offset) => [dmKeyPeriodOf(Date.now()) + offset, Buffer.alloc(32, 10 + offset)] as const),
);

/** A routing caller's binding: every value but the option set digest, which the store computes. */
const binding = (overrides: Record<string, unknown> = {}) => ({
  cardId: `card-store-${randomUUID()}`,
  questionRevision: 2,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:7",
  amuxSessionAttempt: 1,
  askingProvider: "claude",
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  ...overrides,
});

const noLease = () => {};
/** A typed ask the router sends to a DM: no irreversible term, no secret, within every limit. */
const CARD = {
  askType: "decision",
  resolution: null,
  type: "task",
  tags: [],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: [
    { id: "a", label: "Model id only" },
    { id: "b", label: "Model id and locale" },
  ],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
};

/** The binding a result submission repeats: everything but the provider, which its instance already is. */
const withoutProvider = (value: Record<string, unknown>) => {
  const copy = { ...value };
  delete copy.askingProvider;
  return copy;
};

// ---------------------------------------------------------------------------
// The request row
// ---------------------------------------------------------------------------

test("a request's route, instance and refusal codes are closed and agree with each other", async () => {
  for (const [overrides, constraint] of [
    [{ route: "autonomous" }, /AmuxDecisionMakerRequest_route_check|route_refusals_check/],
    // An instance with no switch is off, so the switch read may refuse it first.
    [
      { instance: "decision-maker-gemini" },
      /AmuxDecisionMakerRequest_(instance_check|provider_instance_check)|AMUX_DM_REQUEST_SWITCH/,
    ],
    // §7: the other vendor's DM, none for a verified provider, one for an unverified one.
    [{ instance: ANTHROPIC }, /AmuxDecisionMakerRequest_provider_instance_check/],
    [{ instance: null, route: "operator", refusalCodes: ["provider_unverified"] }, /AmuxDecisionMakerRequest_provider_instance_check/],
    [{ askingProvider: "gemini", route: "operator", refusalCodes: ["provider_unverified"] }, /AmuxDecisionMakerRequest_provider_instance_check/],
    [{ askingProvider: "Claude" }, /AmuxDecisionMakerRequest_(asking_provider_format_check|provider_instance_check)/],
    // The router's codes only, as a flat list with no NULL.
    [{ route: "operator", refusalCodes: ["autonomous"] }, /AmuxDecisionMakerRequest_refusal_codes_check/],
    [{ route: "operator", refusalCodes: ["instance_off", null as unknown as string] }, /AmuxDecisionMakerRequest_refusal_codes_check/],
    [{ refusalCodes: null }, /AmuxDecisionMakerRequest_refusal_codes_check|route_refusals_check|unverified_provider_check/],
    // A proposal carries no refusal; an operator route at least one.
    [{ refusalCodes: ["instance_off"] }, /AmuxDecisionMakerRequest_route_refusals_check/],
    [{ route: "operator" }, /AmuxDecisionMakerRequest_route_refusals_check/],
    // provider_unverified exactly when there is no instance.
    [{ route: "operator", refusalCodes: ["provider_unverified"] }, /AmuxDecisionMakerRequest_unverified_provider_check/],
    // Formats.
    [{ cardId: "card 1" }, /AmuxDecisionMakerRequest_identifier_format_check/],
    [{ askingWorkerId: "" }, /AmuxDecisionMakerRequest_identifier_format_check/],
    [{ amuxSessionId: "s/1" }, /AmuxDecisionMakerRequest_identifier_format_check/],
    [{ questionRevision: -1 }, /AmuxDecisionMakerRequest_counter_check/],
    [{ amuxSessionAttempt: -1 }, /AmuxDecisionMakerRequest_counter_check/],
    [{ optionSetDigest: DIGEST_A.toUpperCase() }, /AmuxDecisionMakerRequest_option_set_digest_format_check/],
    [{ policyVersion: 0 }, /AmuxDecisionMakerRequest_version_check/],
    [{ scannerVersion: "V1" }, /AmuxDecisionMakerRequest_version_check/],
  ] as const) {
    await rejectsWith(insertRequest(requestRow(overrides as Partial<RequestRow>)), constraint);
  }
  // A repeated code is the guard's refusal.
  await rejectsWith(
    insertRequest(requestRow({ route: "operator", refusalCodes: ["instance_off", "instance_off"] })),
    /AMUX_DM_REQUEST_REFUSALS/,
  );
  assert.equal((await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "AmuxDecisionMakerRequest"`).length, 0);

  // What the router records is accepted.
  await insertRequest(requestRow());
  await insertRequest(requestRow({ askingProvider: "codex", instance: ANTHROPIC, route: "operator", refusalCodes: ["instance_off", "irreversible_term"] }));
  await insertRequest(requestRow({ askingProvider: "gemini", instance: null, route: "operator", refusalCodes: ["settings_unreadable", "provider_unverified"] }));
  assert.equal((await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "AmuxDecisionMakerRequest"`).length, 3);
});

test("a request needs the router's route audit of its own transaction, naming it", async () => {
  await rejectsWith(insertRequest(requestRow(), { kind: "none" }), /AMUX_DM_REQUEST_UNAUDITED/);
  await rejectsWith(insertRequest(requestRow(), { ...ROUTE_AUDIT, action: "amux.decision.assign" } as Audit), /AMUX_DM_REQUEST_UNAUDITED/);
  await rejectsWith(insertRequest(requestRow(), { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.route" }), /AMUX_DM_REQUEST_UNAUDITED/);
  await rejectsWith(insertRequest(requestRow(), { kind: "person", action: "amux.decision.route" }), /AMUX_DM_REQUEST_UNAUDITED/);
  await rejectsWith(insertRequest(requestRow(), { ...ROUTE_AUDIT, targetId: randomUUID() } as Audit), /AMUX_DM_REQUEST_UNAUDITED/);
  await rejectsWith(insertRequest(requestRow(), { ...ROUTE_AUDIT, targetType: EVENT } as Audit), /AMUX_DM_REQUEST_UNAUDITED/);
  // An audit row committed by an earlier transaction is not this request's.
  const id = randomUUID();
  const earlier = await prisma.$transaction((tx) => writeAudit(tx, ROUTE_AUDIT, REQUEST, id));
  await rejectsWith(prisma.$transaction((tx) => insertRequestRow(tx, id, requestRow(), earlier)), /AMUX_DM_REQUEST_UNAUDITED/);
  // One audit row names one request only.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const first = randomUUID();
      const auditLogId = await writeAudit(tx, ROUTE_AUDIT, REQUEST, first);
      await insertRequestRow(tx, first, requestRow(), auditLogId);
      await insertRequestRow(tx, randomUUID(), requestRow(), auditLogId);
    }),
    /AMUX_DM_REQUEST_UNAUDITED|AmuxDecisionMakerRequest_auditLogId_key|Unique constraint/,
  );
  assert.equal((await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "AmuxDecisionMakerRequest"`).length, 0);
});

test("createdAt and the assignment deadline are the database's, whatever the writer sent", async () => {
  const before = await dbNow();
  const id = await insertRequest();
  const afterInsert = await dbNow();
  const [row] = await prisma.$queryRaw<Array<{ createdAt: Date; assignmentDeadlineAt: Date }>>`
    SELECT "createdAt", "assignmentDeadlineAt" FROM "AmuxDecisionMakerRequest" WHERE "id" = ${id}
  `;
  assert.ok(row);
  assert.ok(row.createdAt.getTime() >= before.getTime() - 1);
  assert.ok(row.createdAt.getTime() <= afterInsert.getTime() + 1);
  assert.equal(row.assignmentDeadlineAt.getTime() - row.createdAt.getTime(), 2 * MINUTE);
});

test("one request per card question revision; the store returns the first", async () => {
  const shared = binding();
  const first = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: shared, card: CARD }),
  );
  assert.equal(first.created, true);
  const again = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: { ...shared, amuxSessionAttempt: 2 }, card: { ...CARD, title: "Deploy it" } }),
  );
  // The second call wrote no route audit (2026-10-09: the first's is what its card text is bound to).
  assert.deepEqual(again, { ...first, created: false, sameBinding: false, routeAuditLogId: null });
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: first.requestId, action: "amux.decision.route" } });
  assert.equal(first.routeAuditLogId, audit.id);
  assert.deepEqual(audit.metadata, {
    request_id: first.requestId,
    route: "dm_proposal",
    instance: OPENAI,
    asking_provider: "claude",
    refusal_codes: [],
    systemActor: "amux-decision-router",
  });
  await rejectsWith(
    insertRequest(requestRow({ cardId: shared.cardId, questionRevision: shared.questionRevision })),
    /AmuxDecisionMakerRequest_cardId_questionRevision_key|Unique constraint|duplicate key/,
  );
  // The next revision of the same card is a new request.
  const next = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: { ...shared, questionRevision: shared.questionRevision + 1 }, card: CARD }),
  );
  assert.equal(next.created, true);
  assert.notEqual(next.requestId, first.requestId);
});

test("requests and events are never updated or deleted", async () => {
  const requestId = await insertRequest();
  const eventId = await insertEvent(requestId, { kind: "assign" });
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerRequest" SET "route" = 'operator' WHERE "id" = ${requestId}`, /AMUX_DM_REQUEST_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerRequest" SET "assignmentDeadlineAt" = clock_timestamp() + INTERVAL '1 day' WHERE "id" = ${requestId}`, /AMUX_DM_REQUEST_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerRequest" WHERE "id" = ${requestId}`, /AMUX_DM_REQUEST_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxDecisionMakerRequestEvent" SET "resultDeadlineAt" = clock_timestamp() + INTERVAL '1 day' WHERE "id" = ${eventId}`, /AMUX_DM_REQUEST_EVENT_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerRequestEvent" WHERE "id" = ${eventId}`, /AMUX_DM_REQUEST_EVENT_IMMUTABLE/);
  assert.equal((await rowsOf(requestId)).length, 1);
});

// ---------------------------------------------------------------------------
// Events: shape, audit, order, isolation
// ---------------------------------------------------------------------------

test("each event kind carries what it records, and nothing more", async () => {
  // Every attempt below passes the transition graph, so the refusal is the CHECK named.
  const requestId = await insertRequest();
  await insertEvent(requestId, { kind: "assign" });
  const refusedBy = async (attempts: ReadonlyArray<readonly [EventRow, RegExp]>) => {
    for (const [event, constraint] of attempts) {
      await rejectsWith(insertEvent(requestId, event), constraint);
    }
  };
  await rejectsWith(insertEvent(requestId, { kind: "autonomous_answer" }), /AMUX_DM_REQUEST_EVENT_TRANSITION/);
  await refusedBy([
    [{ ...INTENT, vendor: "anthropic" }, /AmuxDecisionMakerRequestEvent_vendor_instance_check/],
    [{ ...INTENT, vendor: null }, /AmuxDecisionMakerRequestEvent_transmit_intent_shape_check/],
    [{ ...INTENT, inputPayloadDigest: null }, /AmuxDecisionMakerRequestEvent_transmit_intent_shape_check/],
    [{ ...INTENT, snapshotState: "worker_head" }, /AmuxDecisionMakerRequestEvent_transmit_intent_shape_check/],
    [{ ...INTENT, snapshotTargetSha: SHA }, /AmuxDecisionMakerRequestEvent_transmit_intent_shape_check/],
    [{ ...INTENT, snapshotState: "local" }, /AmuxDecisionMakerRequestEvent_snapshot_state_check/],
    [
      { ...INTENT, snapshotState: "develop", snapshotTargetSha: SHA.toUpperCase(), snapshotManifestDigest: DIGEST_D },
      /AmuxDecisionMakerRequestEvent_digest_format_check/,
    ],
    [{ ...INTENT, resultDigest: DIGEST_C }, /AmuxDecisionMakerRequestEvent_result_digest_kind_check/],
    [{ ...INTENT, instance: null }, /AmuxDecisionMakerRequestEvent_instance_kind_check/],
    [{ kind: "assign_discarded", instance: OPENAI }, /AmuxDecisionMakerRequestEvent_instance_kind_check/],
    [{ kind: "assign_discarded", resultDeadlineAt: "2099-01-01T00:00:00Z" }, /AmuxDecisionMakerRequestEvent_result_deadline_kind_check/],
  ]);
  await insertEvent(requestId, { ...INTENT, snapshotState: "develop", snapshotTargetSha: SHA, snapshotManifestDigest: DIGEST_D });
  await refusedBy([
    [{ kind: "transmit_receipt", instance: OPENAI, vendor: "openai" }, /AmuxDecisionMakerRequestEvent_intent_columns_check/],
    [{ kind: "transmit_receipt", instance: OPENAI, inputPayloadDigest: DIGEST_B }, /AmuxDecisionMakerRequestEvent_payload_kind_check/],
    [{ kind: "transmit_receipt", instance: OPENAI, resultKind: "proposal" }, /AmuxDecisionMakerRequestEvent_result_columns_check/],
    [{ kind: "result", instance: OPENAI, resultDigest: DIGEST_C, inputPayloadDigest: DIGEST_B }, /AmuxDecisionMakerRequestEvent_result_columns_check/],
    [{ ...PROPOSAL, resultKind: "approve" }, /AmuxDecisionMakerRequestEvent_result_kind_check/],
    [{ ...PROPOSAL, resultDigest: null }, /AmuxDecisionMakerRequestEvent_result_digest_kind_check/],
    [{ kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_C }, /AmuxDecisionMakerRequestEvent_rejection_columns_check/],
    [
      { kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_C, rejectionReason: "too_late" },
      /AmuxDecisionMakerRequestEvent_rejection_reason_check/,
    ],
    [{ kind: "result_unknown", instance: OPENAI }, /AmuxDecisionMakerRequestEvent_result_digest_kind_check/],
  ]);
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign", "transmit_intent"]);
});

test("every event needs an audit row of its own transaction, its own target, and the right actor and action", async () => {
  const requestId = await insertRequest();
  const assign: EventRow = { kind: "assign" };
  await rejectsWith(insertEvent(requestId, assign, { kind: "none" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  // An instance does not assign, a person does not either, and the action is the kind's.
  await rejectsWith(insertEvent(requestId, assign, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.assign" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  await rejectsWith(insertEvent(requestId, assign, { kind: "person", action: "amux.decision.assign" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  await rejectsWith(insertEvent(requestId, assign, { kind: "system", actor: "amux-decision-router", action: "amux.decision.route" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  // The audit names the event, not the request.
  await rejectsWith(
    insertEvent(requestId, assign, { kind: "system", actor: "amux-decision-router", action: "amux.decision.assign", targetType: REQUEST, targetId: requestId }),
    /AMUX_DM_REQUEST_EVENT_UNAUDITED/,
  );
  await insertEvent(requestId, assign);
  // The router does not transmit; neither does the other vendor's instance.
  await rejectsWith(insertEvent(requestId, INTENT, { kind: "system", actor: "amux-decision-router", action: "amux.decision.transmit_intent" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  await rejectsWith(insertEvent(requestId, INTENT, { kind: "system", actor: "amux-decision-maker-anthropic", action: "amux.decision.transmit_intent" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  await rejectsWith(insertEvent(requestId, INTENT, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.result" }), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  // An event naming the other instance is refused before its audit is looked at.
  await rejectsWith(
    insertEvent(requestId, { ...INTENT, instance: ANTHROPIC, vendor: "anthropic" }, { kind: "system", actor: "amux-decision-maker-anthropic", action: "amux.decision.transmit_intent" }),
    /AMUX_DM_REQUEST_EVENT_INSTANCE/,
  );
  // An audit row committed by an earlier transaction is not this event's.
  const id = randomUUID();
  const earlier = await prisma.$transaction((tx) => writeAudit(tx, eventAudit(INTENT), EVENT, id));
  await rejectsWith(prisma.$transaction((tx) => insertEventRow(tx, id, requestId, INTENT, earlier)), /AMUX_DM_REQUEST_EVENT_UNAUDITED/);
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign"]);
  await insertEvent(requestId, INTENT);
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign", "transmit_intent"]);
});

test("an event numbered below the request's newest is refused, and createdAt is the database's", async () => {
  const requestId = await insertRequest();
  const before = await dbNow();
  await insertEvent(requestId, { kind: "assign" });
  await insertEvent(requestId, INTENT);
  const rows = await rowsOf(requestId);
  assert.ok(rows[0]!.createdAt.getTime() >= before.getTime() - 1, "createdAt is the insert's clock, not 2001");
  assert.equal(rows[0]!.resultDeadlineAt!.getTime() - rows[0]!.createdAt.getTime(), 30 * MINUTE);
  await rejectsWith(
    insertEvent(requestId, { kind: "transmit_receipt", instance: OPENAI, sequence: Number(rows[1]!.sequence) - 1 }),
    /AMUX_DM_REQUEST_EVENT_OUT_OF_ORDER|duplicate key|Unique constraint|sequence_key/i,
  );
});

test("the event guard refuses any isolation level but READ COMMITTED", async () => {
  const requestId = await insertRequest();
  for (const isolationLevel of [
    Prisma.TransactionIsolationLevel.RepeatableRead,
    Prisma.TransactionIsolationLevel.Serializable,
  ]) {
    await rejectsWith(
      prisma.$transaction(
        async (tx) => {
          const id = randomUUID();
          await insertEventRow(tx, id, requestId, { kind: "assign" }, await writeAudit(tx, eventAudit({ kind: "assign" }), EVENT, id));
        },
        { isolationLevel },
      ),
      /AMUX_DM_REQUEST_EVENT_ISOLATION/,
    );
  }
  assert.equal((await rowsOf(requestId)).length, 0);
  await prisma.$transaction(
    async (tx) => {
      const id = randomUUID();
      await insertEventRow(tx, id, requestId, { kind: "assign" }, await writeAudit(tx, eventAudit({ kind: "assign" }), EVENT, id));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  assert.equal((await rowsOf(requestId)).length, 1);
});

// ---------------------------------------------------------------------------
// The transition graph
// ---------------------------------------------------------------------------

const ATTEMPTS: Record<string, { row: EventRow; attempt: DmEventAttempt }> = {
  assign: { row: { kind: "assign" }, attempt: { kind: "assign" } },
  assign_discarded: { row: { kind: "assign_discarded" }, attempt: { kind: "assign_discarded" } },
  transmit_intent: { row: INTENT, attempt: { kind: "transmit_intent", instance: OPENAI } },
  transmit_receipt: { row: RECEIPT, attempt: { kind: "transmit_receipt", instance: OPENAI } },
  transmit_unknown: { row: { kind: "transmit_unknown", instance: OPENAI }, attempt: { kind: "transmit_unknown", instance: OPENAI } },
  proposal: {
    row: { ...PROPOSAL, resultDigest: DIGEST_D },
    attempt: { kind: "result", instance: OPENAI, resultKind: "proposal", resultDigest: DIGEST_D, inputPayloadDigest: DIGEST_B },
  },
  proposal_without_payload: {
    row: { ...PROPOSAL, resultDigest: DIGEST_D, inputPayloadDigest: null },
    attempt: { kind: "result", instance: OPENAI, resultKind: "proposal", resultDigest: DIGEST_D, inputPayloadDigest: null },
  },
  escalate: {
    row: { ...PROPOSAL, resultKind: "escalate", resultDigest: DIGEST_D },
    attempt: { kind: "result", instance: OPENAI, resultKind: "escalate", resultDigest: DIGEST_D, inputPayloadDigest: DIGEST_B },
  },
  timeout: {
    row: { ...PROPOSAL, resultKind: "timeout", resultDigest: DIGEST_D },
    attempt: { kind: "result", instance: OPENAI, resultKind: "timeout", resultDigest: DIGEST_D, inputPayloadDigest: DIGEST_B },
  },
  unavailable_before_intent: {
    row: { kind: "result", instance: OPENAI, resultKind: "unavailable", resultDigest: DIGEST_D },
    attempt: { kind: "result", instance: OPENAI, resultKind: "unavailable", resultDigest: DIGEST_D, inputPayloadDigest: null },
  },
  result_unknown: {
    row: { kind: "result_unknown", instance: OPENAI, resultDigest: DIGEST_D },
    attempt: { kind: "result_unknown", instance: OPENAI, resultDigest: DIGEST_D },
  },
  stale_close: { row: { kind: "stale_close" }, attempt: { kind: "stale_close" } },
  ...Object.fromEntries(
    (["request_closed", "terminal_exists", "result_unknown", "not_transmitted", "deadline_passed", "binding_mismatch", "kill_switch"] as const).map(
      (reason) => [
        `rejected_${reason}`,
        {
          row: { kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_D, rejectionReason: reason },
          attempt: { kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_D, rejectionReason: reason },
        },
      ],
    ),
  ),
};

type GraphRefusal = DmEventRefusal | "kill_switch_on" | "instance_off";

/** The trigger's message for each clause the core can name. */
const triggerMessageFor = (refusal: GraphRefusal): RegExp =>
  refusal === "instance_mismatch"
    ? /AMUX_DM_REQUEST_EVENT_INSTANCE/
    : refusal === "deadline_passed"
      ? /AMUX_DM_REQUEST_EVENT_DEADLINE/
      : refusal === "kill_switch_on" || refusal === "instance_off"
        ? /AMUX_DM_REQUEST_EVENT_SWITCH/
        : /AMUX_DM_REQUEST_EVENT_TRANSITION/;

const STATE_BUILDERS: Record<string, () => Promise<string>> = {
  fresh: () => insertRequest(),
  operator: () => insertRequest(requestRow({ route: "operator", refusalCodes: ["instance_off"] })),
  assigned: async () => {
    const id = await insertRequest();
    await insertEvent(id, { kind: "assign" });
    return id;
  },
  transmitted: async () => {
    const id = await STATE_BUILDERS.assigned!();
    await insertEvent(id, INTENT);
    return id;
  },
  receipted: async () => {
    const id = await STATE_BUILDERS.transmitted!();
    await insertEvent(id, RECEIPT);
    return id;
  },
  terminal: async () => {
    const id = await STATE_BUILDERS.transmitted!();
    await insertEvent(id, PROPOSAL);
    return id;
  },
  resultUnknown: async () => {
    const id = await STATE_BUILDERS.transmitted!();
    await insertEvent(id, { kind: "result_unknown", instance: OPENAI, resultDigest: DIGEST_C });
    return id;
  },
  discarded: async () => {
    const id = await STATE_BUILDERS.assigned!();
    await insertEvent(id, { kind: "assign_discarded" });
    return id;
  },
  assignmentLate: () => backdatedRequest(2 * MINUTE + 1_000),
  transmittedLate: async () => {
    const id = await insertRequest();
    await backdatedAssignment(id, -1_000);
    return id;
  },
  staleClosed: async () => {
    const id = await backdatedRequest(30 * 24 * 60 * MINUTE + MINUTE);
    await backdatedAssignment(id, -1_000);
    await insertEvent(id, { kind: "stale_close" });
    return id;
  },
  stale: () => backdatedRequest(30 * 24 * 60 * MINUTE + MINUTE),
};

test("the trigger and the core agree on every state, every event and every switch setting, and the graph refuses what it must", async () => {
  // Every state is built while both instances propose and the kill switch is
  // off; each is then probed under three switch settings, against
  // dmEventRefusal() and then dmEventSwitchRefusal() on the switches read back.
  const requests = new Map<string, string>();
  for (const [stateName, build] of Object.entries(STATE_BUILDERS)) requests.set(stateName, await build());
  const seen = new Map<string, GraphRefusal | null>();
  const settings: Array<[string, () => Promise<unknown>]> = [
    ["permissive", async () => {}],
    ["kill", () => setSwitch("kill_switch", "on")],
    [
      "instanceOff",
      async () => {
        await setSwitch("kill_switch", "off");
        await setSwitch("decision-maker-openai", "off");
      },
    ],
  ];
  for (const [settingName, apply] of settings) {
    await apply();
    const switches = dmSwitchRoutingInput(await readDecisionMakerSwitches(prisma), OPENAI);
    for (const [stateName, requestId] of requests) {
      for (const [attemptName, { row, attempt }] of Object.entries(ATTEMPTS)) {
        const state = await readDecisionMakerRequestState(prisma, requestId, DIGEST_D);
        assert.ok(state, stateName);
        const expected: GraphRefusal | null = dmEventRefusal(state, attempt) ?? dmEventSwitchRefusal(attempt, switches);
        const key = `${settingName}: ${stateName} + ${attemptName}`;
        seen.set(key, expected);
        const refusal = await tryEvent(requestId, row);
        if (expected === null) {
          assert.equal(refusal, null, `${key}: the core accepts, the trigger refused: ${String(refusal)}`);
        } else {
          assert.ok(refusal !== null, `${key}: the core refuses (${expected}), the trigger accepted`);
          const record = refusal as { meta?: unknown; cause?: unknown };
          assert.match(
            [String(refusal), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" "),
            triggerMessageFor(expected),
            key,
          );
        }
      }
    }
  }
  // The switches, against the trigger.
  for (const [key, expected] of [
    ["permissive: assigned + transmit_intent", null],
    ["kill: assigned + transmit_intent", "kill_switch_on"],
    ["instanceOff: assigned + transmit_intent", "instance_off"],
    ["kill: transmitted + proposal", "kill_switch_on"],
    ["kill: transmitted + escalate", null],
    ["kill: transmitted + timeout", null],
    ["instanceOff: transmitted + proposal", null],
    ["permissive: transmitted + rejected_kill_switch", "reason_inconsistent"],
    ["kill: transmitted + rejected_kill_switch", null],
    ["instanceOff: transmitted + rejected_kill_switch", "reason_inconsistent"],
    ["kill: transmitted + transmit_receipt", null],
    ["kill: discarded + transmit_intent", "closed"],
    ["kill: fresh + assign", null],
  ] as const) {
    assert.equal(seen.get(key), expected, key);
  }
  // Not vacuous: the graph's defining refusals were exercised against the trigger.
  for (const [key, expected] of [
    ["permissive: fresh + assign", null],
    ["permissive: fresh + transmit_intent", "not_assigned"],
    ["permissive: operator + assign", "not_routed_to_dm"],
    ["permissive: operator + rejected_request_closed", null],
    ["permissive: assigned + assign", "already_assigned"],
    ["permissive: assigned + proposal_without_payload", "not_transmitted"],
    ["permissive: assigned + unavailable_before_intent", null],
    ["permissive: transmitted + transmit_intent", "already_transmitted"],
    ["permissive: transmitted + proposal", null],
    ["permissive: transmitted + proposal_without_payload", "payload_mismatch"],
    ["permissive: transmitted + assign_discarded", "already_transmitted"],
    ["permissive: receipted + transmit_unknown", "transmit_outcome_recorded"],
    ["permissive: terminal + proposal", "result_recorded"],
    ["permissive: terminal + transmit_receipt", null],
    ["permissive: terminal + rejected_terminal_exists", null],
    ["permissive: resultUnknown + timeout", "result_unknown_recorded"],
    ["permissive: discarded + transmit_intent", "closed"],
    ["permissive: discarded + stale_close", "closed"],
    ["permissive: assignmentLate + assign", "deadline_passed"],
    ["permissive: transmittedLate + proposal", "deadline_passed"],
    ["permissive: transmittedLate + escalate", "deadline_passed"],
    ["permissive: transmittedLate + timeout", null],
    ["permissive: transmittedLate + rejected_deadline_passed", null],
    ["permissive: staleClosed + transmit_receipt", null],
    ["permissive: staleClosed + proposal", "closed"],
    ["permissive: stale + stale_close", null],
    ["permissive: fresh + stale_close", "not_stale"],
    ["permissive: transmitted + rejected_request_closed", "reason_inconsistent"],
  ] as const) {
    assert.equal(seen.get(key), expected, key);
  }
});

// ---------------------------------------------------------------------------
// Deadlines by the database clock
// ---------------------------------------------------------------------------

test("an assignment after its 2-minute deadline is refused, by the store and by the trigger", async () => {
  const requestId = await backdatedRequest(2 * MINUTE + 1_000);
  const leases: Date[] = [];
  const refused = await prisma.$transaction((tx) =>
    assignDecisionMakerRequest(tx, { requestId, requireLeaseAt: (deadline) => leases.push(deadline) }),
  );
  assert.deepEqual(refused, { recorded: false, reason: "deadline_passed" });
  assert.equal(leases.length, 0);
  await rejectsWith(insertEvent(requestId, { kind: "assign" }), /AMUX_DM_REQUEST_EVENT_DEADLINE/);
  // Within the deadline the store assigns and hands the deadline to the fence.
  const onTime = await insertRequest();
  const assigned = await prisma.$transaction((tx) =>
    assignDecisionMakerRequest(tx, { requestId: onTime, requireLeaseAt: (deadline) => leases.push(deadline) }),
  );
  assert.equal(assigned.recorded, true);
  assert.deepEqual(leases.map((lease) => lease.getTime()), [await assignmentDeadlineMs(onTime)]);
  assert.ok(assigned.recorded && assigned.event.resultDeadlineAt !== null);
  // Single consumption: an assignment is handed out once.
  assert.deepEqual(
    await prisma.$transaction((tx) => assignDecisionMakerRequest(tx, { requestId: onTime, requireLeaseAt: noLease })),
    { recorded: false, reason: "already_assigned" },
  );
  await rejectsWith(insertEvent(onTime, { kind: "assign" }), /AMUX_DM_REQUEST_EVENT_TRANSITION|one_assign_key|duplicate key/);
});

// Deadlines as epoch milliseconds from the database: a timestamptz read back
// as a Date can move with the session TimeZone; an epoch cannot.
const assignmentDeadlineMs = async (requestId: string) =>
  Number(
    (
      await prisma.$queryRaw<Array<{ ms: bigint }>>`
        SELECT floor(extract(epoch FROM "assignmentDeadlineAt") * 1000)::bigint AS "ms"
        FROM "AmuxDecisionMakerRequest" WHERE "id" = ${requestId}
      `
    )[0]!.ms,
  );
const resultDeadlineMs = async (requestId: string) =>
  Number(
    (
      await prisma.$queryRaw<Array<{ ms: bigint }>>`
        SELECT floor(extract(epoch FROM "resultDeadlineAt") * 1000)::bigint AS "ms"
        FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} AND "kind" = 'assign'
      `
    )[0]!.ms,
  );

/**
 * Inserts `event` while its deadline less the commit reserve is still ahead,
 * then lets the database clock pass it before COMMIT, with no idle gap. The
 * insert must be accepted; the COMMIT must fail with AX001 and leave nothing.
 */
const commitAfterDeadline = async (requestId: string, event: EventRow, deadlineMs: number) => {
  const d = deadlineMs - DM_COMMIT_RESERVE_MS;
  const seen = { insertedBeforeDeadline: false };
  const error = await rejectsWith(
    prisma.$transaction(
      async (tx) => {
        const id = randomUUID();
        await insertEventRow(tx, id, requestId, event, await writeAudit(tx, eventAudit(event), EVENT, id));
        const [clock] = await tx.$queryRaw<Array<{ nowMs: bigint }>>`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
        `;
        seen.insertedBeforeDeadline = Number(clock!.nowMs) < d;
        // Walk the clock past D in short steps, each under any statement timeout.
        for (;;) {
          const [now] = await tx.$queryRaw<Array<{ nowMs: bigint }>>`
            SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
          `;
          if (Number(now!.nowMs) >= d + 20) break;
          await tx.$executeRaw`SELECT pg_sleep(0.05)`;
        }
      },
      { timeout: 10_000 },
    ),
  );
  assert.equal(seen.insertedBeforeDeadline, true, "setup: the insert must land before the deadline less the reserve");
  assert.equal(isAmuxLateCommitError(error), true, `the late COMMIT was not refused with AX001: ${String(error)}`);
};

test("an assignment whose COMMIT reaches the database after the deadline is refused at COMMIT", async () => {
  // Created 2 minutes less 1.5 s ago: D is about 1.3 s away.
  const requestId = await backdatedRequest(2 * MINUTE - 1_500);
  await commitAfterDeadline(requestId, { kind: "assign" }, await assignmentDeadlineMs(requestId));
  assert.equal((await rowsOf(requestId)).length, 0, "the refused COMMIT left no assignment");
});

test("a DM output after the result deadline is refused at the insert and at COMMIT; a timeout is not held to it", async () => {
  // Already past: the guard refuses at the insert, and the store records a rejection instead.
  const late = await insertRequest();
  await backdatedAssignment(late, -1_000);
  for (const resultKind of ["proposal", "escalate", "validation_failure"]) {
    await rejectsWith(insertEvent(late, { ...PROPOSAL, resultKind }), /AMUX_DM_REQUEST_EVENT_DEADLINE/);
  }
  const state = await readDecisionMakerRequestState(prisma, late);
  assert.ok(state);
  const submitted = await prisma.$transaction((tx) =>
    submitDecisionMakerResult(tx, {
      requestId: late,
      requireLeaseAt: noLease,
      submission: {
        instance: OPENAI,
        resultKind: "proposal",
        resultDigest: DIGEST_C,
        binding: {
          cardId: state.binding.cardId,
          questionRevision: state.binding.questionRevision,
          askingWorkerId: state.binding.askingWorkerId,
          amuxSessionId: state.binding.amuxSessionId,
          amuxSessionAttempt: state.binding.amuxSessionAttempt,
          optionSetDigest: state.binding.optionSetDigest,
          policyVersion: 1,
          termListVersion: state.binding.termListVersion,
          classificationVersion: state.binding.classificationVersion,
          scannerVersion: state.binding.scannerVersion,
          transmission: state.transmission,
        },
      },
    }),
  );
  assert.equal(submitted.status, "rejected");
  assert.ok(submitted.status === "rejected" && submitted.reason === "deadline_passed");
  // A timeout comes after the deadline by definition, and is recorded.
  await insertEvent(late, { ...PROPOSAL, resultKind: "timeout", resultDigest: DIGEST_D });
  assert.deepEqual(
    (await rowsOf(late)).map((row) => [row.kind, row.resultKind]),
    [
      ["assign", null],
      ["transmit_intent", null],
      ["result_rejected", null],
      ["result", "timeout"],
    ],
  );

  // On time at the insert, late at COMMIT: AX001, and no result.
  const racing = await insertRequest();
  await backdatedAssignment(racing, 1_500);
  await commitAfterDeadline(racing, PROPOSAL, await resultDeadlineMs(racing));
  assert.deepEqual((await rowsOf(racing)).map((row) => row.kind), ["assign", "transmit_intent"]);
});

test("through the AMUX boundary, the store's result commits on time and its deadline reaches the fence", async () => {
  const shared = binding();
  const recorded = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: shared, card: CARD }),
  );
  // The binding as stored, with the option set digest the store computed.
  const requestBinding = withoutProvider((await readDecisionMakerRequestState(prisma, recorded.requestId))!.binding);
  const boundary = { operation: "dm_ledger_test", prismaCallCeiling: 12, isolation: "mutation" as const };
  const assigned = await withAmuxDbBoundary(boundary, (tx, context) =>
    assignDecisionMakerRequest(tx, { requestId: recorded.requestId, requireLeaseAt: context.requireLeaseAt }),
  );
  assert.equal(assigned.recorded, true);
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  const intent = await withAmuxDbBoundary(boundary, (tx) =>
    recordDecisionMakerTransmitIntent(tx, { requestId: recorded.requestId, instance: OPENAI, transmission, requireLeaseAt: noLease }),
  );
  assert.equal(intent.recorded, true);
  const leases: Date[] = [];
  const submitted = await withAmuxDbBoundary(boundary, (tx, context) =>
    submitDecisionMakerResult(tx, {
      requestId: recorded.requestId,
      requireLeaseAt: (deadline) => {
        leases.push(deadline);
        context.requireLeaseAt(deadline);
      },
      submission: {
        instance: OPENAI,
        resultKind: "proposal",
        resultDigest: DIGEST_C,
        binding: { ...requestBinding, policyVersion: 1, transmission },
      },
    }),
  );
  assert.equal(submitted.status, "accepted");
  assert.ok(assigned.recorded && assigned.event.resultDeadlineAt);
  assert.deepEqual(leases.map((lease) => lease.toISOString()), [assigned.event.resultDeadlineAt]);
  assert.equal(await prisma.amuxCommitDeadline.count(), 0, "the fence's marker is gone after an on-time COMMIT");
});

// ---------------------------------------------------------------------------
// One terminal result, idempotent on its pair
// ---------------------------------------------------------------------------

test("a request has one terminal result; its pair returns it, another digest is recorded as rejected", async () => {
  const shared = binding();
  const recorded = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: shared, card: CARD }),
  );
  const requestId = recorded.requestId;
  await prisma.$transaction((tx) => assignDecisionMakerRequest(tx, { requestId, requireLeaseAt: noLease }));
  const transmission = { snapshotState: "worker_head", snapshotTargetSha: SHA, snapshotManifestDigest: DIGEST_D, inputPayloadDigest: DIGEST_B };
  // No transmission while the kill switch is on or the instance is off (§6,
  // §8): the store reads the switch store itself, after the lock.
  const intent = () =>
    prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission, requireLeaseAt: noLease }));
  await setSwitch("kill_switch", "on");
  assert.deepEqual(await intent(), { recorded: false, reason: "kill_switch_on" });
  await setSwitch("kill_switch", "off");
  await setSwitch("decision-maker-openai", "off");
  assert.deepEqual(await intent(), { recorded: false, reason: "instance_off" });
  await setSwitch("decision-maker-openai", "proposal");
  // The transmission is recorded before any DM process; a second is refused.
  assert.equal((await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission, requireLeaseAt: noLease }))).recorded, true);
  assert.deepEqual(
    await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission, requireLeaseAt: noLease })),
    { recorded: false, reason: "already_transmitted" },
  );
  const requestBinding = withoutProvider((await readDecisionMakerRequestState(prisma, requestId))!.binding);
  const submit = (resultDigest: string, overrides: Record<string, unknown> = {}) =>
    prisma.$transaction((tx) =>
      submitDecisionMakerResult(tx, {
        requestId,
          requireLeaseAt: noLease,
        submission: {
          instance: OPENAI,
          resultKind: "proposal",
          resultDigest,
          binding: { ...requestBinding, policyVersion: 1, transmission, ...overrides },
        },
      }),
    );

  // A binding value that changed is a rejection, not a result.
  const mismatch = await submit(DIGEST_A, { amuxSessionAttempt: 2 });
  assert.ok(mismatch.status === "rejected" && mismatch.reason === "binding_mismatch");
  const accepted = await submit(DIGEST_C);
  assert.equal(accepted.status, "accepted");
  const eventsAfterAccept = (await rowsOf(requestId)).length;
  // The same pair returns the recorded result and writes nothing.
  assert.deepEqual(await submit(DIGEST_C), {
    status: "existing",
    eventId: accepted.status === "accepted" ? accepted.event.eventId : "",
    resultKind: "proposal",
  });
  assert.equal((await rowsOf(requestId)).length, eventsAfterAccept);
  // Another digest for the same request is recorded as rejected, once.
  const other = await submit(DIGEST_D);
  assert.ok(other.status === "rejected" && other.reason === "terminal_exists");
  assert.deepEqual(await submit(DIGEST_D), { status: "already_rejected", reason: "terminal_exists" });
  // The earlier rejected pair stays rejected.
  assert.deepEqual(await submit(DIGEST_A, { amuxSessionAttempt: 2 }), { status: "already_rejected", reason: "binding_mismatch" });
  assert.equal((await rowsOf(requestId)).filter((row) => row.kind === "result").length, 1);
  // A second result is refused by the database too, whatever its digest.
  await rejectsWith(insertEvent(requestId, { ...PROPOSAL, resultDigest: DIGEST_D }), /AMUX_DM_REQUEST_EVENT_TRANSITION|one_result_key|duplicate key/);

  // §9: a submitter that lost its response settles the pair by lookup alone.
  assert.deepEqual(await lookupDecisionMakerResult(prisma, { requestId, resultDigest: DIGEST_C }), {
    status: "accepted",
    eventId: accepted.status === "accepted" ? accepted.event.eventId : "",
    resultKind: "proposal",
  });
  assert.deepEqual(await lookupDecisionMakerResult(prisma, { requestId, resultDigest: DIGEST_D }), { status: "rejected", reason: "terminal_exists" });
  assert.deepEqual(await lookupDecisionMakerResult(prisma, { requestId, resultDigest: "e".repeat(64) }), { status: "not_recorded" });
  assert.deepEqual(
    await prisma.$transaction((tx) => recordDecisionMakerResultUnknown(tx, { requestId, instance: OPENAI, resultDigest: DIGEST_C })),
    { recorded: false, reason: "already_accepted" },
  );
  // The transmission receipt is still recorded once the process ends.
  assert.equal((await prisma.$transaction((tx) => recordDecisionMakerTransmitOutcome(tx, { requestId, instance: OPENAI, outcome: "receipt" }))).recorded, true);
  assert.deepEqual(
    (await rowsOf(requestId)).map((row) => row.kind),
    ["assign", "transmit_intent", "result_rejected", "result", "result_rejected", "transmit_receipt"],
  );
  const resultAudit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: accepted.status === "accepted" ? accepted.event.eventId : "", action: "amux.decision.result" },
  });
  assert.deepEqual(resultAudit.metadata, {
    event_id: accepted.status === "accepted" ? accepted.event.eventId : "",
    request_id: requestId,
    kind: "result",
    instance: OPENAI,
    result_kind: "proposal",
    systemActor: "amux-decision-maker-openai",
  });
});

test("an unknown result hands the request to the operator; no later result is accepted", async () => {
  const shared = binding({ askingProvider: "codex" });
  const { requestId } = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: shared, card: CARD }),
  );
  await prisma.$transaction((tx) => assignDecisionMakerRequest(tx, { requestId, requireLeaseAt: noLease }));
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: ANTHROPIC, transmission, requireLeaseAt: noLease }));
  assert.deepEqual(await lookupDecisionMakerResult(prisma, { requestId, resultDigest: DIGEST_C }), { status: "not_recorded" });
  const unknown = await prisma.$transaction((tx) =>
    recordDecisionMakerResultUnknown(tx, { requestId, instance: ANTHROPIC, resultDigest: DIGEST_C }),
  );
  assert.equal(unknown.recorded, true);
  const requestBinding = withoutProvider((await readDecisionMakerRequestState(prisma, requestId))!.binding);
  const late = await prisma.$transaction((tx) =>
    submitDecisionMakerResult(tx, {
      requestId,
      requireLeaseAt: noLease,
      submission: {
        instance: ANTHROPIC,
        resultKind: "proposal",
        resultDigest: DIGEST_C,
        binding: { ...requestBinding, policyVersion: 1, transmission },
      },
    }),
  );
  assert.ok(late.status === "rejected" && late.reason === "result_unknown");
  // The anthropic instance's own actor recorded both.
  const events = (await rowsOf(requestId)).filter((row) => row.kind === "result_unknown" || row.kind === "result_rejected");
  assert.deepEqual(events.map((row) => row.kind), ["result_unknown", "result_rejected"]);
  const audits = await prisma.adminAuditLog.findMany({ where: { targetId: { in: events.map((row) => row.id) } } });
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.equal((audit.metadata as { systemActor?: string }).systemActor, "amux-decision-maker-anthropic");
  }
});

test("a discarded assignment closes the request; a request routed to the operator is closed from its creation", async () => {
  const { requestId } = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: binding(), card: CARD }),
  );
  await prisma.$transaction((tx) => assignDecisionMakerRequest(tx, { requestId, requireLeaseAt: noLease }));
  assert.equal((await prisma.$transaction((tx) => discardDecisionMakerAssignment(tx, { requestId }))).recorded, true);
  const transmission = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };
  assert.deepEqual(
    await prisma.$transaction((tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission, requireLeaseAt: noLease })),
    { recorded: false, reason: "closed" },
  );
  assert.equal((await readDecisionMakerRequestState(prisma, requestId))!.closing, "assign_discarded");

  const operator = await prisma.$transaction((tx) =>
    recordDecisionMakerRequest(tx, { keyRing: RING, binding: binding(), card: { ...CARD, title: "Deploy the cache to production" } }),
  );
  assert.equal((await readDecisionMakerRequestState(prisma, operator.requestId))!.closing, "routed_to_operator");
  assert.deepEqual(
    await prisma.$transaction((tx) => assignDecisionMakerRequest(tx, { requestId: operator.requestId, requireLeaseAt: noLease })),
    { recorded: false, reason: "not_routed_to_dm" },
  );
  assert.deepEqual(
    await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: operator.requestId })),
    { recorded: false, reason: "closed" },
  );
});

test("an open request is closed as stale 30 days after creation, not before", async () => {
  const young = await backdatedRequest(29 * 24 * 60 * MINUTE);
  assert.deepEqual(await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: young })), {
    recorded: false,
    reason: "not_stale",
  });
  await rejectsWith(insertEvent(young, { kind: "stale_close" }), /AMUX_DM_REQUEST_EVENT_TRANSITION/);
  const old = await backdatedRequest(30 * 24 * 60 * MINUTE + 1_000);
  const closed = await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: old }));
  assert.equal(closed.recorded, true);
  assert.deepEqual(await prisma.$transaction((tx) => staleCloseDecisionMakerRequest(tx, { requestId: old })), {
    recorded: false,
    reason: "closed",
  });
  assert.ok(closed.recorded);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: closed.event.auditLogId } });
  assert.equal(audit.action, "amux.decision.stale_close");
  assert.equal((audit.metadata as { systemActor?: string }).systemActor, "amux-decision-router");
});

test("throughput counts requests routed to one instance for a proposal in the trailing hour and day", async () => {
  await insertRequest();
  await insertRequest();
  await backdatedRequest(2 * 60 * MINUTE);
  await backdatedRequest(25 * 60 * MINUTE);
  await insertRequest(requestRow({ route: "operator", refusalCodes: ["instance_off"] }));
  await insertRequest(requestRow({ askingProvider: "codex", instance: ANTHROPIC }));
  assert.deepEqual(await readDecisionMakerThroughput(prisma, OPENAI), { lastHour: 2, lastDay: 3 });
  assert.deepEqual(await readDecisionMakerThroughput(prisma, ANTHROPIC), { lastHour: 1, lastDay: 1 });
});

// ---------------------------------------------------------------------------
// The switches (§6's table, §8), one transaction at a time and racing
// ---------------------------------------------------------------------------

test("a transmission intent whose COMMIT reaches the database after the result deadline is refused at COMMIT", async () => {
  // The intent row is the authorization to send the card, which is never sent
  // again: an intent that commits late would send a card whose answer the
  // ledger can no longer accept.
  const requestId = await insertRequest();
  await backdatedAssignment(requestId, 1_500, false);
  await commitAfterDeadline(requestId, INTENT, await resultDeadlineMs(requestId));
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign"]);
  // The store hands the same deadline to the fence.
  const onTime = await insertRequest();
  await insertEvent(onTime, { kind: "assign" });
  const leases: Date[] = [];
  const recorded = await prisma.$transaction((tx) =>
    recordDecisionMakerTransmitIntent(tx, {
      requestId: onTime,
      instance: OPENAI,
      transmission: { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B },
      requireLeaseAt: (deadline) => leases.push(deadline),
    }),
  );
  assert.equal(recorded.recorded, true);
  assert.deepEqual(leases.map((lease) => lease.getTime()), [await resultDeadlineMs(onTime)]);
});

test("the database refuses a DM routing, an intent and a proposal under the kill switch, and a routing and an intent with the instance off", async () => {
  const assigned = await STATE_BUILDERS.assigned!();
  const transmitted = await STATE_BUILDERS.transmitted!();
  const stillTransmitted = await STATE_BUILDERS.transmitted!();

  await setSwitch("kill_switch", "on");
  await rejectsWith(insertRequest(), /AMUX_DM_REQUEST_SWITCH/);
  // The operator route is what the router records instead, and it is accepted.
  await insertRequest(requestRow({ route: "operator", refusalCodes: ["kill_switch_on"] }));
  await rejectsWith(insertEvent(assigned, INTENT), /AMUX_DM_REQUEST_EVENT_SWITCH/);
  await rejectsWith(insertEvent(transmitted, PROPOSAL), /AMUX_DM_REQUEST_EVENT_SWITCH/);
  // A rejection may cite the kill switch now, and a result that is not a proposal still stands.
  await insertEvent(transmitted, { kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_C, rejectionReason: "kill_switch" });
  await insertEvent(transmitted, { ...PROPOSAL, resultKind: "escalate", resultDigest: DIGEST_D });
  // The router, reading the switches itself, routes to the operator.
  const routed = await prisma.$transaction((tx) => recordDecisionMakerRequest(tx, { keyRing: RING, binding: binding(), card: CARD }));
  assert.deepEqual([routed.route, routed.refusalCodes], ["operator", ["kill_switch_on"]]);

  await setSwitch("kill_switch", "off");
  // A rejection cannot cite a kill switch that is off.
  await rejectsWith(
    insertEvent(stillTransmitted, { kind: "result_rejected", instance: OPENAI, resultDigest: DIGEST_A, rejectionReason: "kill_switch" }),
    /AMUX_DM_REQUEST_EVENT_TRANSITION/,
  );
  await setSwitch("decision-maker-openai", "off");
  await rejectsWith(insertRequest(), /AMUX_DM_REQUEST_SWITCH/);
  await rejectsWith(insertEvent(assigned, INTENT), /AMUX_DM_REQUEST_EVENT_SWITCH/);
  // An instance off stops routing and process start only (§8): a result already running stands.
  await insertEvent(stillTransmitted, PROPOSAL);
  // The other instance is not touched.
  await insertRequest(requestRow({ askingProvider: "codex", instance: ANTHROPIC }));
  assert.deepEqual((await rowsOf(assigned)).map((row) => row.kind), ["assign"]);
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Two transactions at once: `first` runs to the point where it holds its
 * locks and then waits; `second` starts and must not finish until `first`
 * commits. Returns the second's outcome (value or error) after both settle.
 * On PostgreSQL the two run on two pool connections; the local PGlite harness
 * has one backend, where the second simply waits for the first's connection.
 */
const race = async (
  first: (tx: Prisma.TransactionClient) => Promise<unknown>,
  second: () => Promise<unknown>,
) => {
  const holding = deferred();
  const reached = deferred();
  const firstDone = prisma.$transaction(
    async (tx) => {
      await first(tx);
      reached.resolve();
      await holding.promise;
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
  await reached.promise;
  let settled = false;
  const secondDone = second().then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null as unknown, error }),
  );
  void secondDone.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, "the second transaction finished while the first held its locks");
  holding.resolve();
  await firstDone;
  return secondDone;
};

const OPEN = { timeout: 20_000, maxWait: 15_000 };
const NONE = { snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null, inputPayloadDigest: DIGEST_B };

test("a kill switch committed while an intent waits on the lock is the one the intent reads", async () => {
  const requestId = await STATE_BUILDERS.assigned!();
  const outcome = await race(
    (tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope: "kill_switch", value: "on" }),
    () =>
      prisma.$transaction(
        (tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission: NONE, requireLeaseAt: noLease }),
        OPEN,
      ),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  assert.deepEqual(outcome.value, { recorded: false, reason: "kill_switch_on" });
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign"]);
});

test("an instance turned off while an intent waits is the one the intent reads", async () => {
  const requestId = await STATE_BUILDERS.assigned!();
  const outcome = await race(
    (tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope: "decision-maker-openai", value: "off" }),
    () =>
      prisma.$transaction(
        (tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission: NONE, requireLeaseAt: noLease }),
        OPEN,
      ),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  assert.deepEqual(outcome.value, { recorded: false, reason: "instance_off" });
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign"]);
});

test("a kill switch committed while a proposal waits turns the proposal into a recorded rejection", async () => {
  const requestId = await STATE_BUILDERS.transmitted!();
  const state = await readDecisionMakerRequestState(prisma, requestId);
  assert.ok(state);
  const requestBinding = withoutProvider(state.binding);
  const outcome = await race(
    (tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope: "kill_switch", value: "on" }),
    () =>
      prisma.$transaction(
        (tx) =>
          submitDecisionMakerResult(tx, {
            requestId,
            requireLeaseAt: noLease,
            submission: {
              instance: OPENAI,
              resultKind: "proposal",
              resultDigest: DIGEST_D,
              binding: { ...requestBinding, transmission: state.transmission },
            },
          }),
        OPEN,
      ),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  const value = outcome.value as { status: string; reason?: string };
  assert.deepEqual([value.status, value.reason], ["rejected", "kill_switch"]);
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign", "transmit_intent", "result_rejected"]);
});

test("a kill switch committed while a routing waits sends the question to the operator", async () => {
  const outcome = await race(
    (tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope: "kill_switch", value: "on" }),
    () => prisma.$transaction((tx) => recordDecisionMakerRequest(tx, { keyRing: RING, binding: binding(), card: CARD }), OPEN),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  const value = outcome.value as { route: string; refusalCodes: string[] };
  assert.deepEqual([value.route, value.refusalCodes], ["operator", ["kill_switch_on"]]);
});

const newestKillSwitchAtMs = async () =>
  Number(
    (
      await prisma.$queryRaw<Array<{ createdAtMs: bigint }>>`
        SELECT floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtMs"
        FROM "AmuxDecisionMakerSwitchEvent" WHERE "scope" = 'kill_switch' ORDER BY "sequence" DESC LIMIT 1
      `
    )[0]!.createdAtMs,
  );

const intentAtMs = async (requestId: string) =>
  Number(
    (
      await prisma.$queryRaw<Array<{ createdAtMs: bigint }>>`
        SELECT floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtMs"
        FROM "AmuxDecisionMakerRequestEvent" WHERE "requestId" = ${requestId} AND "kind" = 'transmit_intent'
      `
    )[0]!.createdAtMs,
  );

test("a switch change waits for an intent in flight, and commits after it", async () => {
  const requestId = await STATE_BUILDERS.assigned!();
  const outcome = await race(
    (tx) => recordDecisionMakerTransmitIntent(tx, { requestId, instance: OPENAI, transmission: NONE, requireLeaseAt: noLease }),
    () =>
      prisma.$transaction(
        (tx) => recordDecisionMakerSwitchByOperator(tx, { session: switchOperator(), scope: "kill_switch", value: "on" }),
        OPEN,
      ),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign", "transmit_intent"]);
  assert.ok((await newestKillSwitchAtMs()) >= (await intentAtMs(requestId)), "the switch change was written after the intent");
  assert.equal((await readDecisionMakerSwitches(prisma)).killSwitch, true);
});

/**
 * An audit row with no entry hash, written straight to the table. The chain
 * trigger takes the audit chain lock only for a hashed row
 * (20260918090000_admin_audit_log_append_only), so a writer that used this --
 * the application never does -- holds no chain lock, and only the switch
 * gate stands between its switch change and a ledger write.
 */
const unchainedAudit = async (
  tx: Prisma.TransactionClient,
  entry: { action: string; targetType: string; targetId: string; actorUserId?: string; systemActor?: string },
) => {
  const id = `unchained-${randomUUID()}`;
  const metadata = JSON.stringify(entry.systemActor ? { systemActor: entry.systemActor } : {});
  await tx.$executeRaw`
    INSERT INTO "AdminAuditLog" ("id", "actorUserId", "action", "targetType", "targetId", "summary", "metadata")
    VALUES (${id}, ${entry.actorUserId ?? null}, ${entry.action}, ${entry.targetType}, ${entry.targetId}, 'test', ${metadata}::jsonb)
  `;
  return id;
};

const unchainedKillSwitch = async (tx: Prisma.TransactionClient, value: "on" | "off") => {
  const id = randomUUID();
  const userId = `dm-operator-${randomUUID()}`;
  const auditLogId = await unchainedAudit(tx, {
    action: "amux.decision.mode",
    targetType: "AmuxDecisionMakerSwitchEvent",
    targetId: id,
    actorUserId: userId,
  });
  await tx.$executeRaw`
    INSERT INTO "AmuxDecisionMakerSwitchEvent" ("id", "scope", "value", "reasonCode", "actorKind", "actorUserId", "auditLogId")
    VALUES (${id}, 'kill_switch', ${value}, 'operator', 'human', ${userId}, ${auditLogId})
  `;
};

const unchainedIntent = async (tx: Prisma.TransactionClient, requestId: string) => {
  const id = randomUUID();
  const auditLogId = await unchainedAudit(tx, {
    action: "amux.decision.transmit_intent",
    targetType: EVENT,
    targetId: id,
    systemActor: "amux-decision-maker-openai",
  });
  await insertEventRow(tx, id, requestId, INTENT, auditLogId);
};

test("without the audit chain lock, the switch gate alone keeps an intent from a stale switch read", async () => {
  const requestId = await STATE_BUILDERS.assigned!();
  const outcome = await race(
    (tx) => unchainedKillSwitch(tx, "on"),
    () => prisma.$transaction((tx) => unchainedIntent(tx, requestId), OPEN),
  );
  assert.ok(outcome.error, "the intent was accepted against a kill switch committed while it waited");
  const record = outcome.error as { meta?: unknown; cause?: unknown };
  assert.match(
    [String(outcome.error), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" "),
    /AMUX_DM_REQUEST_EVENT_SWITCH/,
  );
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign"]);
});

test("without the audit chain lock, a switch change still waits for an intent in flight", async () => {
  const requestId = await STATE_BUILDERS.assigned!();
  const outcome = await race(
    (tx) => unchainedIntent(tx, requestId),
    () => prisma.$transaction((tx) => unchainedKillSwitch(tx, "on"), OPEN),
  );
  assert.equal(outcome.error, null, String(outcome.error));
  assert.deepEqual((await rowsOf(requestId)).map((row) => row.kind), ["assign", "transmit_intent"]);
  assert.ok((await newestKillSwitchAtMs()) >= (await intentAtMs(requestId)), "the switch change was written after the intent");
  assert.equal((await readDecisionMakerSwitches(prisma)).killSwitch, true);
});
