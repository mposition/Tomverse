import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  DM_SWITCH_AUDIT_TARGET_TYPE,
  decisionMakerSwitchReadFromRows,
  decisionMakerSwitchStateFromRows,
  dmOperatorSwitchAction,
  dmSwitchAuditMetadata,
  parseDmOperatorSwitchChange,
  parseDmSwitchLatch,
  unreadableDecisionMakerSwitches,
  type DecisionMakerSwitchRead,
  type DecisionMakerSwitchState,
  type DmSwitchActorKind,
} from "@/lib/amux/decisionMakerSwitchCore";
import { writeDecisionMakerLatchAudit } from "@/lib/amux/decisionMakerSwitchSystemAudit";

/**
 * The one module that reads and writes `AmuxDecisionMakerSwitchEvent`
 * (docs/policy/amux-decision-maker.md §8, §10). Nothing else in the
 * application names the table; tests/amuxDecisionMakerSwitch.test.mjs and
 * `npm run check:protected-table-writers` fail on another writer.
 *
 * Every function runs on a client or a transaction its caller owns, and holds
 * no lock beyond that transaction. The statements each one sends are fixed --
 * no loop -- and pinned by tests/amuxDecisionMakerSwitch.test.mjs, because the
 * route transactions that will call them have a statement budget (§9).
 *
 * The rules a stored event must satisfy are the database's (migration
 * 20261008030000_amux_decision_maker_switch): this module only builds events
 * that pass them. Permission is the caller's: a person's change needs
 * `ops:write` and a recent step-up (§8), checked before this is called.
 *
 * No card text, prompt, proposal or free text is written to the table or to
 * its audit entries.
 */

type SwitchReader = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The switch state from the newest event of each scope, in one statement, for
 * a writer that goes on to write in the same transaction. A row the mapping
 * does not accept is the unreadable state (every field null), as below. A
 * statement that fails is not caught: in PostgreSQL it has aborted the
 * transaction, so no later statement of the caller could run, and the caller
 * must learn that the read failed rather than receive a state it would go on
 * to act on (the S1c review minor, 2026-10-08).
 */
export async function readDecisionMakerSwitchesOrThrow(
  client: SwitchReader,
): Promise<DecisionMakerSwitchState> {
  const rows = await client.$queryRaw<Array<{ scope: string; value: string }>>`
    SELECT DISTINCT ON ("scope") "scope", "value"
    FROM "AmuxDecisionMakerSwitchEvent"
    ORDER BY "scope", "sequence" DESC
  `;
  return decisionMakerSwitchStateFromRows(rows);
}

/**
 * The switch state from the newest event of each scope, in one statement.
 * Any error, and any row the mapping does not accept, is the unreadable state
 * (every field null), which `routeDmQuestion()` turns into
 * `settings_unreadable` and the operator. Inside a transaction an error has
 * also aborted that transaction, so the caller cannot go on to write anything;
 * a writer uses `readDecisionMakerSwitchesOrThrow()` instead.
 */
export async function readDecisionMakerSwitches(
  client: SwitchReader,
): Promise<DecisionMakerSwitchState> {
  try {
    return await readDecisionMakerSwitchesOrThrow(client);
  } catch {
    return unreadableDecisionMakerSwitches();
  }
}

/**
 * The switch state and each instance's §8 validation count boundary, in one
 * statement: what the request ledger's writers read
 * (lib/amux/decisionMakerRequestStore.ts) -- the state for §6's table, and
 * where §8's count starts, so a routing or a transmission intent can refuse an
 * instance whose latch is owed without a statement more
 * (docs/policy/amux-decision-maker.md §8, §9). The caller holds the audit
 * chain lock, which every switch change takes before it writes, so what is
 * read here is still the newest when it commits. A row the mapping does not
 * accept is the unreadable read; a statement that fails is not caught, as
 * above.
 *
 * Since stage S2-2a3 each row also carries the ledger event id its scope's
 * newest `cleanup_latch` names: a cleanup latch settles the `cleanup_unknown`
 * report it names and no other (§5) -- not a person's ordinary mode change
 * (review r-20261017-115136-888d76), and not a report that shares its
 * database millisecond (review r-20261017-123200-7609b7).
 *
 * Since stage S2-2a4 the boundary is the scope's newest `validation_latch`
 * and the first person's event after it -- which the switch guard requires to
 * be `amux.decision.latch_release` -- with the ledger sequence that release
 * was written after and its database clock (`DmValidationCountBoundary`), in
 * place of the scope's newest event of any kind: a person's ordinary mode
 * change, a cleanup latch and its release are not where §8's count starts.
 * Subqueries on the scope's index, for each newest row; they ride in this
 * statement because a routing already sends §9's 12 with setup and fence.
 */
