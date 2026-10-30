/**
 * Support-triage data in an account's deletion (docs/policy/support-triage.md §5).
 *
 * Account deletion keeps the account's reports and anonymises them in place,
 * so no foreign-key cascade reaches the triage rows derived from them. This
 * module deletes those rows inside the account-deletion transaction, keyed on
 * exactly the reports that transaction anonymised, and records how many it removed as the
 * transaction's last statement. Writing the audit entry last keeps the audit
 * chain's lock off the rest of a transaction this module does not own; an
 * account with nothing derived writes no entry.
 *
 * The models deleted here are the deletion manifest's entries that delete on
 * account deletion; a test fails if the two disagree.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";

export type SupportTriageDeletionCounts = {
  readonly suggestions: number;
  readonly groups: number;
  readonly decisionRecords: number;
};

/** States that settle a report's input for the worker; shown rows in them are replaced. */
const SETTLED_STATES = new Set(["ready", "accepted", "rejected", "expired", "failed"]);

/** Models this module deletes, by manifest name. */
export const SUPPORT_TRIAGE_ACCOUNT_DELETION_MODELS = Object.freeze([
  "SupportTriageSuggestion",
  "SupportTriageGroup",
  "SupportTriageDecisionRecord",
] as const);

/**
 * Called right after the anonymising UPDATE, with the ids it returned.
 *
 * The set must be the one the anonymisation wrote, not a separate read by
 * userId: under READ COMMITTED a report committed between two statements is in
 * one set and not the other, and a report anonymised without its triage rows
 * deleted can never be found from the account again (docs/policy/support-triage.md §5).
 *
 * Why nothing escapes after the UPDATE: it holds a row lock on every report it
 * anonymised until commit. A suggestion insert takes FOR SHARE on its report in
 * the guard trigger, so it waits, then reads the deleted-account marker and is
 * refused. An insert that took FOR SHARE first makes the UPDATE wait for it, and
 * once it commits this DELETE (a later statement) sees it.
 */
export const deleteSupportTriageDataForAccount = async (
  tx: Prisma.TransactionClient,
  anonymisedReportIds: readonly string[]
): Promise<SupportTriageDeletionCounts> => {
  if (anonymisedReportIds.length === 0) return { suggestions: 0, groups: 0, decisionRecords: 0 };
  const ids = [...anonymisedReportIds];
  // The account's own suggestions.
  const own = await tx.supportTriageSuggestion.deleteMany({ where: { feedbackId: { in: ids } } });
  // Every other report's suggestion that showed one of the account's reports
  // to the model goes too: its draft may carry what that report said.
  const shown = await tx.$queryRaw<{ feedbackId: string; inputDigest: string; state: string }[]>`
    DELETE FROM "SupportTriageSuggestion" s
     WHERE s."contextFeedbackIds" && ${ids}::text[]
    RETURNING s."feedbackId", s."inputDigest", s."state"`;
  // That report's input stays settled, though: a content-free expired row of
  // the same input takes the place of a settled one, so the worker never pays
  // for that input again. It ages out like any expired row; by then the report
  // is past the worker's 30-day window (docs/policy/support-triage.md §5).
  const settled = [
    ...new Map(
      shown
        .filter((row) => SETTLED_STATES.has(row.state))
        .map((row) => [JSON.stringify([row.feedbackId, row.inputDigest]), row])
    ).values(),
  ];
  if (settled.length > 0) {
    const placed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest")
      SELECT c."id", c."feedbackId", c."inputDigest"
        FROM unnest(${settled.map(() => randomUUID())}::text[], ${settled.map((row) => row.feedbackId)}::text[],
                    ${settled.map((row) => row.inputDigest)}::text[]) AS c("id", "feedbackId", "inputDigest")
      ON CONFLICT ("feedbackId", "inputDigest") WHERE "state" IN ('pending', 'claimed', 'ready') DO NOTHING
      RETURNING "id"`;
    if (placed.length > 0) {
      await tx.$executeRaw`
        UPDATE "SupportTriageSuggestion" SET "state" = 'expired' WHERE "id" = ANY(${placed.map((row) => row.id)}::text[])`;
    }
  }
  const suggestions = { count: own.count + shown.length };
  // Every group the reports are in, or were in before it ended, whatever its
  // state and cooldown: no deleted report's id survives in a key, a list, a
  // membership or a signal (docs/policy/support-triage.md §5). Locked in id
  // order after the reports, the global order; members and signals cascade.
  const groups = await tx.$queryRaw<{ id: string }[]>`
    SELECT g."id" FROM "SupportTriageGroup" g
     WHERE EXISTS (SELECT 1 FROM "SupportTriageGroupMember" m
                    WHERE m."groupId" = g."id" AND m."feedbackId" = ANY(${ids}::text[]))
        OR g."retiredMemberIds" && ${ids}::text[]
     ORDER BY g."id" FOR UPDATE`;
  const deletedGroups =
    groups.length === 0
      ? { count: 0 }
      : await tx.supportTriageGroup.deleteMany({ where: { id: { in: groups.map((group) => group.id) } } });
  // A decision record goes whole when any report it was bound to is the
  // account's, other accounts' links included: no half record survives.
  const decisionRecords = await tx.supportTriageDecisionRecord.deleteMany({
    where: { links: { some: { feedbackId: { in: ids } } } },
  });
  return { suggestions: suggestions.count, groups: deletedGroups.count, decisionRecords: decisionRecords.count };
};

/** The transaction's last statement: one content-free entry, or none. */
export const flushSupportTriageDeletionAudit = async (
  tx: Prisma.TransactionClient,
  counts: SupportTriageDeletionCounts
): Promise<void> => {
  if (counts.suggestions === 0 && counts.groups === 0 && counts.decisionRecords === 0) return;
  await writeSystemAuditLog({
    tx,
    systemActor: "support-triage-account-deletion",
    action: "support_triage.account_data_deleted",
    // One entry for everything this module removed, of every model.
    targetType: "SupportTriageAccountData",
    targetId: null,
    summary: "Support-triage data deleted with an account",
    metadata: { suggestions: counts.suggestions, groups: counts.groups, decisionRecords: counts.decisionRecords },
  });
};
