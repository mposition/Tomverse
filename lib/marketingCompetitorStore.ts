/**
 * The competitor registry's one writer (S3 plan, S3f; operator decision
 * 2026-10-17). `npm run check:protected-table-writers` refuses a write to
 * `MarketingCompetitor` anywhere else.
 *
 * Two kinds of writer, and the database tells them apart:
 * - the generator proposes (A3's candidates), under the `marketing-generator`
 *   system actor -- a proposal is stored, shown to a person and trusted for
 *   nothing;
 * - a person decides (approve, reject, retire, or add one already approved),
 *   inside `runMarketingAdminMutation`, whose human audit row the update
 *   trigger checks: the action, the row, the previous decision it was made
 *   against and, for an approval, the exact hosts approved.
 *
 * Only approved rows' hosts are read as sources (`readApprovedMarketingCompetitorHosts`).
 */

import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_COMPETITOR_ACTIONS,
  type MarketingCompetitorCandidate,
  type MarketingCompetitorSourceHosts,
} from "@/lib/marketingCompetitorCore";
import { MarketingStoreRefusedError, type MarketingTransaction } from "@/lib/marketingStore";

type CompetitorReader = Pick<MarketingTransaction, "marketingCompetitor">;

/** Approved competitor id -> official hosts, as the fact filter uses them. */
export async function readApprovedMarketingCompetitorHosts(
  db: CompetitorReader,
): Promise<MarketingCompetitorSourceHosts> {
  const rows = await db.marketingCompetitor.findMany({
    where: { status: "approved" },
    orderBy: { id: "asc" },
    select: { id: true, officialHosts: true },
  });
  return Object.freeze(Object.fromEntries(rows.map((row) => [row.id, Object.freeze([...row.officialHosts])])));
}

/** The approved competitors as the generator may see them: who to track, and where. */
export async function readMarketingCompetitorsForGenerator(
  db: CompetitorReader,
): Promise<Array<{ readonly competitorId: string; readonly displayName: string; readonly officialHosts: readonly string[] }>> {
  const rows = await db.marketingCompetitor.findMany({
    where: { status: "approved" },
    orderBy: { id: "asc" },
    select: { id: true, displayName: true, officialHosts: true },
  });
  return rows.map((row) => ({ competitorId: row.id, displayName: row.displayName, officialHosts: [...row.officialHosts] }));
}

/**
 * Store A3's candidates as proposals. A competitor id the registry already has
 * -- proposed, approved, rejected or retired -- is left as it is: A3 cannot
 * reopen a person's rejection or rename an approved competitor by proposing
 * it again. Each new proposal gets a `marketing-generator` audit row in this
 * transaction. The caller holds the audit chain lock or this takes it.
 */
export async function proposeMarketingCompetitors(
  tx: MarketingTransaction,
  input: { readonly generatorRunId: string; readonly candidates: readonly MarketingCompetitorCandidate[] },
): Promise<{ readonly proposed: readonly string[]; readonly alreadyKnown: readonly string[] }> {
  await takeAuditChainLock(tx);
  const proposed: string[] = [];
  const alreadyKnown: string[] = [];
  for (const candidate of input.candidates) {
    const existing = await tx.marketingCompetitor.findUnique({
      where: { id: candidate.competitorId },
      select: { id: true },
    });
    if (existing) {
      alreadyKnown.push(candidate.competitorId);
      continue;
    }
    await tx.marketingCompetitor.create({
      data: {
        id: candidate.competitorId,
        displayName: candidate.displayName,
        officialHosts: [...candidate.officialHosts],
        status: "proposed",
        proposedBy: "generator",
        proposedRunId: input.generatorRunId,
        evidenceUrls: [...candidate.evidenceUrls],
        rationale: candidate.rationale,
      },
    });
    await writeSystemAuditLog({
      tx,
      systemActor: "marketing-generator",
      action: MARKETING_COMPETITOR_ACTIONS.proposed,
      targetType: "MarketingCompetitor",
      targetId: candidate.competitorId,
      summary: "The market-intelligence agent proposed a competitor to track.",
      metadata: { generatorRunId: input.generatorRunId, officialHosts: [...candidate.officialHosts] },
    });
    proposed.push(candidate.competitorId);
  }
  return { proposed, alreadyKnown };
}

/**
 * A person's decision about a competitor, recorded by the audit row the
 * mutation wrapper has just written (`auditLogId`). The row moves only if its
 * current decision is the one the person saw (`expectedDecisionAuditLogId`),
 * so a decision made against a stale screen is refused rather than applied.
 */
export async function decideMarketingCompetitor(
  tx: MarketingTransaction,
  input: {
    readonly competitorId: string;
    readonly decision: "approved" | "rejected" | "retired";
    readonly expectedDecisionAuditLogId: string | null;
    readonly auditLogId: string;
    /** For an approval: the name and hosts the person approved, as their audit row records them. */
    readonly displayName?: string;
    readonly officialHosts?: readonly string[];
  },
): Promise<{ readonly competitorId: string; readonly status: string }> {
  if (input.decision === "approved" && (!input.officialHosts || !input.displayName)) {
    throw new MarketingStoreRefusedError("competitor_hosts_required", "An approval names the name and hosts it approves");
  }
  const updated = await tx.marketingCompetitor.updateMany({
    where: { id: input.competitorId, decisionAuditLogId: input.expectedDecisionAuditLogId },
    data: {
      status: input.decision,
      decisionAuditLogId: input.auditLogId,
      ...(input.decision === "approved"
        ? { displayName: input.displayName, officialHosts: [...(input.officialHosts ?? [])] }
        : {}),
    },
  });
  if (updated.count !== 1) {
    throw new MarketingStoreRefusedError(
      "competitor_decision_conflict",
      "The competitor changed, or does not exist, since it was shown",
    );
  }
  return { competitorId: input.competitorId, status: input.decision };
}

/** A person adds a competitor A3 did not propose, approved as it is created. */
export async function createApprovedMarketingCompetitor(
  tx: MarketingTransaction,
  input: {
    readonly competitorId: string;
    readonly displayName: string;
    readonly officialHosts: readonly string[];
    readonly auditLogId: string;
  },
): Promise<{ readonly competitorId: string }> {
  const existing = await tx.marketingCompetitor.findUnique({ where: { id: input.competitorId }, select: { id: true } });
  if (existing) {
    throw new MarketingStoreRefusedError("competitor_exists", "That competitor is already in the registry");
  }
  await tx.marketingCompetitor.create({
    data: {
      id: input.competitorId,
      displayName: input.displayName,
      officialHosts: [...input.officialHosts],
      status: "approved",
      proposedBy: "operator",
      evidenceUrls: [],
      decisionAuditLogId: input.auditLogId,
    },
  });
  return { competitorId: input.competitorId };
}