export async function readDecisionMakerSwitchesWithBoundariesOrThrow(
  client: SwitchReader,
): Promise<DecisionMakerSwitchRead> {
  const rows = await client.$queryRaw<
    Array<{
      scope: string;
      value: string;
      newestCleanupLatchEventId: string | null;
      newestValidationLatchSequence: bigint | null;
      validationReleaseLedgerSequence: bigint | null;
      validationReleasedAtEpochMs: bigint | null;
    }>
  >`
    SELECT
      n."scope", n."value",
      (
        SELECT c."cleanupEventId"
        FROM "AmuxDecisionMakerSwitchEvent" c
        WHERE c."scope" = n."scope" AND c."reasonCode" = 'cleanup_latch'
        ORDER BY c."sequence" DESC
        LIMIT 1
      ) AS "newestCleanupLatchEventId",
      v."sequence" AS "newestValidationLatchSequence",
      r."ledgerSequence" AS "validationReleaseLedgerSequence",
      r."releasedAtEpochMs" AS "validationReleasedAtEpochMs"
    FROM (
      SELECT DISTINCT ON ("scope") "scope", "value"
      FROM "AmuxDecisionMakerSwitchEvent"
      ORDER BY "scope", "sequence" DESC
    ) n
    LEFT JOIN LATERAL (
      SELECT l."sequence"
      FROM "AmuxDecisionMakerSwitchEvent" l
      WHERE l."scope" = n."scope" AND l."reasonCode" = 'validation_latch'
      ORDER BY l."sequence" DESC
      LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT h."ledgerSequence", floor(extract(epoch FROM h."createdAt") * 1000)::bigint AS "releasedAtEpochMs"
      FROM "AmuxDecisionMakerSwitchEvent" h
      WHERE h."scope" = n."scope" AND h."actorKind" = 'human' AND h."sequence" > v."sequence"
      ORDER BY h."sequence" ASC
      LIMIT 1
    ) r ON true
  `;
  return decisionMakerSwitchReadFromRows(rows);
}

export class DecisionMakerSwitchWriteError extends Error {
  readonly code: "invalid_change" | "invalid_latch" | "no_operator";

  constructor(code: DecisionMakerSwitchWriteError["code"]) {
    super(code);
    this.name = "DecisionMakerSwitchWriteError";
    this.code = code;
  }
}

export type DecisionMakerSwitchEventRecord = {
  eventId: string;
  auditLogId: string;
  /** The database's sequence, as a decimal string (it is a BIGINT). */
  sequence: string;
  createdAt: string;
};

type InsertedRow = { sequence: bigint | number | string; createdAtEpochMs: bigint | number };

const eventRecord = (
  eventId: string,
  auditLogId: string,
  rows: InsertedRow[],
): DecisionMakerSwitchEventRecord => {
  const row = rows[0];
  if (!row) throw new Error("AMUX Decision Maker switch insert returned no row");
  const createdAtMs = Number(row.createdAtEpochMs);
  if (!Number.isSafeInteger(createdAtMs)) {
    throw new Error("AMUX Decision Maker switch clock is not a safe integer");
  }
  return {
    eventId,
    auditLogId,
    sequence: String(row.sequence),
    createdAt: new Date(createdAtMs).toISOString(),
  };
};

/**
 * A person sets the kill switch or an instance (§8). In the caller's
 * transaction, in this order: the audit chain lock (so no other switch event
 * or audit entry commits between the read and the insert), the scope's newest
 * event, the human audit under `amux.decision.mode` -- or
 * `amux.decision.latch_release` when that newest event is a system latch --
 * and then the event naming that audit row. Recording the value a scope
 * already has is allowed: after a latch it is how the operator releases it
 * while keeping the instance `off`.
 *
 * Statements: 1 lock, 1 read, the administrator writer's 3 (4 with an
 * integrity key), 1 insert -- 6, or 7.
 */
