import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { dmBodyRefusal, dmDigestKeyCheck, dmKeyPeriodOf, type DmBodyRefusal } from "@/lib/amux/decisionMakerBodyCore";
import {
  readDecisionMakerProposalForJudgment,
  storeDecisionMakerOperatorAnswer,
} from "@/lib/amux/decisionMakerBodyStore";
import { decisionMakerPeriodKey, type DmDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import {
  DM_JUDGMENT_AUDIT_TARGET_TYPE,
  DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE,
  DM_DELIVERY_AUDIT_ACTIONS,
  dmDeclarationAccuracyReport,
  dmDeliveryAuditMetadata,
  dmDeliveryRefusal,
  dmDeliveryStateFromRow,
  dmDeliverySwitchRefusal,
  dmJudgmentAuditAction,
  dmJudgmentAuditMetadata,
  dmJudgmentProposalRefusal,
  dmJudgmentStateRefusal,
  dmJudgmentSwitchRefusal,
  dmJudgmentTalliesFromRows,
  isDmJudgmentKind,
  parseDmDeclarationAccuracy,
  parseDmJudgmentInput,
  type DmDeclarationAccuracy,
  type DmDeclarationAccuracyReport,
  type DmDeliveryAttempt,
  type DmDeliveryRefusal,
  type DmDeliveryResolveOutcome,
  type DmDeliveryState,
  type DmDeliverySystemEventKind,
  type DmJudgmentKind,
  type DmJudgmentRefusal,
} from "@/lib/amux/decisionMakerJudgmentCore";
import { writeDecisionMakerDeliveryAudit } from "@/lib/amux/decisionMakerJudgmentSystemAudit";
import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import {
  readDecisionMakerProposalTimeline,
  readDecisionMakerRequestState,
} from "@/lib/amux/decisionMakerRequestStore";
import { isDmInstanceScope, type DmInstanceScope } from "@/lib/amux/decisionMakerSwitchCore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";

/**
 * The one module that reads and writes `AmuxDecisionMakerJudgment` and
 * `AmuxDecisionMakerDeliveryEvent` (docs/policy/amux-decision-maker.md §10:
 * "단일 writer 모듈이 위 표들에 쓴다"), stage S1e: a person's judgment of a
 * proposal with its declaration accuracy (§2-6, §4), the delivery decision
 * of a confirmed answer, its receipt or unknown outcome, and a person's
 * resolution of an unknown outcome (§2-7, §9), and §4's report. Nothing else
 * in the application names the two tables; tests/amuxDecisionMakerJudgment.test.mjs
 * and `npm run check:protected-table-writers` fail on another writer.
 *
 * A judgment closes its request: the judgment table's trigger writes the
 * request's closing event (confirm, edit_confirm or reject) in the judgment's
 * own statement, and the S1d closing trigger then starts its retention. It
 * reads the ledger only through lib/amux/decisionMakerRequestStore.ts and the
 * bodies only through lib/amux/decisionMakerBodyStore.ts, which stores an
 * edited answer.
 *
 * Every function runs on a transaction its caller owns and holds no lock
 * beyond it. Each sends a fixed list of statements -- no loop -- pinned by
 * tests/amuxDecisionMakerJudgment.test.mjs within §9's budget of 12 with the
 * boundary's setup and fence. A write takes the audit chain lock first, reads,
 * decides with the pure core (lib/amux/decisionMakerJudgmentCore.ts), and then
 * writes its audit and the row naming it. A refusal the core sees writes
 * nothing.
 *
 * The switches are never the caller's to pass in (§6's table). A confirmation
 * and a delivery decision read them here, with the switch store's own reader,
 * after the audit chain lock that every switch change also takes; the guards
 * read them again under the Decision Maker switch gate. A rejection, a
 * delivery's receipt or unknown outcome, and a person's resolution read no
 * switch: §6's table allows a rejection and a person's operations under the
 * kill switch, and an outcome records what already happened.
 *
 * Permission is the caller's: a judgment and a resolution are a person's,
 * with `ops:write` and a recent step-up checked before this is called (§2-6,
 * §8). The delivery decision and its outcome are the system's (the bridge,
 * stage S2). No answer, digest or free text reaches an audit entry.
 */

type JudgmentReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export class DecisionMakerJudgmentWriteError extends Error {
  readonly code: "invalid_input" | "no_operator" | "state_unreadable" | "settings_unreadable";

  constructor(code: DecisionMakerJudgmentWriteError["code"]) {
    super(code);
    this.name = "DecisionMakerJudgmentWriteError";
    this.code = code;
  }
}

const safeInteger = (value: unknown, label: string): number => {
  const number = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new Error(`AMUX Decision Maker judgment store ${label} is not a safe integer`);
  return number;
};

const isoOf = (epochMs: number) => new Date(epochMs).toISOString();

const requireRequestId = (value: unknown): string => {
  if (!isDmRequestId(value)) throw new DecisionMakerJudgmentWriteError("invalid_input");
  return value;
};

const requireOperator = (session: Session): string => {
  const id = session?.user?.id;
  if (typeof id !== "string" || id.length === 0) throw new DecisionMakerJudgmentWriteError("no_operator");
  return id;
};

/**
 * The switches for a write that follows in the same transaction (§6), as the
 * request store reads them: a read that fails has aborted the transaction, so
 * it is reported as `settings_unreadable` before anything is written.
 */
const readSwitchesForWrite = async (tx: Prisma.TransactionClient) => {
  try {
    return await readDecisionMakerSwitchesOrThrow(tx);
  } catch {
    throw new DecisionMakerJudgmentWriteError("settings_unreadable");
  }
};

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

export type DecisionMakerJudgmentRecord = {
  judgmentId: string;
  requestId: string;
  kind: DmJudgmentKind;
  instance: DmInstanceScope;
  auditLogId: string;
  accuracy: DmDeclarationAccuracy;
  /** The keyed digest of the person's edited answer; null unless edit_confirm. */
  operatorAnswerDigest: string | null;
  createdAt: string;
};

export type DecisionMakerJudgmentWrite =
  | { recorded: true; judgment: DecisionMakerJudgmentRecord }
  | { recorded: false; reason: DmJudgmentRefusal | "unknown_request" }
  | { recorded: false; reason: "operator_answer_refused"; bodyRefusal: DmBodyRefusal };

const JUDGMENT_SUMMARIES: Readonly<Record<DmJudgmentKind, string>> = {
  confirm: "Confirmed an AMUX Decision Maker proposal.",
  edit_confirm: "Confirmed an AMUX Decision Maker proposal with an edited answer.",
  reject: "Rejected an AMUX Decision Maker proposal.",
};

/**
 * A person judges a request's proposal (§2-6, §6), once: confirms it as it
 * is, confirms it with an edited answer, or rejects it, with §4's declaration
 * accuracy (default `not_judged`; `mismatched` names the wrong items). In the
 * caller's transaction, in this order: the audit chain lock; the request's
 * state through the ledger's reader -- open, routed to a DM, its terminal
 * result a proposal; for a confirmation the switch store, whose kill switch
 * must be off (§6's table; a rejection stays allowed under it); the proposal
 * through the body store's reader -- the detail of that very result, and for
 * a confirmation every value Admin showed (`shown`) equal to the stored one;
 * then the person's `amux.decision.<kind>` audit naming the request; for an
 * edited confirmation the person's answer, stored through the body store under
 * that audit and digested with the request's key; and the judgment naming the
 * audit, whose trigger writes the request's closing event in the same
 * statement. The database refuses each of those conditions again.
 *
 * The edited answer passes the body store's checks, the secret scan included,
 * before anything is sent, and the request's key period must be in `keyRing`
 * and registered under the same key, undestroyed; otherwise nothing is
 * written.
 *
 * Statements: 1 lock, 1 state read -- 2 for an unknown, closed or
 * proposal-less request; for a confirmation 1 switch read -- 3 under the kill
 * switch; 1 proposal read -- 3 (4 for a confirmation) for a refusal it
 * reveals; the administrator writer's 3 (4 with an integrity key); for an
 * edited confirmation 1 answer insert; 1 judgment insert. A rejection 7 (8), a
 * confirmation 8 (9), an edited confirmation 9 (10).
 */
export async function recordDecisionMakerJudgment(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request?: Request;
    requestId: unknown;
    kind: unknown;
    shown?: unknown;
    accuracy?: unknown;
    operatorAnswer?: unknown;
    keyRing?: DmDigestKeyRing;
  },
): Promise<DecisionMakerJudgmentWrite> {
  const requestId = requireRequestId(input.requestId);
  const judgment = parseDmJudgmentInput({
    kind: input.kind,
    shown: input.shown,
    accuracy: input.accuracy,
    operatorAnswer: input.operatorAnswer,
  });
  if (!judgment) throw new DecisionMakerJudgmentWriteError("invalid_input");
  if (judgment.kind === "edit_confirm" && !(input.keyRing instanceof Map)) {
    throw new DecisionMakerJudgmentWriteError("invalid_input");
  }
  const actorUserId = requireOperator(input.session);
  // §10: "저장 전에 secret 검사를 통과해야 한다" -- before anything is sent.
  if (judgment.kind === "edit_confirm") {
    const bodyRefusal = dmBodyRefusal("operator_answer", judgment.operatorAnswer);
    if (bodyRefusal) return { recorded: false, reason: "operator_answer_refused", bodyRefusal };
  }

  await takeAuditChainLock(tx);
  const state = await readDecisionMakerRequestState(tx, requestId);
  if (!state) return { recorded: false, reason: "unknown_request" };
  const stateRefusal = dmJudgmentStateRefusal(state);
  if (stateRefusal) return { recorded: false, reason: stateRefusal };
  if (state.instance === null || state.terminal === null) throw new DecisionMakerJudgmentWriteError("state_unreadable");
  const instance = state.instance;
  const resultEventId = state.terminal.eventId;

  if (judgment.kind !== "reject") {
    const switchRefusal = dmJudgmentSwitchRefusal(judgment.kind, (await readSwitchesForWrite(tx)).killSwitch);
    if (switchRefusal) return { recorded: false, reason: switchRefusal };
  }

  const keyPeriod = dmKeyPeriodOf(state.createdAtMs);
  let keyCheck: string | null = null;
  if (judgment.kind === "edit_confirm") {
    const periodKey = decisionMakerPeriodKey(input.keyRing as DmDigestKeyRing, keyPeriod);
    if (!periodKey) return { recorded: false, reason: "digest_key_unavailable" };
    keyCheck = dmDigestKeyCheck(periodKey);
  }
  const proposal = await readDecisionMakerProposalForJudgment(tx, { requestId, keyPeriod });
  const proposalRefusal = dmJudgmentProposalRefusal({ state, proposal, judgment, keyCheck });
  if (proposalRefusal) return { recorded: false, reason: proposalRefusal };

  const judgmentId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: dmJudgmentAuditAction(judgment.kind),
    targetType: DM_JUDGMENT_AUDIT_TARGET_TYPE,
    targetId: requestId,
    summary: JUDGMENT_SUMMARIES[judgment.kind],
    metadata: dmJudgmentAuditMetadata({
      requestId,
      judgmentId,
      kind: judgment.kind,
      instance,
      accuracy: judgment.accuracy,
    }),
    tx,
  });

  let operatorAnswerDigest: string | null = null;
  if (judgment.kind === "edit_confirm") {
    const stored = await storeDecisionMakerOperatorAnswer(tx, {
      requestId,
      requestCreatedAtMs: state.createdAtMs,
      text: judgment.operatorAnswer,
      auditLogId,
      keyRing: input.keyRing as DmDigestKeyRing,
    });
    operatorAnswerDigest = stored.digest;
  }

  const shown = judgment.kind === "reject" ? null : judgment.shown;
  const inserted = await tx.$queryRaw<Array<{ createdAtEpochMs: bigint | number }>>`
    INSERT INTO "AmuxDecisionMakerJudgment"
      ("id", "requestId", "resultEventId", "instance", "kind", "actorUserId",
       "shownAnswerDigest", "shownRationaleDigest", "shownOptionId", "shownIrreversible",
       "shownSnapshotState", "shownSnapshotTargetSha", "shownSnapshotManifestDigest",
       "operatorAnswerDigest", "declarationAccuracy", "mismatchedItems", "auditLogId")
    VALUES
      (${judgmentId}, ${requestId}, ${resultEventId}, ${instance}, ${judgment.kind}, ${actorUserId},
       ${shown?.answerDigest ?? null}::text, ${shown?.rationaleDigest ?? null}::text, ${shown?.optionId ?? null}::text,
       ${shown?.irreversible ?? null}::boolean, ${shown?.snapshotState ?? null}::text,
       ${shown?.snapshotTargetSha ?? null}::text, ${shown?.snapshotManifestDigest ?? null}::text,
       ${operatorAnswerDigest}::text, ${judgment.accuracy.accuracy}, ${judgment.accuracy.mismatchedItems}::text[],
       ${auditLogId})
    RETURNING floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX Decision Maker judgment insert returned no row");
  return {
    recorded: true,
    judgment: {
      judgmentId,
      requestId,
      kind: judgment.kind,
      instance,
      auditLogId,
      accuracy: judgment.accuracy,
      operatorAnswerDigest,
      createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
    },
  };
}

/**
 * A request's judgment, in one statement; null when it has none. What
 * the delivery path and Admin read back. Reads only.
 */
export async function readDecisionMakerJudgment(
  client: JudgmentReader,
  requestId: string,
): Promise<DecisionMakerJudgmentRecord | null> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerJudgmentWriteError("invalid_input");
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      kind: string;
      instance: string;
      auditLogId: string;
      declarationAccuracy: string;
      mismatchedItems: unknown;
      operatorAnswerDigest: string | null;
      createdAtEpochMs: bigint | number;
    }>
  >`
    SELECT "id", "kind", "instance", "auditLogId", "declarationAccuracy", "mismatchedItems", "operatorAnswerDigest",
           floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
    FROM "AmuxDecisionMakerJudgment"
    WHERE "requestId" = ${requestId}
  `;
  const row = rows[0];
  if (!row) return null;
  const accuracy = parseDmDeclarationAccuracy({
    accuracy: row.declarationAccuracy,
    mismatchedItems: row.mismatchedItems,
  });
  if (
    !isDmJudgmentKind(row.kind) ||
    !isDmInstanceScope(row.instance) ||
    !isDmRequestId(row.id) ||
    accuracy === null ||
    (row.operatorAnswerDigest !== null && !/^[0-9a-f]{64}$/.test(row.operatorAnswerDigest)) ||
    (row.kind === "edit_confirm") !== (row.operatorAnswerDigest !== null)
  ) {
    throw new DecisionMakerJudgmentWriteError("state_unreadable");
  }
  return {
    judgmentId: row.id,
    requestId,
    kind: row.kind,
    instance: row.instance,
    auditLogId: row.auditLogId,
    accuracy,
    operatorAnswerDigest: row.operatorAnswerDigest,
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * One request's delivery records in one statement: its judgment's kind and
 * what its delivery events add up to. After a write whose response was lost,
 * this is how the caller learns what was recorded (§9: never blind again).
 */
export async function readDecisionMakerDeliveryState(
  client: JudgmentReader,
  requestId: string,
): Promise<DmDeliveryState> {
  if (!isDmRequestId(requestId)) throw new DecisionMakerJudgmentWriteError("invalid_input");
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      (SELECT j."kind" FROM "AmuxDecisionMakerJudgment" j WHERE j."requestId" = ${requestId}) AS "judgmentKind",
      coalesce(bool_or(d."kind" = 'deliver'), false) AS "delivered",
      max(d."kind") FILTER (WHERE d."kind" IN ('delivery_receipt', 'delivery_unknown')) AS "outcomeKind",
      max(d."outcome") FILTER (WHERE d."kind" = 'delivery_unknown_resolve') AS "resolution"
    FROM "AmuxDecisionMakerDeliveryEvent" d
    WHERE d."requestId" = ${requestId}
  `;
  const state = dmDeliveryStateFromRow(requestId, rows[0]);
  if (!state) throw new DecisionMakerJudgmentWriteError("state_unreadable");
  return state;
}

