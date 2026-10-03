/**
 * Support-triage data in an account's deletion (docs/policy/support-triage.md §5).
 *
 * Account deletion keeps the account's reports and anonymises them in place,
 * so no foreign-key cascade reaches the triage rows derived from them. This
 * module deletes those rows inside the account-deletion transaction, before
 * the reports are anonymised, and records how many it removed as the
 * transaction's last statement. Writing the audit entry last keeps the audit
 * chain's lock off the rest of a transaction this module does not own; an
 * account with nothing derived writes no entry.
 *
 * The models deleted here are the deletion manifest's entries that delete on
 * account deletion; a test fails if the two disagree.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";

export type SupportTriageDeletionCounts = {
  readonly suggestions: number;
};

/** Models this module deletes, by manifest name. */
export const SUPPORT_TRIAGE_ACCOUNT_DELETION_MODELS = Object.freeze(["SupportTriageSuggestion"] as const);

export const deleteSupportTriageDataForAccount = async (
  tx: Prisma.TransactionClient,
  userId: string
): Promise<SupportTriageDeletionCounts> => {
  // Reports first, in id order: the global lock order puts Feedback before
  // every triage table, and holding the reports keeps a worker from deriving
  // a new row from one between this delete and the anonymisation.
  const reports = await tx.$queryRaw<{ id: string }[]>`
    SELECT f."id" FROM "Feedback" f WHERE f."userId" = ${userId} ORDER BY f."id" FOR UPDATE`;
  if (reports.length === 0) return { suggestions: 0 };
  const suggestions = await tx.supportTriageSuggestion.deleteMany({
    where: { feedbackId: { in: reports.map((report) => report.id) } },
  });
  return { suggestions: suggestions.count };
};

/** The transaction's last statement: one content-free entry, or none. */
export const flushSupportTriageDeletionAudit = async (
  tx: Prisma.TransactionClient,
  counts: SupportTriageDeletionCounts
): Promise<void> => {
  if (counts.suggestions === 0) return;
  await writeSystemAuditLog({
    tx,
    systemActor: "support-triage-account-deletion",
    action: "support_triage.account_data_deleted",
    targetType: "SupportTriageSuggestion",
    targetId: null,
    summary: "Support-triage data deleted with an account",
    metadata: { suggestions: counts.suggestions },
  });
};