export async function recordDecisionMakerSwitchByOperator(
  tx: Prisma.TransactionClient,
  input: { session: Session; request?: Request; scope: unknown; value: unknown },
): Promise<DecisionMakerSwitchEventRecord & { action: string }> {
  const change = parseDmOperatorSwitchChange(input.scope, input.value);
  if (!change) throw new DecisionMakerSwitchWriteError("invalid_change");
  const actorUserId = input.session.user?.id;
  if (typeof actorUserId !== "string" || actorUserId.length === 0) {
    throw new DecisionMakerSwitchWriteError("no_operator");
  }

  await takeAuditChainLock(tx);
  const newest = await tx.$queryRaw<Array<{ actorKind: string; value: string }>>`
    SELECT "actorKind", "value"
    FROM "AmuxDecisionMakerSwitchEvent"
    WHERE "scope" = ${change.scope}
    ORDER BY "sequence" DESC
    LIMIT 1
  `;
  const previous = newest[0] ?? null;
  const action = dmOperatorSwitchAction(
    previous === null ? null : (previous.actorKind as DmSwitchActorKind),
  );
  const eventId = randomUUID();
  const auditLogId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action,
    targetType: DM_SWITCH_AUDIT_TARGET_TYPE,
    targetId: eventId,
    summary:
      action === "amux.decision.latch_release"
        ? "Released an AMUX Decision Maker latch."
        : "Changed an AMUX Decision Maker switch.",
    metadata: dmSwitchAuditMetadata({
      event_id: eventId,
      scope: change.scope,
      value: change.value,
      reason_code: "operator",
      previous_value: previous?.value ?? null,
    }),
    tx,
  });
  const inserted = await tx.$queryRaw<InsertedRow[]>`
    INSERT INTO "AmuxDecisionMakerSwitchEvent"
      ("id", "scope", "value", "reasonCode", "actorKind", "actorUserId", "auditLogId")
    VALUES
      (${eventId}, ${change.scope}, ${change.value}, 'operator', 'human', ${actorUserId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return { ...eventRecord(eventId, auditLogId, inserted), action };
}

/**
 * The system turns one instance `off` (§8: three consecutive validation
 * failures; §5: a request directory whose deletion could not be confirmed).
 * The latch is always written, even over an instance that is already `off`:
 * the operator then has to release it before the instance can propose again,
 * and a second cause is a second record. Whether a latch is due is the
 * caller's decision (lib/amux/decisionMakerRequestStore.ts): §8's count does
 * not latch an instance whose newest validation latch nobody has released
 * (since stage S2-2a4; before it, whose newest event of any kind was a
 * latch). The audit comes first, under the instance's own actor, then the
 * event naming it. The insert trigger records, as it does the clock, the
 * newest request ledger sequence the event was written after
 * (`ledgerSequence`, migration 20261017200000), which places a result before
 * or after a release without a clock.
 *
 * Since stage S2-2a3 a cleanup latch names the ledger event id of the
 * `cleanup_unknown` report it settles, and no other latch names one; the
 * database refuses a cleanup latch that names anything but a report of its
 * own instance, and a second latch naming the same report.
 *
 * Statements: the system writer's 3 (4 with an integrity key), 1 insert --
 * 4, or 5.
 */
export async function latchDecisionMakerInstanceOff(
  tx: Prisma.TransactionClient,
  input: { instance: unknown; reason: unknown; cleanupEventId?: unknown },
): Promise<DecisionMakerSwitchEventRecord> {
  const latch = parseDmSwitchLatch(input.instance, input.reason, input.cleanupEventId ?? null);
  if (!latch) throw new DecisionMakerSwitchWriteError("invalid_latch");

  const eventId = randomUUID();
  const auditLogId = await writeDecisionMakerLatchAudit(tx, {
    instance: latch.instance,
    eventId,
    metadata: dmSwitchAuditMetadata({
      event_id: eventId,
      scope: latch.instance,
      value: "off",
      reason_code: latch.reason,
    }),
  });
  const inserted = await tx.$queryRaw<InsertedRow[]>`
    INSERT INTO "AmuxDecisionMakerSwitchEvent"
      ("id", "scope", "value", "reasonCode", "actorKind", "actorUserId", "cleanupEventId", "auditLogId")
    VALUES
      (${eventId}, ${latch.instance}, 'off', ${latch.reason}, 'system', NULL, ${latch.cleanupEventId}, ${auditLogId})
    RETURNING
      "sequence",
      floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAtEpochMs"
  `;
  return eventRecord(eventId, auditLogId, inserted);
}