export type DecisionMakerDeliveryEventRecord = {
  eventId: string;
  auditLogId: string;
  /** The database's sequence, as a decimal string (it is a BIGINT). */
  sequence: string;
  createdAt: string;
};

export type DecisionMakerDeliveryWrite =
  | { recorded: true; event: DecisionMakerDeliveryEventRecord; judgmentKind: DmJudgmentKind }
  | { recorded: false; reason: DmDeliveryRefusal | "kill_switch_on" | "settings_unreadable" };

type InsertedDeliveryRow = { sequence: bigint | number | string; createdAtEpochMs: bigint | number };

const deliveryRecord = (
  eventId: string,
  auditLogId: string,
  rows: InsertedDeliveryRow[],
): DecisionMakerDeliveryEventRecord => {
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker delivery event insert returned no row");
  return {
    eventId,
    auditLogId,
    sequence: String(row.sequence),
    createdAt: isoOf(safeInteger(row.createdAtEpochMs, "clock")),
  };
};

/** The system's delivery event: its audit by the router, then the event naming it. 4 statements, or 5. */
const appendSystemDeliveryEvent = async (
  tx: Prisma.TransactionClient,
  requestId: string,
  kind: DmDeliverySystemEventKind,
  judgmentKind: DmJudgmentKind,
): Promise<DecisionMakerDeliveryEventRecord> => {
  const eventId = randomUUID();
  const auditLogId = await writeDecisionMakerDeliveryAudit(tx, {
    kind,
    eventId,
    metadata: dmDeliveryAuditMetadata({ eventId, requestId, kind, judgmentKind, outcome: null }),
  });
  const inserted = await tx.$queryRaw<InsertedDeliveryRow[]>`
    INSERT INTO "AmuxDecisionMakerDeliveryEvent"
      ("id", "requestId", "kind", "outcome", "actorKind", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${requestId}, ${kind}, NULL, 'system', NULL, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return deliveryRecord(eventId, auditLogId, inserted);
};

/**
 * §2-7, §9: the confirmed answer of a request is released for delivery, once
 * (§9: "요청마다 종결 결과 행과 전달 결정 행은 각각 하나뿐이다"), only after a
 * confirmation or an edited confirmation, and never while the kill switch is
 * on (§6's table: "bridge의 확정 답 조회·전달 — 거부"). The result names the
 * judgment's kind: `confirm` delivers the DM's proposal as it is, and
 * `edit_confirm` the person's edited answer. A second decision is refused,
 * whatever came of the first; an unclear delivery is recorded as unknown and
 * never sent again.
 *
 * Statements: 1 lock, 1 delivery read -- 2 for a refusal; 1 switch read -- 3
 * under the kill switch; the system writer's 3 (4 with an integrity key) and 1
 * insert -- 7, or 8.
 */
export async function recordDecisionMakerDelivery(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown },
): Promise<DecisionMakerDeliveryWrite> {
  const requestId = requireRequestId(input.requestId);
  const attempt: DmDeliveryAttempt = { kind: "deliver" };
  await takeAuditChainLock(tx);
  const state = await readDecisionMakerDeliveryState(tx, requestId);
  const refusal = dmDeliveryRefusal(state, attempt);
  if (refusal) return { recorded: false, reason: refusal };
  const switchRefusal = dmDeliverySwitchRefusal(attempt, (await readSwitchesForWrite(tx)).killSwitch);
  if (switchRefusal) return { recorded: false, reason: switchRefusal };
  const judgmentKind = state.judgmentKind as DmJudgmentKind;
  return {
    recorded: true,
    event: await appendSystemDeliveryEvent(tx, requestId, "deliver", judgmentKind),
    judgmentKind,
  };
}

/**
 * §2-7, §9: after the decision, the delivery's receipt, or -- when the
 * delivery's result is unclear -- `unknown`, one of the two once. Recorded
 * under the kill switch as well: each records what already happened. An
 * unknown delivery is never retried; a person resolves it.
 *
 * Statements: 1 lock, 1 delivery read -- 2 for a refusal; the system writer's
 * 3 (4 with an integrity key) and 1 insert -- 6, or 7.
 */
export async function recordDecisionMakerDeliveryOutcome(
  tx: Prisma.TransactionClient,
  input: { requestId: unknown; outcome: unknown },
): Promise<DecisionMakerDeliveryWrite> {
  const requestId = requireRequestId(input.requestId);
  if (input.outcome !== "receipt" && input.outcome !== "unknown") {
    throw new DecisionMakerJudgmentWriteError("invalid_input");
  }
  const kind = input.outcome === "receipt" ? "delivery_receipt" : "delivery_unknown";
  await takeAuditChainLock(tx);
  const state = await readDecisionMakerDeliveryState(tx, requestId);
  const refusal = dmDeliveryRefusal(state, { kind });
  if (refusal) return { recorded: false, reason: refusal };
  const judgmentKind = state.judgmentKind as DmJudgmentKind;
  return { recorded: true, event: await appendSystemDeliveryEvent(tx, requestId, kind, judgmentKind), judgmentKind };
}

export type DecisionMakerDeliveryResolution =
  | { recorded: true; event: DecisionMakerDeliveryEventRecord; outcome: DmDeliveryResolveOutcome }
  | { recorded: false; reason: DmDeliveryRefusal };

/**
 * §9: "확정되지 않으면 운영자에게 '전달 여부 미확인'을 보인다. 운영자가 확인하고
 * 재개하기 전에는 다른 답을 보내지 않는다". A person records what they found --
 * `delivered` or `not_delivered` -- once, only after an unknown outcome, under
 * the person's `amux.decision.delivery_unknown_resolve` audit. Allowed under
 * the kill switch (§6's table: a person's operations). It releases nothing:
 * the request's one delivery decision is spent, and an answer that was not
 * delivered is the operator's to give directly.
 *
 * Statements: 1 lock, 1 delivery read -- 2 for a refusal; the administrator
 * writer's 3 (4 with an integrity key) and 1 insert -- 6, or 7.
 */
export async function resolveDecisionMakerDeliveryUnknown(
  tx: Prisma.TransactionClient,
  input: { session: Session; request?: Request; requestId: unknown; outcome: unknown },
): Promise<DecisionMakerDeliveryResolution> {
  const requestId = requireRequestId(input.requestId);
  if (input.outcome !== "delivered" && input.outcome !== "not_delivered") {
    throw new DecisionMakerJudgmentWriteError("invalid_input");
  }
  const outcome: DmDeliveryResolveOutcome = input.outcome;
  const actorUserId = requireOperator(input.session);
  await takeAuditChainLock(tx);
  const state = await readDecisionMakerDeliveryState(tx, requestId);
  const refusal = dmDeliveryRefusal(state, { kind: "delivery_unknown_resolve", outcome });
  if (refusal) return { recorded: false, reason: refusal };
  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: DM_DELIVERY_AUDIT_ACTIONS.delivery_unknown_resolve,
    targetType: DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary:
      outcome === "delivered"
        ? "Resolved an unknown AMUX Decision Maker delivery as delivered."
        : "Resolved an unknown AMUX Decision Maker delivery as not delivered.",
    metadata: dmDeliveryAuditMetadata({
      eventId,
      requestId,
      kind: "delivery_unknown_resolve",
      judgmentKind: state.judgmentKind,
      outcome,
    }),
    tx,
  });
  const inserted = await tx.$queryRaw<InsertedDeliveryRow[]>`
    INSERT INTO "AmuxDecisionMakerDeliveryEvent"
      ("id", "requestId", "kind", "outcome", "actorKind", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${requestId}, 'delivery_unknown_resolve', ${outcome}, 'human', ${actorUserId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return { recorded: true, event: deliveryRecord(eventId, auditLogId, inserted), outcome };
}

// ---------------------------------------------------------------------------
// §4's declaration accuracy report
// ---------------------------------------------------------------------------

/**
 * §4's report, per DM instance, in two statements: this table's judgments
 * counted by kind and by declaration accuracy, then -- through the ledger's
 * reader -- each instance's proposals and the database clock of its first,
 * with the database clock. Judgments are read first: a judgment needs its
 * proposal, so a proposal and judgment committed between the two reads can
 * only add to the denominator, never leave a judgment without its proposal.
 *
 * It reads and returns numbers. It changes no switch or mode, records no
 * graduation and permits nothing (§4: "보고는 스위치·모드를 바꾸지 않고, 졸업을
 * 기록하지 않으며, 자율을 허락하지 않는다").
 */
export async function readDecisionMakerDeclarationAccuracyReport(
  client: JudgmentReader,
): Promise<DmDeclarationAccuracyReport> {
  const rows = await client.$queryRaw<unknown[]>`
    SELECT
      "instance",
      count(*) FILTER (WHERE "kind" = 'confirm') AS "confirm",
      count(*) FILTER (WHERE "kind" = 'edit_confirm') AS "editConfirm",
      count(*) FILTER (WHERE "kind" = 'reject') AS "reject",
      count(*) FILTER (WHERE "declarationAccuracy" = 'matched') AS "matched",
      count(*) FILTER (WHERE "declarationAccuracy" = 'mismatched') AS "mismatched",
      count(*) FILTER (WHERE "declarationAccuracy" = 'not_judged') AS "notJudged"
    FROM "AmuxDecisionMakerJudgment"
    GROUP BY "instance"
    ORDER BY "instance"
  `;
  const tallies = dmJudgmentTalliesFromRows(rows);
  if (!tallies) throw new DecisionMakerJudgmentWriteError("state_unreadable");
  const timeline = await readDecisionMakerProposalTimeline(client);
  return dmDeclarationAccuracyReport({ dbNowMs: timeline.dbNowMs, tallies, timeline: timeline.instances });
}
